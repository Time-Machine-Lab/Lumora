import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result, ViewMode, ViewState } from '../src/editor/scene-editor';
import { TypedEventEmitter } from '../src/events/typed-event-emitter';
import { deepFreeze } from '../src/scene/immutable';
import { createCameraObject, createGroupObject, createModelObject } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { getDescendantIds } from '../src/scene/scene-graph';
import type { AssetData, CameraData, Project, SceneObjectData, TransformData } from '../src/scene/types';

/**
 * R6 对抗测试（TML-57 第六轮复审，目标 HEAD 23793a1 上必须失败）：
 * - P0 状态所有权与原子性：所有公开 ingress 无条件 clone 为编辑器自有数据，
 *   再执行分类型 schema、交叉引用校验与深冻结（禁止 Object.isFrozen 推断深冻）；
 *   ViewState 参数/getter/事件载荷全部复制；openProject 局部完成 clone/校验/冻结后
 *   才一次提交；事件在每个 handler 前检查终态。
 * - P1 场景图性能：深度链 getDescendantIds 耗时按规模增长比（非单一墙钟阈值）。
 */

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value as T;
}

const MOVED: TransformData = { position: [1, 1, 1], rotation: [0, 0, 0], scale: [1, 1, 1] };

function group(id: string, parentId: string | null = null): SceneObjectData {
  return { id, type: 'group', name: id, parentId, transform: MOVED, visible: true, locked: false };
}

function cameraObject(id: string, aspect?: unknown, withPayload = true): SceneObjectData {
  return {
    id,
    type: 'camera',
    name: 'C',
    parentId: null,
    transform: MOVED,
    visible: true,
    locked: false,
    ...(withPayload
      ? {
          camera: {
            projection: 'perspective',
            focalLength: 50,
            fov: 39.6,
            sensorWidth: 36,
            sensorHeight: 24,
            near: 0.1,
            far: 1000,
            // 数组对是「历史非法形态」的对抗输入，经 unknown 传递后显式断言类型
            aspect: (aspect === undefined ? null : aspect) as number | null,
          } as CameraData,
        }
      : {}),
  };
}

function lightObject(id: string, withPayload = true): SceneObjectData {
  return {
    id,
    type: 'light',
    name: 'L',
    parentId: null,
    transform: MOVED,
    visible: true,
    locked: false,
    ...(withPayload
      ? { light: { kind: 'directional' as const, color: '#ffffff', intensity: 1 } }
      : {}),
  };
}

function modelObject(id: string, assetId?: string): SceneObjectData {
  return {
    id,
    type: 'model',
    name: 'M',
    parentId: null,
    transform: MOVED,
    visible: true,
    locked: false,
    ...(assetId !== undefined ? { assetId } : {}),
  };
}

function baseAsset(id: string, name: string): AssetData {
  return {
    id,
    kind: 'gltf',
    name,
    mime: 'model/gltf-binary',
    hash: 'h'.repeat(64),
    size: 1,
    source: 'file',
    storageRef: '',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

/** 深度链项目：n0 根，n1..n(depth-1) 依次为父链子节点 */
function chainProject(depth: number): Project {
  const objects: SceneObjectData[] = [];
  for (let i = 0; i < depth; i++) objects.push(group(`n${i}`, i === 0 ? null : `n${i - 1}`));
  return {
    uri: 'test://chain',
    name: 'chain',
    schemaVersion: 2,
    createdAt: '2026-01-01T00:00:00Z',
    revision: 1,
    settings: { fps: 60, aspect: [16, 9] },
    activeSceneId: 's1',
    scenes: [{ id: 's1', name: 'S', rootObjectIds: ['n0'], activeCameraId: null }],
    objects,
    assets: [],
  };
}

describe('R6 深冻结：不信任 Object.isFrozen（浅冻绕过）', () => {
  it('浅冻结对象传入 deepFreeze：嵌套结构仍被递归冻结', () => {
    const inner = { position: [1, 2, 3], label: 'x' };
    const shallow = Object.freeze({ inner });
    expect(Object.isFrozen(inner)).toBe(false); // 前置：浅冻确实留下未冻结嵌套
    deepFreeze(shallow);
    expect(Object.isFrozen(inner)).toBe(true);
    expect(Object.isFrozen(inner.position)).toBe(true);
  });

  it('含循环引用的对象 deepFreeze 有环安全（不因递归爆栈）', () => {
    const cyc: { self?: unknown } = { self: undefined };
    cyc.self = cyc;
    expect(() => deepFreeze(cyc)).not.toThrow();
    expect(Object.isFrozen(cyc)).toBe(true);
  });
});

describe('R6 公开 ingress 无条件克隆（浅冻别名对抗）', () => {
  it('addObject 浅冻结对象：调用方改嵌套数组，编辑器状态不受影响', () => {
    const editor = makeEditor();
    const object = createGroupObject('G');
    Object.freeze(object); // 仅外层冻结——嵌套 transform.position 未冻结
    const id = ok(editor.addObject(object));
    object.transform.position[0] = 99; // 调用方事后改动
    const stored = editor.getProject()!.objects.find((o) => o.id === id)!;
    expect(stored.transform.position[0]).not.toBe(99);
    expect(stored.transform.position[0]).toBe(0);
  });

  it('setTransform 浅冻结 transform：调用方改 position 数组，编辑器不受影响', () => {
    const editor = makeEditor();
    const transform: TransformData = { position: [5, 5, 5], rotation: [0, 0, 0], scale: [1, 1, 1] };
    Object.freeze(transform);
    ok(editor.setTransform('sample-group', transform));
    transform.position[0] = 99;
    const stored = editor.getProject()!.objects.find((o) => o.id === 'sample-group')!;
    expect(stored.transform.position[0]).toBe(5);
  });

  it('commitTransform 浅冻结 transform：调用方事后改动不影响编辑器', () => {
    const editor = makeEditor();
    const transform: TransformData = { position: [7, 7, 7], rotation: [0, 0, 0], scale: [1, 1, 1] };
    Object.freeze(transform);
    ok(editor.commitTransform('sample-group', transform));
    transform.position[0] = 99;
    const stored = editor.getProject()!.objects.find((o) => o.id === 'sample-group')!;
    expect(stored.transform.position[0]).toBe(7);
  });

  it('updateObjectProps 返回对象嵌入调用方嵌套对象：编辑器克隆为自有数据（不就地冻结调用方对象）', () => {
    const editor = makeEditor();
    const evil = { color: 'red' }; // 调用方持有的嵌套对象
    ok(editor.updateObjectProps('sample-ground', (o) => ({ ...o, material: evil }), '改材质'));
    expect(Object.isFrozen(evil)).toBe(false); // RED：现实现就地冻结调用方对象
    evil.color = 'blue';
    const stored = editor.getProject()!.objects.find((o) => o.id === 'sample-ground')!;
    expect(stored.material?.color).toBe('red');
  });

  it('registerAsset 浅冻结资源：调用方改嵌套 parts，编辑器不受影响', () => {
    const editor = makeEditor();
    const asset = Object.freeze({
      ...baseAsset('asset-1', 'a.glb'),
      parts: [{ path: 'tex.png', mime: 'image/png', payload: 'AA==' }],
    }) as AssetData;
    expect(editor.registerAsset(asset).ok).toBe(true);
    (asset.parts![0] as { path: string }).path = 'hacked.png'; // 嵌套可写 → 静默泄漏
    const stored = editor.getProject()!.assets.find((a) => a.id === 'asset-1')!;
    expect(stored.parts![0].path).toBe('tex.png');
  });

  it('importModel 浅冻结模型对象/资源：调用方事后改动不影响编辑器', () => {
    const editor = makeEditor();
    const asset = baseAsset('asset-i1', 'm.glb');
    const object = createModelObject('asset-i1', 'M');
    Object.freeze(object.transform); // 浅冻 transform：position 数组仍可写
    const created = ok(editor.importModel(asset, object));
    object.transform.position[0] = 99; // 当前实现：deepFreeze 跳过已冻 transform → 泄漏
    asset.name = 'renamed.glb';
    const stored = editor.getProject()!.objects.find((o) => o.id === created)!;
    const storedAsset = editor.getProject()!.assets.find((a) => a.id === 'asset-i1')!;
    expect(stored.transform.position[0]).toBe(0);
    expect(storedAsset.name).toBe('m.glb');
  });
});

describe('R6 ViewState 复制/规范化（viewMode 别名对抗）', () => {
  function addCamera(editor: SceneEditor): string {
    return ok(editor.addObject(createCameraObject('Cam')));
  }

  it('setViewMode 参数：调用方事后改传入的 mode 对象，编辑器视图不受影响', () => {
    const editor = makeEditor();
    const camId = addCamera(editor);
    const mode: ViewMode = { cameraObjectId: camId };
    editor.setViewMode(mode);
    mode.cameraObjectId = 'ghost';
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: camId });
  });

  it('getView() 返回的 viewMode 是副本：改返回值不影响编辑器', () => {
    const editor = makeEditor();
    const camId = addCamera(editor);
    editor.setViewMode({ cameraObjectId: camId });
    const returned = editor.getView();
    (returned.viewMode as { cameraObjectId: string }).cameraObjectId = 'ghost';
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: camId });
  });

  it('view:changed 事件载荷的 viewMode 是副本：改载荷不影响编辑器', () => {
    const editor = makeEditor();
    const camId = addCamera(editor);
    let payloadView: ViewState | null = null;
    editor.events.on('view:changed', (p) => {
      payloadView = p.view;
    });
    editor.setViewMode({ cameraObjectId: camId });
    expect(payloadView).not.toBeNull();
    (payloadView!.viewMode as { cameraObjectId: string }).cameraObjectId = 'ghost';
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: camId });
  });
});

describe('R6 分类型 schema 与资源交叉引用', () => {
  it('camera 对象缺少 camera 载荷：拒绝', () => {
    const editor = makeEditor();
    const result = editor.addObject(cameraObject('c1', undefined, false));
    expect(result.ok).toBe(false);
  });

  it('camera.aspect 为数值（number|null 联合的合法值）：接受', () => {
    const editor = makeEditor();
    const result = editor.addObject(cameraObject('c2', 1.5));
    expect(result.ok).toBe(true);
  });

  it('camera.aspect 为数组对（历史非法形态）：拒绝', () => {
    const editor = makeEditor();
    const result = editor.addObject(cameraObject('c3', [1.5, 1]));
    expect(result.ok).toBe(false);
  });

  it('light 对象缺少 light 载荷：拒绝', () => {
    const editor = makeEditor();
    const result = editor.addObject(lightObject('l1', false));
    expect(result.ok).toBe(false);
  });

  it('model 对象缺少 assetId：拒绝', () => {
    const editor = makeEditor();
    const result = editor.addObject(modelObject('m1'));
    expect(result.ok).toBe(false);
  });

  it('model.assetId 指向不存在的资源（交叉引用）：拒绝', () => {
    const editor = makeEditor();
    const result = editor.addObject(modelObject('m2', 'ghost'));
    expect(result.ok).toBe(false);
  });

  it('model.assetId 指向已注册资源：接受（不误伤合法引用）', () => {
    const editor = makeEditor();
    const asset = baseAsset('asset-ok', 'ok.glb');
    expect(editor.registerAsset(asset).ok).toBe(true);
    const result = editor.addObject(modelObject('m3', 'asset-ok'));
    expect(result.ok).toBe(true);
  });
});

describe('R6 所有场景 activeCamera 可达性', () => {
  it('非活动场景的 activeCameraId 指向本场景不可达对象：拒绝', () => {
    const editor = new SceneEditor();
    const project = structuredClone(createSampleProject());
    project.scenes.push({
      id: 'scene-2',
      name: 'S2',
      rootObjectIds: [],
      activeCameraId: 'sample-camera', // 属于 scene-1，scene-2 不可达
    });
    expect(() => editor.openProject(project)).toThrow(/机位|activeCamera/i);
  });

  it('非活动场景的 activeCameraId 在本场景可达：接受', () => {
    const editor = new SceneEditor();
    const project = structuredClone(createSampleProject());
    project.objects.push(group('s2-root'), { ...cameraObject('s2-cam'), parentId: 's2-root' });
    project.scenes.push({
      id: 'scene-2',
      name: 'S2',
      rootObjectIds: ['s2-root'],
      activeCameraId: 's2-cam',
    });
    expect(() => editor.openProject(project)).not.toThrow();
  });
});

describe('R6 openProject 原子提交', () => {
  it('DataCloneError（不可克隆字段）：history/session/项目均不被破坏', () => {
    const editor = makeEditor();
    const before = editor.getProject()!.objects.length;
    ok(editor.addObject(createGroupObject('G'))); // 使 history 有可撤销项
    const tokenBefore = editor.getSessionToken();
    const bad = structuredClone(createSampleProject()) as Project & { callback?: unknown };
    bad.callback = () => undefined; // structuredClone 不可克隆 → DataCloneError
    let thrown: unknown;
    try {
      editor.openProject(bad);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DOMException | undefined)?.name).toBe('DataCloneError');
    expect(editor.getSessionToken()).toBe(tokenBefore);
    expect(editor.getProject()!.objects.length).toBe(before + 1);
    ok(editor.undo());
    expect(editor.getProject()!.objects.length).toBe(before);
  });

  it('含循环引用的输入 openProject 不爆栈、不残留部分状态', () => {
    const editor = makeEditor();
    const cyc = structuredClone(createSampleProject()) as Project & { loop?: unknown };
    cyc.loop = cyc;
    expect(() => editor.openProject(cyc as unknown as Project)).not.toThrow();
    expect(editor.getProject()!.objects.length).toBe(createSampleProject().objects.length);
  });
});

describe('R6 事件派发：每个 handler 前检查终态', () => {
  it('首个 handler 内 dispose：剩余监听器与 anyHandler 不再执行', () => {
    const emitter = new TypedEventEmitter<{ x: { n: number } }>();
    const calls: string[] = [];
    emitter.on('x', () => {
      calls.push('a');
      emitter.dispose();
    });
    emitter.on('x', () => calls.push('b'));
    emitter.onAny(() => calls.push('any'));
    emitter.emit('x', { n: 1 });
    expect(calls).toEqual(['a']);
  });

  it('editor 事件：project:changed 首个监听器内 dispose，其余监听器不执行', () => {
    const editor = makeEditor();
    const calls: string[] = [];
    editor.events.on('project:changed', () => {
      calls.push('a');
      editor.dispose();
    });
    editor.events.on('project:changed', () => calls.push('b'));
    editor.events.onAny(() => calls.push('any'));
    ok(editor.addObject(createGroupObject('G')));
    expect(calls).toEqual(['a']);
  });
});

describe('R6 场景图性能：父级引用扫描次数随规模近似线性（操作计数）', () => {
  /** 用读取计数代理 parentId：把「每层全量 filter 扫描」这个 O(n²) 因子数出来 */
  function countingProject(depth: number): { project: Project; reads: () => number } {
    const project = chainProject(depth);
    let reads = 0;
    for (const object of project.objects) {
      const real = object.parentId;
      Object.defineProperty(object, 'parentId', {
        get() {
          reads += 1;
          return real;
        },
        enumerable: true,
        configurable: true,
      });
    }
    return { project, reads: () => reads };
  }

  it('getDescendantIds：400→800→1600 读取数增长比 < 6（线性≈4，每层 filter 为 ≈16）', () => {
    const r400 = countingProject(400);
    const r800 = countingProject(800);
    const r1600 = countingProject(1600);
    expect(getDescendantIds(r400.project, 'n0').length).toBe(399);
    expect(getDescendantIds(r800.project, 'n0').length).toBe(799);
    expect(getDescendantIds(r1600.project, 'n0').length).toBe(1599);
    const c400 = r400.reads();
    const c800 = r800.reads();
    const c1600 = r1600.reads();
    expect(c1600 / c400).toBeLessThan(6); // 线性实现 4 倍；现实现（每层 filter）≈ 16 倍
    expect(c800 / c400).toBeLessThan(6);
    expect(c1600).toBeLessThan(100_000); // 线性 ≈ 2·n；现实现 = n²（2.56M）
  });

  it('深层链（500）删除末梢节点：正确移除且可撤销', () => {
    const editor = new SceneEditor();
    editor.openProject(chainProject(500));
    editor.setSelection(['n499']);
    const result = editor.deleteSelection();
    expect(result.ok).toBe(true);
    expect(editor.getProject()!.objects.length).toBe(499);
    expect(editor.getProject()!.objects.some((o) => o.id === 'n499')).toBe(false);
    ok(editor.undo());
    expect(editor.getProject()!.objects.length).toBe(500);
  });
});
