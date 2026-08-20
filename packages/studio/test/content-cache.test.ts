// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Project } from '@lumora/core';
import { ContentCache, resolveFormat } from '../src/components/editor/content-cache';

/**
 * P1 ContentCache 状态机测试（TML-57 批准方案）：
 * 覆盖四个硬约束的受控并发验证 ——
 * 1. dispose 不依赖消费者配合（原子撤销全部 lease；settle 独立完成唯一 teardown）；
 * 2. 禁止裸资源旁路（查询 API 仅元数据；get/urlFor/onContentReady 编译级不存在）；
 * 3. 同 hash generation 隔离（旧条目 settle/teardown 只删除自身 identity）；
 * 4. （EditorState 边界见 P2 测试）
 */

const BYTES = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;

/** 带真实几何/材质的场景：可对 dispose 进行精确计数断言 */
function makeGltf(): GLTF {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  return { scene } as unknown as GLTF;
}

function geometryOf(gltf: GLTF): THREE.BufferGeometry {
  return (gltf.scene.children[0] as THREE.Mesh).geometry;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('硬约束 1：dispose 不依赖消费者配合', () => {
  it('T1 dispose 原子撤销全部 lease：settle 独立完成唯一 teardown，迟到的 release 为幂等 no-op', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });
    const lease = cache.acquire('h1', BYTES, { format: 'glb' });
    const gltf = makeGltf();
    const disposeSpy = vi.spyOn(geometryOf(gltf), 'dispose');

    cache.dispose();
    // 消费者之后 release 多次：全部幂等 no-op，不抛错、不重复释放
    expect(() => {
      lease.release();
      lease.release();
    }).not.toThrow();
    // 终态：缓存不再接受任何 acquire（含同 hash 重试）
    expect(() => cache.acquire('h1', BYTES, { format: 'glb' })).toThrow('缓存已释放');

    // loader 在途条目保留至 settle，由 settle 处理器独立收尾（不依赖消费者 finally）
    expect(cache.has('h1')).toBe(true);
    resolvers[0]!(gltf);
    await flush();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(cache.has('h1')).toBe(false);
  });

  it('T6 dispose 立即清理全部 ready 条目；多个 lease 全部撤销，无重复释放', async () => {
    const loader = vi.fn(async () => makeGltf());
    const cache = new ContentCache({ loader });
    const a = cache.acquire('h1', BYTES, { format: 'glb' });
    const b = cache.acquire('h2', BYTES, { format: 'glb' });
    const [gltfA, gltfB] = await Promise.all([a.content, b.content]);
    const disposeA = vi.spyOn(geometryOf(gltfA), 'dispose');
    const disposeB = vi.spyOn(geometryOf(gltfB), 'dispose');

    cache.dispose();
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(cache.has('h1')).toBe(false);
    expect(cache.has('h2')).toBe(false);
    // 两个消费者都晚到 release：幂等
    expect(() => {
      a.release();
      b.release();
    }).not.toThrow();
    expect(disposeA).toHaveBeenCalledTimes(1);
  });
});

describe('硬约束 2：禁止裸资源旁路', () => {
  it('T8 查询 API 只返回元数据：has/isReady/getInfo 不含 GLTF/URL；get/urlFor/onContentReady 编译级不存在', async () => {
    const cache = new ContentCache({ loader: vi.fn(async () => makeGltf()) });
    // 类型级保证：若未来有人重新添加裸访问 API，@ts-expect-error 将失败 → typecheck 拦截
    /* eslint-disable @typescript-eslint/no-unused-expressions -- 编译级 API 缺席断言 */
    // @ts-expect-error 禁止裸资源旁路：不得从缓存直接取 GLTF 对象
    cache.get;
    // @ts-expect-error 禁止裸资源旁路：不得从缓存取 object URL
    cache.urlFor;
    // @ts-expect-error 禁止裸资源旁路：不得无所有权订阅内容就绪
    cache.onContentReady;
    /* eslint-enable @typescript-eslint/no-unused-expressions */

    expect(cache.has('h')).toBe(false);
    expect(cache.isReady('h')).toBe(false);
    expect(cache.getInfo('h')).toBeNull();

    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    expect(cache.has('h')).toBe(true);
    expect(cache.getInfo('h')).toEqual({ hash: 'h', ready: false });
    await lease.content;
    expect(cache.isReady('h')).toBe(true);
    expect(cache.getInfo('h')).toEqual({ hash: 'h', ready: true });
    // getInfo 返回值为元数据快照，不含任何 GLTF/GPU 引用
    lease.release();
  });

  it('retain 只对已存在条目签发新 lease；缺失/已清理条目返回 null（不自动创建）', async () => {
    const cache = new ContentCache({ loader: vi.fn(async () => makeGltf()) });
    expect(cache.retain('missing')).toBeNull();
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    await lease.content;
    lease.release();
    const retained = cache.retain('h');
    expect(retained).not.toBeNull();
    expect(retained!.hash).toBe('h');
    retained!.release();
  });
});

describe('硬约束 3：同 hash generation 隔离', () => {
  it('T2 旧条目 settle 只清理自身：不删除同 hash 新条目，新 generation 完全独立', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });

    const oldLease = cache.acquire('h', BYTES, { format: 'glb' });
    cache.discard(oldLease); // 判死刑 + 释放（末 lease）
    expect(cache.has('h')).toBe(true); // loading 条目等待 settle 收尾

    const newLease = cache.acquire('h', BYTES, { format: 'glb' }); // 新 generation
    expect(newLease.generation).not.toBe(oldLease.generation);

    // 旧 loader 此刻 settle：只释放旧内容与旧 URL，绝不触碰新条目
    const oldGltf = makeGltf();
    const oldDispose = vi.spyOn(geometryOf(oldGltf), 'dispose');
    resolvers[0]!(oldGltf);
    await flush();
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(cache.has('h')).toBe(true); // 新条目仍在

    // 新条目正常就绪、可续租；旧 lease 迟到 release 不影响新 generation
    const newGltf = makeGltf();
    resolvers[1]!(newGltf);
    await flush();
    expect(cache.isReady('h')).toBe(true);
    expect(() => oldLease.release()).not.toThrow();
    expect(cache.isReady('h')).toBe(true);
    const retained = cache.retain('h');
    expect(retained).not.toBeNull();
    retained!.release();
  });

  it('T9 discard 只在末 lease 时判死刑：同 hash 新会话仍持租用时条目存活', async () => {
    const gltf = makeGltf();
    const cache = new ContentCache({ loader: vi.fn(async () => gltf) });
    const oldSession = cache.acquire('h', BYTES, { format: 'glb' });
    const newSession = cache.acquire('h', BYTES, { format: 'glb' });

    cache.discard(oldSession); // 旧会话取消：但新会话 lease 仍在使用 → 不判死刑
    await newSession.content;
    expect(cache.has('h')).toBe(true);
    newSession.release();
    expect(cache.has('h')).toBe(true); // 未被 condemn，存活至 sweep
    cache.sweep(null); // 项目关闭：无引用 → 释放
    expect(cache.has('h')).toBe(false);
  });
});

describe('状态机：sweep / discard / settle / seed', () => {
  it('T3 无引用 loading 条目：sweep 判死刑，settle 即清理（不常驻）', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const cache = new ContentCache({ loader: vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve))) });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    lease.release(); // 消费者卸载时释放 lease，loader 仍在途

    cache.sweep(null); // 无引用且无 lease → 判死刑
    expect(cache.has('h')).toBe(true); // 等待 settle 的唯一收尾

    const gltf = makeGltf();
    const disposeSpy = vi.spyOn(geometryOf(gltf), 'dispose');
    resolvers[0]!(gltf);
    await flush();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(cache.has('h')).toBe(false);
    expect(cache.retain('h')).toBeNull(); // 不可再续租
    expect(() => lease.release()).not.toThrow();
  });

  it('T5 导入取消：discard 判死刑并释放；ready 条目立即清理，重复 release 幂等', async () => {
    const gltf = makeGltf();
    const cache = new ContentCache({ loader: vi.fn(async () => gltf) });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    await lease.content;
    const disposeSpy = vi.spyOn(geometryOf(gltf), 'dispose');

    cache.discard(lease);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(cache.has('h')).toBe(false);
    expect(() => lease.release()).not.toThrow();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('T7 loader reject：撤销全部 URL、移出 map，同一失败传播给全部 lease', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('boom')));
    const cache = new ContentCache({ loader });
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const a = cache.acquire('h', BYTES, { format: 'glb' });
    const b = cache.acquire('h', BYTES, { format: 'glb' }); // 同一 entry 两个 lease

    const failureA = await a.content.catch((e: Error) => e);
    const failureB = await b.content.catch((e: Error) => e);
    expect(failureA).toBeInstanceOf(Error);
    expect(failureB).toBeInstanceOf(Error);
    expect((failureA as Error).message).toBe('boom');
    expect((failureB as Error).message).toBe('boom'); // 共享 promise：同一失败
    expect(cache.has('h')).toBe(false);
    expect(cache.retain('h')).toBeNull();
    expect(revokeSpy).toHaveBeenCalledTimes(1); // 主 URL 只撤销一次
    expect(() => {
      a.release();
      b.release();
    }).not.toThrow();
  });

  it('T4 统一释放：Mesh/Points/Line 的 geometry/material 与纹理一并释放', async () => {
    const loader = vi.fn(async () => {
      const scene = new THREE.Group();
      scene.add(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()));
      scene.add(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()));
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      scene.add(mesh);
      return { scene } as unknown as GLTF;
    });
    const cache = new ContentCache({ loader });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    const gltf = await lease.content;
    const points = gltf.scene.children[0] as THREE.Points;
    const line = gltf.scene.children[1] as THREE.Line;
    const mesh = gltf.scene.children[2] as THREE.Mesh;
    const spies = [points.geometry, line.geometry, mesh.geometry].map((g) => vi.spyOn(g, 'dispose'));
    const materialSpy = vi.spyOn(mesh.material as THREE.Material, 'dispose');

    lease.release();
    cache.sweep(null); // 无引用 → 统一 teardown
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
  });

  it('sweep 以项目全量 model→asset 关系为准：被引用条目保留，引用消失即释放', async () => {
    const gltf = makeGltf();
    const cache = new ContentCache({ loader: vi.fn(async () => gltf) });
    const lease = cache.acquire('ref', BYTES, { format: 'glb' });
    await lease.content;
    lease.release();

    const project: Project = {
      uri: 'p',
      name: 'p',
      schemaVersion: 2,
      createdAt: '',
      revision: 0,
      settings: { fps: 60, aspect: [16, 9] },
      activeSceneId: 's',
      scenes: [{ id: 's', name: 'S', rootObjectIds: ['o'], activeCameraId: null }],
      objects: [
        {
          id: 'o',
          type: 'model',
          name: 'm',
          parentId: null,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          assetId: 'a',
        },
      ],
      assets: [
        {
          id: 'a',
          kind: 'gltf',
          name: 'm.glb',
          format: 'glb',
          mime: 'model/gltf-binary',
          hash: 'ref',
          size: 1,
          source: 'file',
          storageRef: '',
          createdAt: '',
        },
      ],
    };
    cache.sweep(project);
    expect(cache.has('ref')).toBe(true);
    // 引用消失（最后一个模型对象删除）→ 释放
    cache.sweep({ ...project, objects: [] });
    expect(cache.has('ref')).toBe(false);
  });

  it('seed 从载荷重建：同 hash 复用条目；内容随项目引用存活可续租', async () => {
    const loader = vi.fn(async () => makeGltf());
    const cache = new ContentCache({ loader });
    const payload = btoa(String.fromCharCode(...[1, 2, 3]));

    const lease = cache.seed('h', payload, { format: 'glb' });
    await lease.content;
    expect(cache.isReady('h')).toBe(true);

    const again = cache.seed('h', payload, { format: 'glb' });
    expect(again.generation).toBe(lease.generation); // 复用同一条目
    again.release();
    lease.release();
    const retained = cache.retain('h');
    expect(retained).not.toBeNull();
    retained!.release();
  });
});

describe('resolveFormat：显式格式 > 扩展名 > mime', () => {
  it('浏览器 MIME 误报（application/json/octet-stream）以扩展名为准', () => {
    expect(resolveFormat('car.gltf', 'application/json')).toBe('gltf');
    expect(resolveFormat('car.gltf', 'application/octet-stream')).toBe('gltf');
    expect(resolveFormat('car.glb', 'application/octet-stream')).toBe('glb');
    expect(resolveFormat('car.glb', 'model/gltf-binary')).toBe('glb');
    expect(resolveFormat('car.txt', 'model/gltf+json')).toBe('gltf');
    expect(resolveFormat('car.txt', 'model/gltf-binary')).toBe('glb');
    expect(resolveFormat('car.txt', 'text/plain')).toBe('glb'); // 缺省
    expect(resolveFormat('car.txt', 'text/plain', 'gltf')).toBe('gltf'); // 显式最高优先级
  });
});
