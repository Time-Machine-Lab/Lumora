import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import { createCameraObject, createGroupObject, createPrimitiveObject } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { isSceneObject } from '../src/scene/types';
import type { Project, SceneObjectData, TransformData } from '../src/scene/types';

/**
 * P2 EditorState 边界测试（TML-57 批准方案，硬约束 4）：
 * - transition 接受 Project | null（close/reset/dispose 全覆盖）；
 * - revision 只由当前应用状态单调生成；
 * - ObjectType 运行时成员校验（isSceneObject）；
 * - 结构字段（id/type）不可经通用属性更新修改；
 * - dispose 终态：写入拒绝、视图 setter 静默、事件总线关闭。
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

/** 项目级损坏：仅用于验证 openProject 同步拒绝 */
function corrupt(apply: (project: Project) => void): Project {
  const project = createSampleProject();
  apply(project);
  return project;
}

describe('P2 硬约束 4：EditorState 边界完整（dispose 终态）', () => {
  it('T6 dispose 终态：openProject/reset 抛「编辑器已释放」，一切写入以「未打开项目」拒绝', () => {
    const editor = makeEditor();
    editor.dispose();

    expect(() => editor.openProject(createSampleProject())).toThrow('编辑器已释放');
    expect(() => editor.reset()).toThrow('编辑器已释放');
    expect(() => editor.dispose()).not.toThrow(); // 幂等

    const asset = {
      id: 'asset-x',
      kind: 'gltf' as const,
      name: 'x.glb',
      mime: 'model/gltf-binary',
      hash: 'hash-x',
      size: 1,
      source: 'file' as const,
      storageRef: '',
      createdAt: '2026-01-01',
    };
    const mutators: (() => Result<unknown>)[] = [
      () => editor.addScene('场景'),
      () => editor.setActiveScene('scene-1'),
      () => editor.setActiveCamera('sample-camera'),
      () => editor.addObject(createGroupObject()),
      () => editor.deleteSelection(),
      () => editor.duplicateSelection(),
      () => editor.setParent('sample-cube', null),
      () => editor.setTransform('sample-cube', MOVED),
      () => editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: 'x' }), '改名'),
      () => editor.setVisible(['sample-cube'], false),
      () => editor.setLocked(['sample-cube'], true),
      () => editor.registerAsset(asset),
      () =>
        editor.importModel(asset, {
          id: 'obj-x',
          type: 'model',
          name: 'x',
          parentId: null,
          transform: MOVED,
          visible: true,
          locked: false,
        }),
    ];
    for (const mutate of mutators) {
      const result = mutate();
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toBe('未打开项目');
    }
    // 撤销/重做：历史已被清空，同样拒绝（此时以「没有可撤销/重做的操作」报告）
    expect(editor.undo().ok).toBe(false);
    expect(editor.redo().ok).toBe(false);
    editor.beginTransform(); // 只读捕获，不抛
    expect(editor.commitTransform('sample-cube', MOVED).ok).toBe(false);
  });

  it('T6 视图 setter 与选择在 dispose 后静默 no-op：不抛错、不发事件', () => {
    const editor = makeEditor();
    let viewEmissions = 0;
    let selectionEmissions = 0;
    const unsubView = editor.events.on('view:changed', () => {
      viewEmissions += 1;
    });
    const unsubSelection = editor.events.on('selection:changed', () => {
      selectionEmissions += 1;
    });

    editor.dispose();
    // dispose 自身发过一次 close 事件（project/selection/view 原子置空）
    expect(editor.getView().viewMode).toBe('director');
    expect(viewEmissions).toBe(1);
    expect(selectionEmissions).toBe(1);
    viewEmissions = 0;
    selectionEmissions = 0;

    editor.setTransformMode('rotate');
    editor.setTransformSpace('world');
    editor.setViewMode({ cameraObjectId: 'sample-camera' });
    editor.setGuide('thirds', false);
    editor.setSelection(['sample-cube']);
    expect(viewEmissions).toBe(0);
    expect(selectionEmissions).toBe(0);
    expect(editor.getView().transformMode).toBe('translate');
    expect(editor.getSelection()).toEqual([]);
    unsubView.dispose();
    unsubSelection.dispose();
  });

  it('T7 原子视图：project:changed 回调内视图已由下一个项目推导（删除机位 → 导演视图）', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-camera']);
    editor.setViewMode({ cameraObjectId: 'sample-camera' });
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: 'sample-camera' });

    const order: string[] = [];
    editor.events.on('project:changed', () => {
      order.push('project:changed');
      // 视图与项目在同一 transition 内就位：观察者不会看到「新项目 + 旧机位」中间态
      expect(editor.getView().viewMode).toBe('director');
    });
    editor.events.on('selection:changed', () => {
      order.push('selection:changed');
      expect(editor.getSelection()).toEqual([]);
    });
    editor.events.on('view:changed', ({ view }) => {
      order.push('view:changed');
      expect(view.viewMode).toBe('director');
    });
    editor.events.on('history:changed', () => {
      order.push('history:changed');
    });

    ok(editor.deleteSelection());
    expect(order).toEqual(['project:changed', 'selection:changed', 'view:changed', 'history:changed']);
    expect(editor.getView().viewMode).toBe('director');
  });

  it('T7 原子视图：场景切换后机位不可达 → 提交路径内回退导演视图', () => {
    const editor = makeEditor();
    const aSceneId = editor.getProject()!.activeSceneId;
    const bSceneId = ok(editor.addScene('场景 B'));
    const camBId = ok(editor.addObject(createCameraObject('B 相机')));
    editor.setViewMode({ cameraObjectId: camBId });
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: camBId });

    let derivedDirector = 0;
    const unsubscribe = editor.events.on('view:changed', ({ view }) => {
      if (view.viewMode === 'director') derivedDirector += 1;
    });
    ok(editor.setActiveScene(aSceneId));
    // 切回 A：B 机位不可达，transition 内推导回退，视图事件与提交原子一致
    expect(editor.getView().viewMode).toBe('director');
    expect(derivedDirector).toBe(1);
    unsubscribe.dispose();
  });

  it('T8 结构标识（id/type）不可经通用属性更新修改；普通属性更新不受影响', () => {
    const editor = makeEditor();
    expect(
      editor.updateObjectProps('sample-cube', (o) => ({ ...o, id: 'stolen' }), '改名').ok,
    ).toBe(false);
    expect(
      editor.updateObjectProps('sample-cube', (o) => ({ ...o, type: 'group' }), '改类型').ok,
    ).toBe(false);
    // 数据保持不变
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.type).toBe('primitive');
    // 普通属性（名称/可见性）仍可更新并进入历史
    ok(editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '改名立方体' }), '改名'));
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe('改名立方体');
    ok(editor.undo());
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe('立方体');
  });

  it('T8 ObjectType 运行时成员校验：isSceneObject 拒绝未知类型，addObject 同步拒绝', () => {
    const plain = (type: string) => ({
      id: 'x',
      type,
      name: 'n',
      parentId: null,
      transform: MOVED,
      visible: true,
      locked: false,
    });
    expect(isSceneObject(plain('mesh'))).toBe(false);
    expect(isSceneObject(plain('unknown'))).toBe(false);
    expect(isSceneObject(plain('group'))).toBe(true);
    expect(isSceneObject(null)).toBe(false);

    const editor = makeEditor();
    expect(editor.addObject(plain('mesh') as SceneObjectData).ok).toBe(false);
    expect(editor.addObject(createGroupObject()).ok).toBe(true);
  });
});

describe('P2 硬约束 4：validateProject 边界', () => {
  it('openProject 拒绝悬空父级与父子循环，编辑器保持未打开', () => {
    const editor = new SceneEditor();
    expect(() =>
      editor.openProject(corrupt((p) => (p.objects[1]!.parentId = 'ghost'))),
    ).toThrow(/对象缺少父级/);
    expect(() =>
      editor.openProject(
        corrupt((p) => {
          p.objects[0]!.parentId = 'sample-cube';
          p.objects[1]!.parentId = 'sample-group';
        }),
      ),
    ).toThrow(/父子关系存在循环/);
    expect(editor.getProject()).toBeNull();
  });

  it('openProject 拒绝根列表不一致：孤立根、非法引用、重复挂载', () => {
    const editor = new SceneEditor();
    expect(() =>
      editor.openProject(
        corrupt((p) => {
          p.scenes[0]!.rootObjectIds = p.scenes[0]!.rootObjectIds.filter((id) => id !== 'sample-light');
        }),
      ),
    ).toThrow(/孤立根对象/);
    expect(() =>
      editor.openProject(corrupt((p) => p.scenes[0]!.rootObjectIds.push('ghost'))),
    ).toThrow(/场景根列表引用非法/);
    expect(() =>
      editor.openProject(corrupt((p) => p.scenes[0]!.rootObjectIds.push('sample-camera'))),
    ).toThrow(/根对象重复挂载/);
    expect(editor.getProject()).toBeNull();
  });

  it('openProject 拒绝活动场景缺失与活动机位非法（非相机/不可达）', () => {
    const editor = new SceneEditor();
    expect(() => editor.openProject(corrupt((p) => (p.activeSceneId = 'ghost')))).toThrow(
      /活动场景不存在/,
    );
    expect(() =>
      editor.openProject(corrupt((p) => (p.scenes[0]!.activeCameraId = 'sample-ground'))),
    ).toThrow(/活动机位不存在或不属于活动场景/);
    // 机位属于其他场景：活动场景不可达 → 拒绝
    expect(() =>
      editor.openProject(
        corrupt((p) => {
          const camBId = 'camera-b';
          p.objects.push({
            id: camBId,
            type: 'camera',
            name: 'B 相机',
            parentId: null,
            transform: MOVED,
            visible: true,
            locked: false,
            camera: { projection: 'perspective', focalLength: 50, fov: 40, sensorWidth: 36, sensorHeight: 24, near: 0.1, far: 200, aspect: null },
          });
          p.scenes.push({ id: 'scene-2', name: '场景 B', rootObjectIds: [camBId], activeCameraId: null });
          p.scenes[0]!.activeCameraId = camBId;
        }),
      ),
    ).toThrow(/活动机位不存在或不属于活动场景/);
    expect(editor.getProject()).toBeNull();
  });
});

describe('P2 硬约束 4：transition(null) 覆盖 close/reset/dispose', () => {
  it('reset 原子置空：project/selection/view 一次就位，事件序完整', () => {
    const editor = makeEditor();
    ok(editor.addObject(createGroupObject()));
    editor.setSelection(['sample-cube']);
    editor.setTransformMode('rotate');

    const order: string[] = [];
    const unsubProject = editor.events.on('project:changed', ({ project }) => {
      order.push('project:changed');
      expect(project).toBeNull();
    });
    const unsubSelection = editor.events.on('selection:changed', () => order.push('selection:changed'));
    const unsubView = editor.events.on('view:changed', ({ view }) => {
      order.push('view:changed');
      expect(view.transformMode).toBe('translate'); // 已复位默认视图
    });
    const unsubHistory = editor.events.on('history:changed', () => order.push('history:changed'));

    editor.reset();
    expect(editor.getProject()).toBeNull();
    expect(editor.getSelection()).toEqual([]);
    expect(editor.getView()).toEqual({
      transformMode: 'translate',
      transformSpace: 'local',
      viewMode: 'director',
      guides: { thirds: true, safeFrame: true },
    });
    expect(order).toEqual(['project:changed', 'selection:changed', 'view:changed', 'history:changed']);
    unsubProject.dispose();
    unsubSelection.dispose();
    unsubView.dispose();
    unsubHistory.dispose();
    // reset 后编辑器可重新打开
    editor.openProject(createSampleProject());
    expect(editor.getProject()!.name).toBe('示例项目');
  });

  it('dispose 原子关闭：project/selection/view 置空、历史清空、事件总线不再有处理器', () => {
    const editor = makeEditor();
    ok(editor.addObject(createGroupObject()));
    editor.setViewMode({ cameraObjectId: 'sample-camera' });

    const seen: string[] = [];
    const unsubProject = editor.events.on('project:changed', ({ project }) => {
      if (project === null) seen.push('project:changed');
    });
    const unsubSelection = editor.events.on('selection:changed', () => seen.push('selection:changed'));
    const unsubView = editor.events.on('view:changed', ({ view }) => {
      seen.push('view:changed');
      expect(view.viewMode).toBe('director');
    });
    const unsubHistory = editor.events.on('history:changed', () => seen.push('history:changed'));

    editor.dispose();
    // dispose 原子关闭：project/selection/view 一次置空（历史已清空，无 history:changed）
    expect(seen).toEqual(['project:changed', 'selection:changed', 'view:changed']);
    expect(editor.getProject()).toBeNull();
    expect(editor.getSelection()).toEqual([]);
    expect(editor.getView().viewMode).toBe('director');
    expect(editor.getHistoryState().canUndo).toBe(false);
    // 关闭事件：现有订阅全部解除
    const handlerCount = editor.events.handlerCount;
    unsubProject.dispose();
    unsubSelection.dispose();
    unsubView.dispose();
    unsubHistory.dispose();
    expect(handlerCount).toBe(0);
  });
});

describe('P2 边界：revision 只由当前应用状态单调生成', () => {
  it('transition 应用即盖章：提交/撤销/重做各自单调递增，undo 后 redo 再取新值', () => {
    const editor = makeEditor();
    const rev0 = editor.getProject()!.revision;
    ok(editor.addObject(createPrimitiveObject('box')));
    const rev1 = editor.getProject()!.revision;
    expect(rev1).toBe(rev0 + 1);
    ok(editor.undo());
    const rev2 = editor.getProject()!.revision;
    expect(rev2).toBeGreaterThan(rev1);
    ok(editor.redo());
    const rev3 = editor.getProject()!.revision;
    expect(rev3).toBeGreaterThan(rev2);
    // reset 置空后重新打开：从新项目的持久化 revision 起步
    editor.reset();
    const persisted = createSampleProject();
    persisted.revision = 7;
    editor.openProject(persisted);
    expect(editor.getProject()!.revision).toBe(7);
    expect(editor.getProject()).toBe(persisted); // 打开引用保持（宿主快照契约）
    ok(editor.addObject(createGroupObject()));
    expect(editor.getProject()!.revision).toBe(8);
  });
});

describe('P2 边界：提交路径数据不变量（validateProject 兼容）', () => {
  it('层级操作/复制/删除后项目始终通过结构校验（每次 transition 防御性重验）', () => {
    const editor = makeEditor();
    ok(editor.setParent('sample-cube', null));
    ok(editor.setParent('sample-cube', 'sample-group'));
    editor.setSelection(['sample-cube']);
    ok(editor.duplicateSelection());
    editor.setSelection(['sample-group']);
    ok(editor.deleteSelection());
    ok(editor.undo());
    ok(editor.undo());
    const project = editor.getProject()!;
    // 全部提交路径均由 transition 校验通过：此处确认最终状态自洽
    const roots = new Set(project.scenes.flatMap((s) => s.rootObjectIds));
    for (const object of project.objects) {
      if (object.parentId === null) expect(roots.has(object.id)).toBe(true);
    }
    expect(roots.size).toBe(project.scenes.reduce((n, s) => n + s.rootObjectIds.length, 0));
  });
});

describe('P2 边界：updateObjectProps 结构字段防御', () => {
  it('parentId 变更仍走专属入口：通用入口拒绝', () => {
    const editor = makeEditor();
    const result = editor.updateObjectProps('sample-cube', (o) => ({ ...o, parentId: null }), '层级');
    expect(result.ok).toBe(false);
    expect((result as { error: Error }).error.message).toBe('层级变更请使用拖拽或层级操作');
  });
});
