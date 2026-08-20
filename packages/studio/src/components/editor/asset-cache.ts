import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AssetPartData, Project } from '@lumora/core';

/**
 * GLB/GLTF 内容缓存：按内容哈希索引。
 * 引用关系不在此处维护——以 Project 全量 model→asset 关系为准（sweep 时重建），
 * 覆盖复制（Ctrl+D）、撤销/重做、外部改名等一切对象变更路径；
 * 项目不再引用且内容已就绪的条目释放 object URL 与 GPU 资源（几何/材质）。
 *
 * 生命周期（hydrate → close / import → unmount 无泄漏）：
 * - 消费者（导入流程）await 解析期间条目记 pendingRelease 而非立即释放；
 *   解析 settle 后按 pendingRelease/disposed 立即完成清理 —— 不依赖后续 sweep。
 * - dispose() 使缓存整体失效：在途解析 settle 后同样立即清理；
 *   dispose 后的 acquire/seed 直接抛错（配合 runtime dispose 的会话失效，
 *   卸载后不得有晚到写入）。
 *
 * 多文件 .gltf：外部 .bin/纹理作为相对 URI 引用，经 parts 映射为 blob URL
 * （重写 gltf JSON 的 buffers[].uri / images[].uri），随项目以 base64 持久化，
 * 重开项目时按同一规则重建。
 */
interface CacheEntry {
  hash: string;
  url: string;
  partUrls: string[];
  gltf: GLTF | null;
  promise: Promise<GLTF>;
  /** 已标记释放但仍有消费者等待解析 → settle 后立即清理 */
  pendingRelease: boolean;
}

export interface CachedModel {
  hash: string;
  url: string;
  gltf: GLTF | null;
}

/** 多文件 .gltf 的外部依赖文件（路径 + 字节） */
export interface CachePartFile {
  /** gltf JSON 内引用的相对 URI（选择目录时取相对路径，否则文件名） */
  path: string;
  mime: string;
  bytes: ArrayBuffer;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.dispose();
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            (value as THREE.Texture).dispose();
          }
        }
      }
    }
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * .gltf JSON 中引用的外部文件相对 URI（不含 data: 内联）：
 * buffers[].uri 与 images[].uri。供导入流程在触碰缓存前校验依赖齐全。
 */
export function collectGltfUris(mainBytes: ArrayBuffer): string[] {
  const text = new TextDecoder().decode(mainBytes);
  const json = JSON.parse(text) as { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] };
  const uris = new Set<string>();
  for (const buffer of json.buffers ?? []) {
    if (typeof buffer.uri === 'string' && !buffer.uri.startsWith('data:')) uris.add(buffer.uri);
  }
  for (const image of json.images ?? []) {
    if (typeof image.uri === 'string' && !image.uri.startsWith('data:')) uris.add(image.uri);
  }
  return [...uris];
}

/**
 * 构建可加载的 blob URL：
 * - GLB：主文件字节直接成 blob；
 * - .gltf：外部依赖 URI 重写为 blob URL（缺失依赖抛错），主文件为重写后的 JSON。
 * 返回的主 URL 与全部依赖 URL 都需在释放时 revoke。
 */
function buildLoadableUrl(
  mainBytes: ArrayBuffer,
  mime: string,
  parts: CachePartFile[],
): { url: string; partUrls: string[] } {
  if (!mime.includes('gltf+json')) {
    return {
      url: URL.createObjectURL(new Blob([mainBytes], { type: 'model/gltf-binary' })),
      partUrls: [],
    };
  }
  const text = new TextDecoder().decode(mainBytes);
  const json = JSON.parse(text) as {
    buffers?: { uri?: unknown }[];
    images?: { uri?: unknown }[];
  };
  const uris = collectGltfUris(mainBytes);
  if (uris.length === 0) {
    return { url: URL.createObjectURL(new Blob([mainBytes], { type: mime })), partUrls: [] };
  }
  const byPath = new Map(parts.map((p) => [p.path, p]));
  const byBase = new Map(parts.map((p) => [basename(p.path), p]));
  const partUrls: string[] = [];
  const uriToUrl = new Map<string, string>();
  for (const uri of uris) {
    const part = byPath.get(uri) ?? byBase.get(basename(uri));
    if (!part) throw new Error(`缺少依赖文件：${uri}`);
    const url = URL.createObjectURL(new Blob([part.bytes], { type: part.mime }));
    partUrls.push(url);
    uriToUrl.set(uri, url);
  }
  const rewrite = (list: { uri?: unknown }[] | undefined): { uri?: unknown }[] | undefined =>
    list?.map((item) =>
      typeof item.uri === 'string' && uriToUrl.has(item.uri)
        ? { ...item, uri: uriToUrl.get(item.uri) }
        : item,
    );
  const rewritten = { ...json, buffers: rewrite(json.buffers), images: rewrite(json.images) };
  return {
    url: URL.createObjectURL(new Blob([JSON.stringify(rewritten)], { type: mime })),
    partUrls,
  };
}

export class AssetCache {
  private entries = new Map<string, CacheEntry>();
  private readyListeners = new Map<string, Set<(gltf: GLTF) => void>>();
  /** 正在等待解析结果的消费者计数：并发导入复用同一条目时，不得释放仍被等待的内容 */
  private waiters = new Map<string, number>();
  /** 缓存整体已释放（runtime 卸载）：在途解析 settle 后立即清理，新获取直接失败 */
  private disposed = false;

  get(hash: string): CachedModel | null {
    const entry = this.entries.get(hash);
    return entry ? { hash: entry.hash, url: entry.url, gltf: entry.gltf } : null;
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  urlFor(hash: string): string {
    return this.entries.get(hash)?.url ?? '';
  }

  /**
   * 获取（或首次加载）模型内容；解析失败时回滚缓存并抛出错误。
   * parts 仅对 .gltf 生效：外部 .bin/纹理按相对 URI 映射为 blob URL。
   */
  acquire(hash: string, bytes: ArrayBuffer, mime: string, parts: CachePartFile[] = []): Promise<GLTF> {
    if (this.disposed) return Promise.reject(new Error('缓存已释放'));
    const existing = this.entries.get(hash);
    const promise = existing ? existing.promise : this.createEntry(hash, buildLoadableUrl(bytes, mime, parts));
    this.trackWaiter(hash, promise);
    return promise;
  }

  /** 从持久化字节重建内容（项目重开/重做后缓存已释放的场景） */
  seed(hash: string, payload: string, mime: string, parts: AssetPartData[] = []): Promise<GLTF> {
    if (this.disposed) return Promise.reject(new Error('缓存已释放'));
    const existing = this.entries.get(hash);
    const promise = existing
      ? existing.promise
      : this.createEntry(
          hash,
          buildLoadableUrl(
            fromBase64(payload),
            mime,
            parts.map((p) => ({ path: p.path, mime: p.mime, bytes: fromBase64(p.payload) })),
          ),
        );
    this.trackWaiter(hash, promise);
    return promise;
  }

  private trackWaiter(hash: string, promise: Promise<GLTF>): void {
    this.waiters.set(hash, (this.waiters.get(hash) ?? 0) + 1);
    const decrement = (): void => {
      const next = (this.waiters.get(hash) ?? 1) - 1;
      if (next <= 0) this.waiters.delete(hash);
      else this.waiters.set(hash, next);
      // settle 后若条目已标记释放或缓存已整体释放 → 立即完成清理（不等后续 sweep）
      if (next <= 0) {
        const entry = this.entries.get(hash);
        if (entry && (entry.pendingRelease || this.disposed)) this.releaseNow(hash);
      }
    };
    promise.then(decrement, decrement);
  }

  private createEntry(hash: string, bundle: { url: string; partUrls: string[] }): Promise<GLTF> {
    const loader = new GLTFLoader();
    const promise = loader.loadAsync(bundle.url).then((gltf) => {
      const entry = this.entries.get(hash);
      if (entry) entry.gltf = gltf;
      this.fireReady(hash, gltf);
      return gltf;
    });
    this.entries.set(hash, { hash, url: bundle.url, partUrls: bundle.partUrls, gltf: null, promise, pendingRelease: false });
    promise.catch(() => {
      const entry = this.entries.get(hash);
      if (entry && entry.promise === promise) {
        this.entries.delete(hash);
        this.readyListeners.delete(hash);
        URL.revokeObjectURL(bundle.url);
        for (const partUrl of bundle.partUrls) URL.revokeObjectURL(partUrl);
      }
    });
    return promise;
  }

  /**
   * 项目变更后清理：引用集从 Project 全量 model→asset 关系重建，
   * 与 UI 路径（复制/删除/撤销/重做/改名）无关。
   * project 为 null（关闭/切换项目）时释放全部内容；
   * 解析中的条目（gltf 未就绪）标记 pendingRelease —— 可能是进行中的导入，
   * 解析完成后（settle 回调）立即释放，不依赖后续 sweep。
   */
  sweep(project: Project | null): void {
    if (this.disposed) return;
    const referencedHashes = new Set<string>();
    if (project) {
      for (const object of project.objects) {
        if (!object.assetId) continue;
        const asset = project.assets.find((a) => a.id === object.assetId);
        if (asset) referencedHashes.add(asset.hash);
      }
    }
    for (const [hash, entry] of [...this.entries]) {
      const keepLoading = project !== null && !entry.gltf;
      if (!referencedHashes.has(hash) && !keepLoading) this.release(hash);
    }
  }

  /** 主动丢弃条目（导入会话切换的取消路径） */
  discard(hash: string): void {
    this.release(hash);
  }

  private release(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) return;
    // 仍有消费者等待解析结果（旧会话取消导入时新会话可能已复用同一条目）→
    // 标记 pendingRelease，settle 后由 trackWaiter 立即完成清理
    if ((this.waiters.get(hash) ?? 0) > 0) {
      entry.pendingRelease = true;
      return;
    }
    this.releaseNow(hash);
  }

  private releaseNow(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) return;
    this.entries.delete(hash);
    this.readyListeners.delete(hash);
    URL.revokeObjectURL(entry.url);
    for (const partUrl of entry.partUrls) URL.revokeObjectURL(partUrl);
    if (entry.gltf) disposeObject(entry.gltf.scene);
  }

  /** 内容就绪回调；已就绪立即触发。返回取消函数 */
  onContentReady(hash: string, listener: (gltf: GLTF) => void): () => void {
    const entry = this.entries.get(hash);
    if (entry?.gltf) {
      listener(entry.gltf);
      return () => undefined;
    }
    let set = this.readyListeners.get(hash);
    if (!set) {
      set = new Set();
      this.readyListeners.set(hash, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** 整体释放：标记 disposed，立即清理全部条目（含解析中）；settle 后自动收尾 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const hash of [...this.entries.keys()]) this.releaseNow(hash);
  }

  private fireReady(hash: string, gltf: GLTF): void {
    const listeners = this.readyListeners.get(hash);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(gltf);
    this.readyListeners.delete(hash);
  }
}

/** base64 → 字节 */
function fromBase64(payload: string): ArrayBuffer {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

/**
 * 从项目资产的 base64 载荷重建内容缓存（项目重开/撤销后重做时调用）：
 * 同步启动缺失条目的解析（已存在的条目不受影响），返回各条目解析 promise。
 * .gltf 资产带 parts（外部 .bin/纹理）时按同一规则重建依赖映射。
 */
export function ensureCacheSeeded(cache: AssetCache, project: Project): Promise<GLTF>[] {
  const seeds: Promise<GLTF>[] = [];
  for (const asset of project.assets) {
    if (!asset.payload || cache.has(asset.hash)) continue;
    seeds.push(cache.seed(asset.hash, asset.payload, asset.mime, asset.parts ?? []));
  }
  return seeds;
}

/** 等待 ensureCacheSeeded 启动的全部解析完成 */
export async function hydrateCache(cache: AssetCache, project: Project): Promise<void> {
  await Promise.all(ensureCacheSeeded(cache, project));
}
