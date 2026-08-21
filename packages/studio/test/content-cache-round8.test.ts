// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ContentCache } from '../src/components/editor/content-cache';

/**
 * R8-11 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * Cache lease owner 校验缺失（content-cache.ts:414-421）：brand（module 级
 * WeakSet）与 membership 都跨实例成立 —— cacheB.discard(cacheA 签发的 lease)
 * 会把 A 的条目判死刑并 teardown（跨实例判死）。
 * 修复：显式校验 lease 的签发实例（lease.owner === this），异实例 lease 一律忽略。
 */

const BYTES = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;

function makeGltf(): GLTF {
  return { scene: new THREE.Group() } as unknown as GLTF;
}

const loader = () => Promise.resolve(makeGltf());

describe('R8-11 Cache lease 按实例隔离', () => {
  it('R8-11-T1 跨实例 discard：cacheB 用 cacheA 签发的 lease 不得判死 A 的条目', async () => {
    const a = new ContentCache({ loader });
    const b = new ContentCache({ loader });
    const leaseA = a.acquire('h1', BYTES, { format: 'glb' });
    await leaseA.content;
    expect(a.isReady('h1')).toBe(true);

    // RED：旧实现 module 级 brand + entry membership 均通过 → B 把 A 的条目判死刑，
    // A 的已就绪内容被 teardown（isReady/has 变 false）
    b.discard(leaseA);
    expect(a.isReady('h1')).toBe(true);
    expect(a.has('h1')).toBe(true);

    // 对照：B 用自己签发的 lease 判死自己条目仍正常
    const leaseB = b.acquire('h2', BYTES, { format: 'glb' });
    await leaseB.content;
    b.discard(leaseB);
    expect(b.has('h2')).toBe(false);

    leaseA.release();
    a.dispose();
    b.dispose();
  });
});
