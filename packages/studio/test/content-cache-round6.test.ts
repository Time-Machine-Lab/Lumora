// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ContentCache, resolvePartPath } from '../src/components/editor/content-cache';
import type { CacheLease, CachePartFile } from '../src/components/editor/content-cache';

/**
 * R6 对抗测试（TML-57 第六轮复审，修复前必须失败）：
 * - P0 lease 不可伪造 brand 与 token membership：已 release/stale/伪造的 lease
 *   无权改变 entry（判死刑/引入新 generation），释放必须从自身 entry 移除
 *   （不按 hash 查找，杜绝 generation 错配早退导致的 stale 成员滞留泄漏）；
 * - P0 全资源图析构：以整个 GLTF（scene/scenes）为单位收集共享
 *   geometry/material/texture、Skeleton.boneTexture 与 ShaderMaterial uniforms，
 *   全局 identity Set exactly-once；
 * - P0 URI 规范化：percent-decode、query/fragment 剥离、dot-segment 归并。
 */

const BYTES = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;

function makeGltf(): GLTF {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  return { scene } as unknown as GLTF;
}

function geometryOf(gltf: GLTF): THREE.BufferGeometry {
  return (gltf.scene.children[0] as THREE.Mesh).geometry;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function gltfJsonBytes(uris: { buffers?: string[]; images?: string[] }): ArrayBuffer {
  const json = {
    asset: { version: '2.0' },
    buffers: (uris.buffers ?? []).map((uri) => ({ uri, byteLength: 4 })),
    images: (uris.images ?? []).map((uri) => ({ uri })),
  };
  return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R6 lease 不可伪造 brand 与 token membership', () => {
  it('R6-T1 已 release 的 A discard 不得判死 B 的 live entry（成员校验）', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });
    const a = cache.acquire('h1', BYTES, { format: 'glb' });
    const b = cache.acquire('h1', BYTES, { format: 'glb' });
    const gltf = makeGltf();
    const disposeSpy = vi.spyOn(geometryOf(gltf), 'dispose');
    resolvers[0]!(gltf);
    await flush();

    a.release();
    cache.discard(a); // stale：无权判死刑
    expect(b.isReleased).toBe(false); // B 仍在使用
    expect(cache.isReady('h1')).toBe(true);

    b.release(); // 正常离开：条目未判死刑 → 内容存活待后续消费者
    expect(disposeSpy).not.toHaveBeenCalled(); // RED：被间接判死并 teardown（1 次）
    expect(cache.has('h1')).toBe(true); // RED：entry 已被清理
    expect(cache.isReady('h1')).toBe(true); // RED：内容丢失
  });

  it('R6-T2 A/B/C 反序交错：stale discard 不得引入新 generation、不滞留旧 entry、无泄漏', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });
    const a = cache.acquire('h1', BYTES, { format: 'glb' });
    const b = cache.acquire('h1', BYTES, { format: 'glb' });
    const gltf1 = makeGltf();
    const d1 = vi.spyOn(geometryOf(gltf1), 'dispose');
    resolvers[0]!(gltf1);
    await flush();

    a.release();
    cache.discard(a); // stale 无权判死刑 → C 必须加入同一 entry
    const c = cache.acquire('h1', BYTES, { format: 'glb' });
    expect(resolvers.length).toBe(1); // RED：现实现重新加载并新建 generation（2 次）
    b.release();
    c.release();
    cache.sweep(null); // 无项目引用：全部清理
    expect(d1).toHaveBeenCalledTimes(1); // RED：B 滞留旧 entry 的 leases，永不 teardown（0 次）
    expect(cache.has('h1')).toBe(false); // RED：旧 entry 泄漏（仍可 has）
  });

  it('R6-T3 多文件 URL 每创建恰好一次撤销（反序交错后 sweep），无泄漏', async () => {
    const mainBytes = gltfJsonBytes({ buffers: ['mesh.bin'], images: ['tex.png'] });
    const parts: CachePartFile[] = [
      { path: 'mesh.bin', mime: 'application/octet-stream', bytes: BYTES },
      { path: 'tex.png', mime: 'image/png', bytes: BYTES },
    ];
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const a = cache.acquire('h2', mainBytes, { format: 'gltf', parts });
    const b = cache.acquire('h2', mainBytes, { format: 'gltf', parts });
    resolvers[0]!(makeGltf());
    await flush();
    a.release();
    cache.discard(a); // stale：不得判死刑、不得新建 generation
    const c = cache.acquire('h2', mainBytes, { format: 'gltf', parts });
    expect(resolvers.length).toBe(1); // RED：现实现新建 generation 二次加载
    b.release();
    c.release();
    cache.sweep(null);
    const created = createSpy.mock.calls.length;
    const revoked = revokeSpy.mock.calls.length;
    expect(revoked).toBe(created); // RED：现实现新 generation 的 3 个 URL 撤销、旧 3 个泄漏
    expect(cache.has('h2')).toBe(false); // RED：旧 entry 泄漏
  });

  it('R6-T4 伪造 lease：discard/release 不得触碰真实条目（不可伪造 brand）', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });
    const b = cache.acquire('h3', BYTES, { format: 'glb' });
    const gltf = makeGltf();
    const disposeSpy = vi.spyOn(geometryOf(gltf), 'dispose');
    resolvers[0]!(gltf);
    await flush();

    const forged = {
      hash: 'h3',
      generation: b.generation,
      content: new Promise<GLTF>(() => {}), // 永不落定：避免未处理的 rejection 干扰
      isReleased: false,
      release: vi.fn(),
    } as unknown as CacheLease;

    expect(() => forged.release()).not.toThrow(); // RED：现实现进入 releaseLease 抛 TypeError
    cache.discard(forged); // 伪造 lease 无权判死刑
    expect(b.isReleased).toBe(false);
    expect(cache.has('h3')).toBe(true);

    b.release(); // 真实 lease 正常离开：条目未判死刑 → 内容存活
    expect(disposeSpy).not.toHaveBeenCalled(); // RED：被伪造 discard 判死并 teardown（1 次）
    expect(cache.has('h3')).toBe(true); // RED：内容已清理
  });
});

describe('R6 全资源图析构（整 GLTF exactly-once）', () => {
  it('R6-T5 多场景共享 geometry/material/texture + boneTexture + ShaderMaterial uniforms 恰好一次', async () => {
    const scene1 = new THREE.Group();
    const scene2 = new THREE.Group();
    const geometry = new THREE.BoxGeometry();
    const texture = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    scene1.add(new THREE.Mesh(geometry, material));
    const skeleton = new THREE.Skeleton([new THREE.Bone()]);
    skeleton.computeBoneTexture(); // r170 构造时不建 boneTexture，渲染器在绑定时才计算
    const skinned = new THREE.SkinnedMesh(geometry, material);
    skinned.add(skeleton.bones[0]!);
    skinned.bind(skeleton);
    scene2.add(skinned);
    const shaderTex = new THREE.Texture();
    const listTexA = new THREE.Texture();
    const listTexB = new THREE.Texture();
    const shader = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: shaderTex }, uList: { value: [listTexA, listTexB] } },
    });
    scene2.add(new THREE.Mesh(geometry, shader));
    const gltf = { scene: scene1, scenes: [scene1, scene2] } as unknown as GLTF;

    const loader = vi.fn(async () => gltf);
    const cache = new ContentCache({ loader });
    const spies = {
      geometry: vi.spyOn(geometry, 'dispose'),
      material: vi.spyOn(material, 'dispose'),
      texture: vi.spyOn(texture, 'dispose'),
      boneTexture: vi.spyOn(skeleton.boneTexture!, 'dispose'),
      shaderTex: vi.spyOn(shaderTex, 'dispose'),
      listTexA: vi.spyOn(listTexA, 'dispose'),
      listTexB: vi.spyOn(listTexB, 'dispose'),
    };

    const lease = cache.acquire('h4', BYTES, { format: 'glb' });
    await lease.content;
    expect(cache.isReady('h4')).toBe(true);
    lease.release();
    cache.sweep(null); // 无引用：teardown 全资源图

    for (const [name, spy] of Object.entries(spies)) {
      // RED：scene2 的资源（boneTexture/ShaderMaterial uniforms）从未被释放（0 次）
      expect(spy, name).toHaveBeenCalledTimes(1);
    }
    expect(cache.has('h4')).toBe(false);
  });
});

describe('R6 URI 规范化（decode / query-fragment 剥离 / dot-segment 归并）', () => {
  it('R6-T6 resolvePartPath：编码、参数与点段形式统一命中精确路径', () => {
    const parts = [
      { path: 'my tex.png', mime: 'image/png', bytes: BYTES },
      { path: 'sub/mesh.bin', mime: 'application/octet-stream', bytes: BYTES },
    ];
    expect(resolvePartPath('my%20tex.png', parts).kind).toBe('exact'); // RED：missing
    expect(resolvePartPath('sub/mesh.bin?v=1', parts).kind).toBe('exact'); // RED：missing
    expect(resolvePartPath('sub/mesh.bin#frag', parts).kind).toBe('exact'); // RED：missing
    expect(resolvePartPath('sub/./mesh.bin', parts).kind).toBe('exact'); // RED：missing
    expect(resolvePartPath('sub/../sub/mesh.bin', parts).kind).toBe('exact'); // RED：missing
    expect(resolvePartPath('other/name.png', parts).kind).toBe('missing');
  });

  it('R6-T7 .gltf 导入全链路：编码 URI 命中解码后的依赖并重写为 blob URL', async () => {
    const mainBytes = gltfJsonBytes({ buffers: ['mesh%20data.bin'] });
    const parts: CachePartFile[] = [
      { path: 'mesh data.bin', mime: 'application/octet-stream', bytes: BYTES },
    ];
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    let mainBlob: Blob | null = null;
    const loader = vi.fn(async (_url: string) => {
      // buildLoadableUrl 先建依赖 blob、最后建主 JSON blob；loader 拿到的是主 URL
      const last = createSpy.mock.calls[createSpy.mock.calls.length - 1];
      mainBlob = (last?.[0] as Blob) ?? null;
      return makeGltf();
    });
    const cache = new ContentCache({ loader });

    expect(() => cache.acquire('h5', mainBytes, { format: 'gltf', parts })).not.toThrow();
    // RED：现实现 buildLoadableUrl 抛「缺少依赖文件：mesh%20data.bin」
    const rewritten = JSON.parse(await mainBlob!.text()) as { buffers: { uri: string }[] };
    expect(rewritten.buffers[0]!.uri).toMatch(/^blob:/); // 依赖已按 blob URL 重写
    expect(rewritten.buffers[0]!.uri).not.toContain('mesh%20data.bin');
    expect(createSpy.mock.calls.length).toBe(2); // 主 JSON + 依赖
  });
});
