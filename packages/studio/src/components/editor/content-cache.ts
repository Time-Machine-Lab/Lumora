import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AssetPartData, Project } from '@lumora/core';

/**
 * GLB/GLTF 内容缓存（P1 重构）：每消费者 lease + 明确 entry 状态机。
 *
 * 双权分离：
 * - 引用关系（Project 全量 model→asset）决定 entry 何时合法存活（sweep 判定）；
 * - lease token 所有权决定异步期间谁能安全处置它（只有持有者能 release）。
 *
 * entry 状态：
 *   loading(0..k leases) --settle--> ready(k) --末 lease release--> GONE(teardown)
 *   loading/ready --sweep(无引用)/dispose/discard--> condemned
 *   condemned(loading) --settle--> GONE(teardown)   ← settle 是 condemned 下唯一 owner
 *
 * teardown() 是唯一清理点（revoke URL + 释放 GPU），幂等，只由三个出口调用：
 * 1) settle 发现 condemned 且无 lease；2) release 后 condemned 且无 lease 且已就绪；
 * 3) dispose 对已就绪条目立即执行。
 *
 * 硬约束（已批准设计，TML-57 第四轮）：
 * 1. dispose 不依赖消费者配合：原子撤销并清空全部 lease token，消费者后续
 *    release() 为幂等 no-op；loader settle 独立完成 condemned entry 的唯一 teardown。
 * 2. 禁止裸资源旁路：查询 API 只返回元数据（has/isReady），不提供返回 GLTF 的
 *    get()/urlFor()，也不提供无所有权的 onContentReady()；渲染/导入消费者必须
 *    在使用期持有 acquire/seed/retain 返回的 lease。
 * 3. 同 hash generation 隔离：每 entry 持有自增 generation；settle/reject 只删除
 *    自身 identity（entries.get(hash) === entry 校验），绝不误删同 hash 的新条目；
 *    reject 路径撤销自身全部 URL、移出 map，失败经共享 promise 传播给所有 lease。
 * 4. （EditorState 边界见核心层 P2）
 */

export type CacheFormat = 'gltf' | 'glb';

/** 多文件 .gltf 的外部依赖文件（路径 + 字节） */
export interface CachePartFile {
  /** gltf JSON 内引用的相对 URI（选择目录时取相对路径，否则文件名） */
  path: string;
  mime: string;
  bytes: ArrayBuffer;
}

/** 元数据查询结果：不含任何 GLTF/GPU 引用（禁止裸资源旁路） */
export interface CachedModelInfo {
  hash: string;
  ready: boolean;
}

/**
 * 格式决议：显式格式 > 扩展名（.gltf/.glb）> mime。
 * 浏览器对 .gltf 常报 application/json / application/octet-stream，
 * 一律以扩展名为准，不得信任 File.type 单独决定 GLTF/GLB 分支。
 */
export function resolveFormat(name: string, mime: string, explicit?: CacheFormat): CacheFormat {
  if (explicit === 'gltf' || explicit === 'glb') return explicit;
  if (/\.gltf$/i.test(name)) return 'gltf';
  if (/\.glb$/i.test(name)) return 'glb';
  if (mime.includes('gltf+json')) return 'gltf';
  if (mime.includes('gltf-binary')) return 'glb';
  return 'glb';
}

/** 资源内容使用权：使用期持有，结束显式 release()（幂等，dispose 后为 no-op） */
export interface CacheLease {
  readonly hash: string;
  /** entry 世代标识：旧 lease 不得作用于同 hash 的新 generation */
  readonly generation: number;
  /** 解析结果（与同一 entry 的全部 lease 共享同一 promise，失败同一错误传播） */
  readonly content: Promise<GLTF>;
  /** 已释放/被撤销（异步回调在触碰资源前必须先校验，防止卸载后晚到挂载） */
  readonly isReleased: boolean;
  release(): void;
}

interface Entry {
  hash: string;
  generation: number;
  url: string;
  partUrls: string[];
  gltf: GLTF | null;
  promise: Promise<GLTF>;
  leases: Set<LeaseImpl>;
  /** 判死刑：不得再被 acquire/retain/seed 复用；清理延至 settle/末 lease */
  condemned: boolean;
  /** 已清理（幂等守卫） */
  torn: boolean;
}

/** LeaseImpl 模块级 brand（R6，TML-57 第六轮）：release/discard 只认本模块签发的
 *  真实 lease 实例，调用方伪造的 {hash, generation, release} 对象一律忽略。 */
const issuedLeases = new WeakSet<LeaseImpl>();

class LeaseImpl implements CacheLease {
  readonly hash: string;
  readonly generation: number;
  readonly content: Promise<GLTF>;
  /** 所属 entry 反向引用：释放路径直接操作自身条目，不按 hash 查找 ——
   * 同 hash 新 generation 取代旧条目后，旧 lease 的释放仍然从自己所在条目移除，
   * 绝不因 generation 错配早退而把 stale 成员永久滞留在旧条目的 leases 里。
   * LeaseImpl 为模块私有，ContentCache 通过该引用读写自身条目。 */
  readonly entry: Entry;
  private released = false;

  /** 签发实例（R8-11）：discard/release 只接受本实例签发的 lease，异实例一律忽略 */
  readonly owner: ContentCache;

  constructor(owner: ContentCache, entry: Entry, content: Promise<GLTF>) {
    this.owner = owner;
    this.entry = entry;
    this.hash = entry.hash;
    this.generation = entry.generation;
    this.content = content;
    issuedLeases.add(this);
  }

  release(): void {
    this.owner.releaseLease(this);
  }

  /** dispose() 原子撤销：之后 release() 为幂等 no-op */
  revoke(): void {
    this.released = true;
  }

  get isReleased(): boolean {
    return this.released;
  }
}

type LoaderFactory = (url: string) => Promise<GLTF>;

function defaultLoader(url: string): Promise<GLTF> {
  return new GLTFLoader().loadAsync(url);
}

/** 材质引用的全部纹理：对象值（map/normalMap/roughnessMap…）+
 *  ShaderMaterial uniforms 的纹理值与纹理数组（R6，TML-57 第六轮）。 */
function collectMaterialTextures(material: THREE.Material): THREE.Texture[] {
  const textures: THREE.Texture[] = [];
  for (const value of Object.values(material)) {
    if (value && typeof value === 'object' && 'isTexture' in value) {
      textures.push(value as THREE.Texture);
    }
  }
  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  if (uniforms && typeof uniforms === 'object') {
    for (const uniform of Object.values(uniforms) as { value?: unknown }[]) {
      const value = uniform?.value;
      if (value && typeof value === 'object' && 'isTexture' in value) {
        textures.push(value as THREE.Texture);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && 'isTexture' in item) {
            textures.push(item as THREE.Texture);
          }
        }
      }
    }
  }
  return textures;
}

/**
 * 按能力统一释放（整 GLTF）：Mesh/Points/Line/SkinnedMesh 均带 geometry + material，
 * 材质对象值与 ShaderMaterial uniforms 中的纹理一并释放；SkinnedMesh 的
 * Skeleton.boneTexture（DataTexture）单独释放。
 * 以全局 identity Set 遍历完整资源图：GLTF 内同一 geometry/material/texture 可能被
 * 多个节点乃至多个场景（gltf.scene 与 gltf.scenes，R6 补全）共享（DAG），
 * 每个 GPU 资源 exactly-once。
 */
function disposeGltf(gltf: GLTF): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();
  const visited = new Set<THREE.Object3D>();
  const visit = (root: THREE.Object3D) => {
    root.traverse((child) => {
      if (visited.has(child)) return; // 多场景共享同一节点：只访问一次
      visited.add(child);
      const renderable = child as THREE.Mesh & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      if (renderable.geometry && !disposedGeometries.has(renderable.geometry)) {
        disposedGeometries.add(renderable.geometry);
        renderable.geometry.dispose();
      }
      if (renderable.material) {
        const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
        for (const material of materials) {
          if (disposedMaterials.has(material)) continue;
          disposedMaterials.add(material);
          material.dispose();
          for (const texture of collectMaterialTextures(material)) {
            if (!disposedTextures.has(texture)) {
              disposedTextures.add(texture);
              texture.dispose();
            }
          }
        }
      }
      const skeleton = (child as { skeleton?: THREE.Skeleton }).skeleton;
      if (skeleton?.boneTexture && !disposedTextures.has(skeleton.boneTexture)) {
        disposedTextures.add(skeleton.boneTexture);
        skeleton.boneTexture.dispose();
      }
    });
  };
  for (const scene of gltf.scenes ?? []) visit(scene);
  if (gltf.scene && !visited.has(gltf.scene)) visit(gltf.scene);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * URI 侧规范化（R8-10，TML-57 第八轮）：先剥离 query/fragment，再按路径段逐个
 * percent-decode（解码后的 %2F 留在本段内、不充当分隔符），最后归并 dot-segment
 * （. / ..）。GLTF 相对 URI 是编码形态，与解码形态的依赖文件实体路径分属两侧，
 * 不能共用同一规范化——统一 decode 会让实体文件名中的字面 % 序列假命中（R8-10）。
 */
function normalizeUri(raw: string): string {
  const queryIndex = raw.search(/[?#]/);
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const segments = path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // 孤立 % 等非法编码序列：按字面段处理
    }
    if (decoded === '.' || decoded === '') continue;
    if (decoded === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(decoded);
  }
  return out.join('/');
}

/**
 * 实体路径侧规范化（R8-10）：只归并 dot-segment，不做任何 percent-decode——
 * 文件名是解码后的现实，字面 % 序列必须按字面保留，不得与编码 URI 假命中。
 */
function normalizeEntityPath(path: string): string {
  const segments = path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * GLTF URI → 依赖文件 的规范解析（模型导入预检与缓存 URL 构建共用同一规则，
 * 保证「预检通过 ⇔ 可加载」，消除两处逻辑分叉）：
 * 精确相对路径优先（URI 侧 normalizeUri、实体侧 normalizeEntityPath，分别规范化）；
 * basename 仅当唯一时才兜底；0 个命中 = 缺失、>1 个命中 = 歧义，两者都必须失败
 * （歧义不得静默取其一）。
 */
export type PartResolution<T extends { path: string }> =
  | { kind: 'exact'; part: T }
  | { kind: 'unique-basename'; part: T }
  | { kind: 'missing'; uri: string }
  | { kind: 'ambiguous'; uri: string };

export function resolvePartPath<T extends { path: string }>(
  uri: string,
  parts: readonly T[],
): PartResolution<T> {
  const norm = normalizeUri(uri);
  const exact = parts.find((p) => normalizeEntityPath(p.path) === norm);
  if (exact) return { kind: 'exact', part: exact };
  const base = basename(norm);
  const candidates = parts.filter((p) => basename(normalizeEntityPath(p.path)) === base);
  if (candidates.length === 1) return { kind: 'unique-basename', part: candidates[0]! };
  return { kind: candidates.length === 0 ? 'missing' : 'ambiguous', uri };
}

/**
 * .gltf JSON 中引用的外部文件相对 URI（不含 data: 内联）：
 * buffers[].uri 与 images[].uri。供导入流程在触碰缓存前校验依赖齐全。
 * 注意：JSON.parse 可能抛错，调用方必须将其封装为 Result（统一错误契约）。
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
 * - .gltf：外部依赖 URI 按规范解析（resolvePartPath）重写为 blob URL，主文件为重写后的 JSON。
 * 部分创建失败（缺失/歧义/其他抛错）时完整回滚已创建的全部 URL（含主 URL）后重抛，
 * 绝不泄漏半成品 URL。返回的主 URL 与全部依赖 URL 都需在释放时 revoke。
 */
function buildLoadableUrl(
  mainBytes: ArrayBuffer,
  format: CacheFormat,
  parts: CachePartFile[],
): { url: string; partUrls: string[] } {
  if (format === 'glb') {
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
    return { url: URL.createObjectURL(new Blob([mainBytes], { type: 'model/gltf+json' })), partUrls: [] };
  }
  const created: string[] = [];
  const partUrls: string[] = [];
  try {
    const uriToUrl = new Map<string, string>();
    for (const uri of uris) {
      const resolution = resolvePartPath(uri, parts);
      if (resolution.kind === 'missing') throw new Error(`缺少依赖文件：${uri}`);
      if (resolution.kind === 'ambiguous') throw new Error(`依赖文件歧义：${uri}`);
      const url = URL.createObjectURL(new Blob([resolution.part.bytes], { type: resolution.part.mime }));
      created.push(url);
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
    const url = URL.createObjectURL(new Blob([JSON.stringify(rewritten)], { type: 'model/gltf+json' }));
    created.push(url);
    return { url, partUrls };
  } catch (error) {
    for (const url of created) URL.revokeObjectURL(url);
    throw error;
  }
}

export class ContentCache {
  private entries = new Map<string, Entry>();
  private disposed = false;
  private generationCounter = 0;
  private readonly loader: LoaderFactory;

  constructor(opts: { loader?: LoaderFactory } = {}) {
    this.loader = opts.loader ?? defaultLoader;
  }

  /** 获取（或首次加载）模型内容；返回 lease，使用期持有，结束/失败路径显式 release */
  acquire(
    hash: string,
    bytes: ArrayBuffer,
    opts: { format: CacheFormat; parts?: CachePartFile[] },
  ): CacheLease {
    this.assertAlive();
    const existing = this.entries.get(hash);
    if (existing && !existing.condemned && !existing.torn) return this.addLease(existing);
    return this.addLease(this.createEntry(hash, buildLoadableUrl(bytes, opts.format, opts.parts ?? [])));
  }

  /** 从持久化字节重建内容（项目重开/撤销后重做缓存缺失的场景） */
  seed(hash: string, payload: string, opts: { format: CacheFormat; parts?: AssetPartData[] }): CacheLease {
    this.assertAlive();
    const existing = this.entries.get(hash);
    if (existing && !existing.condemned && !existing.torn) return this.addLease(existing);
    return this.addLease(
      this.createEntry(
        hash,
        buildLoadableUrl(
          fromBase64(payload),
          opts.format,
          (opts.parts ?? []).map((p) => ({ path: p.path, mime: p.mime, bytes: fromBase64(p.payload) })),
        ),
      ),
    );
  }

  /**
   * 显式 retain：对已存在的条目签发新 lease（渲染消费者在 content 未随
   * 项目引用存活时续租）。条目不存在/已判死刑 → null（不自动创建）。
   */
  retain(hash: string): CacheLease | null {
    if (this.disposed) return null;
    const entry = this.entries.get(hash);
    if (!entry || entry.condemned || entry.torn) return null;
    return this.addLease(entry);
  }

  /** 元数据查询（禁止裸资源旁路：不返回 GLTF/GPU 对象） */
  has(hash: string): boolean {
    const entry = this.entries.get(hash);
    return !!entry && !entry.torn;
  }

  /** 元数据查询：内容是否已就绪 */
  isReady(hash: string): boolean {
    const entry = this.entries.get(hash);
    return !!entry && !entry.torn && !!entry.gltf;
  }

  getInfo(hash: string): CachedModelInfo | null {
    const entry = this.entries.get(hash);
    return entry && !entry.torn ? { hash: entry.hash, ready: !!entry.gltf } : null;
  }

  /**
   * 主动放弃 + 判死刑：导入取消路径。条目无其他 lease 时立即清理；
   * loader 在途则延至 settle（condemned 的唯一 owner 收尾）。
   * 其他 lease 仍在使用时不得判死刑（同 hash 新会话正持租用），只释放自身。
   * 只认真实 lease 且必须是本实例签发的（R8-11）：伪造对象与异实例 lease 一律
   * 忽略——module 级 brand 与 entry membership 都跨实例成立，不校验 owner 则
   * cacheB.discard(cacheA 的 lease) 会把 A 的条目判死刑（跨实例判死）。
   */
  discard(lease: CacheLease): void {
    if (!(lease instanceof LeaseImpl) || !issuedLeases.has(lease)) return; // 伪造 lease：忽略
    if (lease.owner !== this) return; // 异实例 lease：忽略（R8-11）
    const impl = lease as LeaseImpl;
    if (impl.entry.leases.has(impl)) {
      // 本 lease 是唯一持有者 → 判死刑；还有其他持有者 → 只释放自身
      if (!impl.entry.condemned && impl.entry.leases.size === 1) impl.entry.condemned = true;
    }
    impl.release();
  }

  /**
   * 项目变更后清理：引用集从 Project 全量 model→asset 关系重建，与 UI 路径无关。
   * project 为 null（关闭项目）时释放全部内容；使用中（有 lease）的条目不判死刑；
   * 无引用的 loading 条目判死刑，settle 即清理（不再常驻）。
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
      if (entry.torn || entry.leases.size > 0 || referencedHashes.has(hash)) continue;
      entry.condemned = true;
      if (entry.gltf) this.teardown(entry);
      // loading：settle 处理器完成唯一 teardown
    }
  }

  /**
   * 整体释放（终态）：原子撤销并清空全部 lease token——不依赖消费者配合
   * （卸载后的 consumer 可能不执行 finally）。已就绪条目立即 teardown；
   * loader 在途条目保留到 settle，由 settle 处理器独立完成唯一 teardown。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      entry.condemned = true;
      for (const lease of [...entry.leases]) lease.revoke();
      entry.leases.clear();
      if (entry.gltf) this.teardown(entry);
    }
  }

  // ---------- 内部 ----------

  private assertAlive(): void {
    if (this.disposed) throw new Error('缓存已释放');
  }

  private addLease(entry: Entry): CacheLease {
    const lease = new LeaseImpl(this, entry, entry.promise);
    entry.leases.add(lease);
    return lease;
  }

  /** LeaseImpl.release() 的内部入口（类内私有，模块内唯一调用方） */
  releaseLease(lease: LeaseImpl): void {
    if (!(lease instanceof LeaseImpl) || !issuedLeases.has(lease)) return; // 伪造 lease：忽略
    if (lease.owner !== this) return; // 异实例 lease：忽略（R8-11）
    if (lease.isReleased) return; // dispose 后幂等 no-op
    lease.revoke();
    // 从自身 entry 移除（R6，TML-57 第六轮）：不按 hash 查找、无 generation 早退 ——
    // 同 hash 新 generation 取代旧条目后，旧 lease 仍从旧条目里删除自己，
    // stale 成员不会永久滞留，condemned 的旧条目才能被 sweep/settle 收尾
    const entry = lease.entry;
    entry.leases.delete(lease);
    // condemned 且无 lease 且已就绪 → 立即清理；loading 情形由 settle 收尾
    if (entry.condemned && entry.leases.size === 0 && entry.gltf) this.teardown(entry);
  }

  private createEntry(hash: string, bundle: { url: string; partUrls: string[] }): Entry {
    const generation = ++this.generationCounter;
    const entry: Entry = {
      hash,
      generation,
      url: bundle.url,
      partUrls: bundle.partUrls,
      gltf: null,
      promise: undefined as unknown as Promise<GLTF>,
      leases: new Set(),
      condemned: false,
      torn: false,
    };
    this.entries.set(hash, entry);
    let promise: Promise<GLTF>;
    try {
      promise = this.loader(bundle.url);
    } catch (error) {
      // 同步抛错视同 reject：完整回滚（撤销全部 URL、移出 map），
      // 共享拒绝传播给全部 lease（与异步 reject 同一失败契约）
      this.entries.delete(hash);
      entry.torn = true;
      this.revoke(entry);
      promise = Promise.reject(error);
    }
    entry.promise = promise;
    if (!entry.torn) {
      promise.then(
        (gltf) => this.settle(entry, gltf, null),
        (error: unknown) => this.settle(entry, null, error),
      );
    }
    return entry;
  }

  private settle(entry: Entry, gltf: GLTF | null, error: unknown): void {
    if (entry.torn) {
      // teardown 已执行（仅可能发生在 settle 之前的 ready 路径之外，防御）
      if (gltf) disposeGltf(gltf);
      return;
    }
    if (error || !gltf) {
      // reject 路径：完整清理（撤销自身全部 URL、移出 map），只作用于自身 identity；
      // 失败经共享 promise 传播给全部 lease（此处无需逐个通知）
      if (this.entries.get(entry.hash) === entry) this.entries.delete(entry.hash);
      entry.torn = true;
      this.revoke(entry);
      return;
    }
    if (this.entries.get(entry.hash) !== entry) {
      // 被同 hash 新 generation 取代：只清理自己的内容与 URL，绝不触碰新条目
      disposeGltf(gltf);
      this.revoke(entry);
      return;
    }
    entry.gltf = gltf;
    // condemned 且无 lease（dispose/discard/sweep 后的唯一收尾 owner）→ 立即清理
    if (entry.condemned && entry.leases.size === 0) this.teardown(entry);
  }

  /** 唯一清理点：幂等；只删除自身 identity；revoke 全部 URL + 释放 GPU */
  private teardown(entry: Entry): void {
    if (entry.torn) return;
    if (this.entries.get(entry.hash) === entry) this.entries.delete(entry.hash);
    entry.torn = true;
    this.revoke(entry);
    if (entry.gltf) disposeGltf(entry.gltf);
  }

  private revoke(entry: Entry): void {
    URL.revokeObjectURL(entry.url);
    for (const partUrl of entry.partUrls) URL.revokeObjectURL(partUrl);
  }
}

/** base64 → 字节 */
function fromBase64(payload: string): ArrayBuffer {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}
