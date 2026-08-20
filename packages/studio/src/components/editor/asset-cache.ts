import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Project } from '@lumora/core';

/**
 * GLB/GLTF 内容缓存：按内容哈希索引，引用计数随模型对象增减，
 * 最后一个引用消失时释放 object URL 与 GPU 资源（几何/材质）。
 */
interface CacheEntry {
  hash: string;
  url: string;
  gltf: GLTF | null;
  promise: Promise<GLTF>;
  /** 引用该内容的模型对象 id 集合 */
  refs: Set<string>;
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
    if (existing) return existing.promise;
    return this.createEntry(hash, URL.createObjectURL(file));
  }

  /** 从持久化字节重建内容（项目重开/重做后缓存已释放的场景） */
  seed(hash: string, bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<GLTF> {
    const existing = this.entries.get(hash);
    if (existing) return existing.promise;
    const blob = new Blob([bytes], { type: 'model/gltf-binary' });
    return this.createEntry(hash, URL.createObjectURL(blob));
  }

  private createEntry(hash: string, url: string): Promise<GLTF> {
    const loader = new GLTFLoader();
    const promise = loader.loadAsync(url).then((gltf) => {
      const entry = this.entries.get(hash);
      if (entry) entry.gltf = gltf;
      this.fireReady(hash, gltf);
      return gltf;
    });
    this.entries.set(hash, { hash, url, gltf: null, promise, refs: new Set() });
    promise.catch(() => {
      this.entries.delete(hash);
      URL.revokeObjectURL(url);
    });
    return promise;
  }

  addRef(hash: string, objectId: string): void {
    this.entries.get(hash)?.refs.add(objectId);
  }

  removeRef(objectId: string): void {
    for (const [hash, entry] of this.entries) {
      if (entry.refs.delete(objectId) && entry.refs.size === 0) {
        this.entries.delete(hash);
        this.readyListeners.delete(hash);
        URL.revokeObjectURL(entry.url);
        if (entry.gltf) disposeObject(entry.gltf.scene);
      }
    }
  }

  /** 项目变更后清理：对象已不存在（删除/撤销删除/撤销导入）的引用全部释放 */
  sweep(project: Project): void {
    const alive = new Set(project.objects.map((o) => o.id));
    const dead: string[] = [];
    for (const entry of this.entries) {
      for (const ref of entry[1].refs) {
        if (!alive.has(ref)) dead.push(ref);
      }
    }
    for (const objectId of dead) this.removeRef(objectId);
    // 无引用的孤立条目（如撤销导入后重做、经 ensureCacheSeeded 恢复的资源
    // 未登记 refs）：项目中也无对象引用时释放，避免泄漏
    const referencedHashes = new Set<string>();
    for (const object of project.objects) {
      if (!object.assetId) continue;
      const asset = project.assets.find((a) => a.id === object.assetId);
      if (asset) referencedHashes.add(asset.hash);
    }
    for (const [hash, entry] of this.entries) {
      if (entry.refs.size === 0 && !referencedHashes.has(hash)) {
        this.entries.delete(hash);
        this.readyListeners.delete(hash);
        URL.revokeObjectURL(entry.url);
        if (entry.gltf) disposeObject(entry.gltf.scene);
      }
    }
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
    for (const entry of this.entries.values()) {
      URL.revokeObjectURL(entry.url);
      if (entry.gltf) disposeObject(entry.gltf.scene);
    }
    this.entries.clear();
    this.readyListeners.clear();
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
