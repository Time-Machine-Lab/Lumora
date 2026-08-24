// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Project } from '@lumora/core';
import { ContentCache, resolveFormat, resolvePartPath } from '../src/components/editor/content-cache';

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

  it('T10 多文件 .gltf loader reject：撤销主 URL 与全部依赖 URL、移出 map，同一失败传播给全部 lease', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('boom')));
    const cache = new ContentCache({ loader });
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    // format 'gltf' 的 acquire 会把主字节当 JSON 解析并重写相对 URI，必须传有效 gltf JSON
    const mainBytes = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Root' }],
        buffers: [{ uri: 'mesh.bin' }],
        images: [{ uri: 'diffuse.png' }],
      }),
    ).buffer as ArrayBuffer;
    const parts = [
      { path: 'mesh.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2]).buffer as ArrayBuffer },
      { path: 'diffuse.png', mime: 'image/png', bytes: new Uint8Array([3, 4]).buffer as ArrayBuffer },
    ];
    const a = cache.acquire('h', mainBytes, { format: 'gltf', parts });
    const b = cache.acquire('h', mainBytes, { format: 'gltf', parts }); // 同一 entry 两个 lease

    const failureA = await a.content.catch((e: Error) => e);
    const failureB = await b.content.catch((e: Error) => e);
    expect((failureA as Error).message).toBe('boom');
    expect((failureB as Error).message).toBe('boom'); // 共享 promise：同一失败
    expect(cache.has('h')).toBe(false);
    expect(cache.retain('h')).toBeNull();
    expect(revokeSpy).toHaveBeenCalledTimes(3); // 主 URL + 2 个依赖 URL 全部撤销
    expect(() => {
      a.release();
      b.release();
    }).not.toThrow();
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
      schemaVersion: 3,
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
      tracks: [],
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

describe('M2 完整资源图析构：共享 geometry/material/texture exactly-once', () => {
  it('T11 DAG 共享资源只释放一次：两节点共用同一几何/材质/纹理', async () => {
    const geometry = new THREE.BoxGeometry();
    const texture = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const loader = vi.fn(async () => {
      const scene = new THREE.Group();
      // GLTF 内同一资源可能被多个节点共享（DAG）：identity Set 必须 exactly-once
      scene.add(new THREE.Mesh(geometry, material));
      scene.add(new THREE.Mesh(geometry, material));
      return { scene } as unknown as GLTF;
    });
    const cache = new ContentCache({ loader });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    await lease.content; // 等 settle（析构断言在 release 之后）
    const geometrySpy = vi.spyOn(geometry, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');
    const textureSpy = vi.spyOn(texture, 'dispose');

    lease.release();
    cache.sweep(null);
    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(textureSpy).toHaveBeenCalledTimes(1);
    expect(cache.has('h')).toBe(false);
  });
});

describe('M2 失败完整回滚：同步/异步 loader 失败不泄漏条目与 URL', () => {
  it('T12 loader 同步抛错：撤销全部 URL、移出 map，同一失败传播给全部 lease，迟到 release 幂等', async () => {
    const loader = vi.fn(() => {
      throw new Error('sync boom');
    });
    const cache = new ContentCache({ loader });
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const a = cache.acquire('h', BYTES, { format: 'glb' });
    // 同步失败立即回滚：不产生常驻条目
    expect(cache.has('h')).toBe(false);
    const b = cache.acquire('h', BYTES, { format: 'glb' }); // 新 generation 重新加载
    const failureA = await a.content.catch((e: Error) => e);
    const failureB = await b.content.catch((e: Error) => e);
    expect((failureA as Error).message).toBe('sync boom');
    expect((failureB as Error).message).toBe('sync boom');
    expect(cache.has('h')).toBe(false);
    expect(cache.retain('h')).toBeNull();
    // 每次 acquire 创建与回滚的 URL 成对：无泄漏
    expect(createSpy.mock.calls.length).toBeGreaterThan(0);
    expect(revokeSpy.mock.calls.length).toBe(createSpy.mock.calls.length);
    expect(() => {
      a.release();
      b.release();
    }).not.toThrow();
  });

  it('T13 部分依赖 URL 创建失败：完整回滚已创建的全部 URL，acquire 同步抛错，无残留条目', () => {
    const cache = new ContentCache({ loader: vi.fn() });
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const mainBytes = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Root' }],
        buffers: [{ uri: 'mesh.bin' }],
        images: [{ uri: 'diffuse.png' }],
      }),
    ).buffer as ArrayBuffer;
    // 只提供 mesh.bin：diffuse.png 缺失 → 已创建的 mesh.bin URL 必须回滚
    const parts = [
      { path: 'mesh.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2]).buffer as ArrayBuffer },
    ];
    expect(() => cache.acquire('h', mainBytes, { format: 'gltf', parts })).toThrow('缺少依赖文件：diffuse.png');
    expect(createSpy).toHaveBeenCalledTimes(1); // 仅 mesh.bin 的 URL
    expect(revokeSpy).toHaveBeenCalledTimes(1); // 回滚撤销（主 JSON URL 尚未创建）
    expect(cache.has('h')).toBe(false);
  });

  it('T14 依赖歧义：同 basename 多候选必须失败，未创建任何 URL', () => {
    const cache = new ContentCache({ loader: vi.fn() });
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const mainBytes = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Root' }],
        buffers: [{ uri: 'mesh.bin' }],
      }),
    ).buffer as ArrayBuffer;
    const parts = [
      { path: 'a/mesh.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1]).buffer as ArrayBuffer },
      { path: 'b/mesh.bin', mime: 'application/octet-stream', bytes: new Uint8Array([2]).buffer as ArrayBuffer },
    ];
    expect(() => cache.acquire('h', mainBytes, { format: 'gltf', parts })).toThrow('依赖文件歧义：mesh.bin');
    expect(createSpy).not.toHaveBeenCalled();
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(cache.has('h')).toBe(false);
  });

  it('T15 失败后重试成功：同 hash 新 generation 独立加载（新旧 generation 交错）', async () => {
    const gltf = makeGltf();
    const loader = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sync boom');
      })
      .mockResolvedValueOnce(gltf);
    const cache = new ContentCache({ loader });
    const failed = cache.acquire('h', BYTES, { format: 'glb' });
    await failed.content.catch(() => undefined);
    const retried = cache.acquire('h', BYTES, { format: 'glb' });
    const content = await retried.content;
    expect(content).toBe(gltf);
    expect(cache.isReady('h')).toBe(true);
    const disposeSpy = vi.spyOn(geometryOf(gltf), 'dispose');
    failed.release();
    retried.release();
    cache.sweep(null);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('M2 resolvePartPath 规范解析：精确路径优先、basename 唯一兜底、歧义失败', () => {
  const parts = [{ path: 'textures/diffuse.png' }, { path: 'assets/mesh.bin' }, { path: 'other/mesh.bin' }];

  it('精确相对路径优先（同 basename 歧义存在时仍命中）', () => {
    expect(resolvePartPath('assets/mesh.bin', parts)).toEqual({ kind: 'exact', part: parts[1] });
  });

  it('basename 唯一时兜底命中', () => {
    expect(resolvePartPath('nested/diffuse.png', parts)).toEqual({ kind: 'unique-basename', part: parts[0] });
  });

  it('basename 多候选：歧义必须失败，不静默取其一', () => {
    expect(resolvePartPath('sub/mesh.bin', parts)).toEqual({ kind: 'ambiguous', uri: 'sub/mesh.bin' });
  });

  it('无任何命中：缺失', () => {
    expect(resolvePartPath('ghost.xyz', parts)).toEqual({ kind: 'missing', uri: 'ghost.xyz' });
  });
});

describe('M2 双实例 lease：条目存活由全部消费者共同决定', () => {
  it('两消费者持 lease 同享一条目：单方释放条目存活，双方释放后 sweep 清理', async () => {
    const gltf = makeGltf();
    const cache = new ContentCache({ loader: vi.fn(async () => gltf) });
    const consumerA = cache.acquire('h', BYTES, { format: 'glb' });
    await consumerA.content;
    const consumerB = cache.retain('h');
    expect(consumerB).not.toBeNull();
    expect(consumerB!.generation).toBe(consumerA.generation); // 同一条目

    cache.sweep(null); // 双方仍持租用：条目存活
    expect(cache.has('h')).toBe(true);
    consumerA.release();
    cache.sweep(null); // 仅剩 consumerB：仍存活
    expect(cache.has('h')).toBe(true);
    consumerB!.release();
    cache.sweep(null); // 全部释放：清理
    expect(cache.has('h')).toBe(false);
  });

  it('isReleased：dispose 原子撤销后立即为 true，异步回调凭此失效守卫', async () => {
    const cache = new ContentCache({ loader: vi.fn(async () => makeGltf()) });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    await lease.content;
    expect(lease.isReleased).toBe(false);
    cache.dispose();
    expect(lease.isReleased).toBe(true);
    expect(lease.isReleased).toBe(true); // 幂等
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

describe('第三十三轮阻断 3：内部 GPU disposer 抛错不中断收敛（真实资源故障注入）', () => {
  /** 带真实纹理的 gltf：geometry + material(map) + texture 三层 GPU 资源 */
  function makeTexturedGltf(): { gltf: GLTF; geometry: THREE.BufferGeometry; material: THREE.Material; texture: THREE.Texture } {
    const gltf = makeGltf();
    const mesh = gltf.scene.children[0] as THREE.Mesh;
    const texture = new THREE.Texture();
    mesh.material.map = texture;
    return { gltf, geometry: mesh.geometry, material: mesh.material, texture };
  }

  it('geometry.dispose 抛错：dispose 不抛错、material/texture 仍释放、完成标记真实置位（修复前遍历中断假报成功）', async () => {
    const { gltf, geometry, material, texture } = makeTexturedGltf();
    const geometrySpy = vi.spyOn(geometry, 'dispose').mockImplementationOnce(() => {
      throw new Error('模拟几何体释放崩溃');
    });
    const materialSpy = vi.spyOn(material, 'dispose');
    const textureSpy = vi.spyOn(texture, 'dispose');

    const cache = new ContentCache({ loader: vi.fn(async () => gltf) });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    await lease.content; // entry.gltf 就绪

    // 故障注入走真实内部路径（修复前 mock 整个 ContentCache.dispose() 恰好
    // 避开该路径，外层假报成功）：disposeGltf 逐资源 best-effort —— geometry
    // 释放失败不中断 material/texture 释放；dispose 恒完整收敛不抛错，
    // 「disposed=true」恒等于全部条目真实执行过清理
    expect(() => cache.dispose()).not.toThrow();
    expect(geometrySpy).toHaveBeenCalledTimes(1); // 抛错被 best-effort 吞掉
    expect(materialSpy).toHaveBeenCalledTimes(1); // 其余资源仍释放
    expect(textureSpy).toHaveBeenCalledTimes(1);
    expect(cache.isReady('h')).toBe(false); // 条目已收尾移出
    // 完成标记后置：二次 dispose no-op，不再触碰任何资源
    cache.dispose();
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(() => cache.acquire('h', BYTES, { format: 'glb' })).toThrow('缓存已释放');
  });

  it('geometry/material/texture dispose 全部抛错：逐资源独立 best-effort，dispose 仍完整收敛', async () => {
    const { gltf, geometry, material, texture } = makeTexturedGltf();
    vi.spyOn(geometry, 'dispose').mockImplementationOnce(() => {
      throw new Error('模拟几何体释放崩溃');
    });
    vi.spyOn(material, 'dispose').mockImplementationOnce(() => {
      throw new Error('模拟材质释放崩溃');
    });
    vi.spyOn(texture, 'dispose').mockImplementationOnce(() => {
      throw new Error('模拟纹理释放崩溃');
    });

    const cache = new ContentCache({ loader: vi.fn(async () => gltf) });
    const lease = cache.acquire('h', BYTES, { format: 'glb' });
    await lease.content;

    expect(() => cache.dispose()).not.toThrow();
    expect(cache.isReady('h')).toBe(false);
    cache.dispose(); // 完成标记已置位：二次 no-op
  });

  it('loader 在途条目 dispose 后 settle：收尾仍逐资源 best-effort，条目不残留（修复前 torn 先置位，条目从清理路径消失）', async () => {
    const resolvers: ((gltf: GLTF) => void)[] = [];
    const loader = vi.fn(() => new Promise<GLTF>((resolve) => resolvers.push(resolve)));
    const cache = new ContentCache({ loader });
    cache.acquire('h', BYTES, { format: 'glb' });
    cache.dispose(); // 在途条目：保留到 settle，由 settle 处理器独立收尾
    const gltf = makeGltf();
    vi.spyOn(geometryOf(gltf), 'dispose').mockImplementationOnce(() => {
      throw new Error('模拟几何体释放崩溃');
    });

    resolvers[0]!(gltf);
    await flush();
    // settle 收尾吞掉抛错、torn 后置：条目完整移出（不因抛错留下半清理状态）
    expect(cache.has('h')).toBe(false);
  });
});
