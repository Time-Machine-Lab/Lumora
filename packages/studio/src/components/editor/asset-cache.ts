import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Project } from '@lumora/core';

/**
 * GLB/GLTF 内容缓存：按内容哈希索引。
 * 引用关系不在此处维护——以 Project 全量 model→asset 关系为准（sweep 时重建），
 * 覆盖复制（Ctrl+D）、撤销/重做、外部改名等一切对象变更路径；
 * 项目不再引用且内容已就绪的条目释放 object URL 与 GPU 资源（几何/材质）。
 */
interface CacheEntry {
  hash: string;
  url: string;
  gltf: GLTF | null;
  promise: Promise<GLTF>;
}

export interface CachedModel {
  hash: string;
  url: string;
  gltf: GLTF | null;
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

export class AssetCache {
  private entries = new Map<string, CacheEntry>();
  private readyListeners = new Map<string, Set<(gltf: GLTF) => void>>();
  /** 正在等待解析结果的消费者计数：并发导入复用同一条目时，不得释放仍被等待的内容 */
  private waiters = new Map<string, number>();

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

  /** 获取（或首次加载）模型内容；解析失败时回滚缓存并抛出错误 */
  acquire(hash: string, file: File): Promise<GLTF> {
    const existing = this.entries.get(hash);
    const promise = existing ? existing.promise : this.createEntry(hash, URL.createObjectURL(file));
    this.trackWaiter(hash, promise);
    return promise;
  }

  /** 从持久化字节重建内容（项目重开/重做后缓存已释放的场景） */
  seed(hash: string, bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<GLTF> {
    const existing = this.entries.get(hash);
    const promise = existing
      ? existing.promise
      : this.createEntry(hash, URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' })));
    this.trackWaiter(hash, promise);
    return promise;
  }

  private trackWaiter(hash: string, promise: Promise<GLTF>): void {
    this.waiters.set(hash, (this.waiters.get(hash) ?? 0) + 1);
    const decrement = (): void => {
      const next = (this.waiters.get(hash) ?? 1) - 1;
      if (next <= 0) this.waiters.delete(hash);
      else this.waiters.set(hash, next);
    };
    promise.then(decrement, decrement);
  }

  private createEntry(hash: string, url: string): Promise<GLTF> {
    const loader = new GLTFLoader();
    const promise = loader.loadAsync(url).then((gltf) => {
      const entry = this.entries.get(hash);
      if (entry) entry.gltf = gltf;
      this.fireReady(hash, gltf);
      return gltf;
    });
    this.entries.set(hash, { hash, url, gltf: null, promise });
    promise.catch(() => {
      this.entries.delete(hash);
      URL.revokeObjectURL(url);
    });
    return promise;
  }

  /**
   * 项目变更后清理：引用集从 Project 全量 model→asset 关系重建，
   * 与 UI 路径（复制/删除/撤销/重做/改名）无关。
   * project 为 null（关闭/切换项目）时释放全部内容；
   * 解析中的条目（gltf 未就绪）保留——可能是进行中的导入，
   * 解析完成后若无项目引用，下次 sweep 释放。
   */
  sweep(project: Project | null): void {
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

  /** 主动丢弃条目（导入会话切换的取消路径）：无条件释放 */
  discard(hash: string): void {
    this.release(hash);
  }

  private release(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) return;
    // 仍有消费者等待解析结果（旧会话取消导入时新会话可能已复用同一条目）→ 推迟释放，下次清扫执行
    if ((this.waiters.get(hash) ?? 0) > 0) return;
    this.entries.delete(hash);
    this.readyListeners.delete(hash);
    URL.revokeObjectURL(entry.url);
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

  dispose(): void {
    for (const hash of [...this.entries.keys()]) this.release(hash);
  }

  private fireReady(hash: string, gltf: GLTF): void {
    const listeners = this.readyListeners.get(hash);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(gltf);
    this.readyListeners.delete(hash);
  }
}

/** base64 → 字节 */
function fromBase64(payload: string): Uint8Array<ArrayBuffer> {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 从项目资产的 base64 载荷重建内容缓存（项目重开/撤销后重做时调用）：
 * 同步启动缺失条目的解析（已存在的条目不受影响），返回各条目解析 promise。
 */
export function ensureCacheSeeded(cache: AssetCache, project: Project): Promise<GLTF>[] {
  const seeds: Promise<GLTF>[] = [];
  for (const asset of project.assets) {
    if (!asset.payload || cache.has(asset.hash)) continue;
    seeds.push(cache.seed(asset.hash, fromBase64(asset.payload)));
  }
  return seeds;
}

/** 等待 ensureCacheSeeded 启动的全部解析完成 */
export async function hydrateCache(cache: AssetCache, project: Project): Promise<void> {
  await Promise.all(ensureCacheSeeded(cache, project));
}
