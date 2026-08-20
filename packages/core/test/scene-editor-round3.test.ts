import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import { createCameraObject, createGroupObject, createPrimitiveObject } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { findObject } from '../src/scene/scene-graph';
import type { TransformData } from '../src/scene/types';

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

describe('SceneEditor 第三轮：场景归属校验与视图回退（P-9）', () => {
  it('setActiveCamera 拒绝活动场景外的机位；同场景内设置成功并随撤销恢复', () => {
    const editor = makeEditor();
    const aSceneId = editor.getProject()!.activeSceneId;
    const bSceneId = ok(editor.addScene('场景 B'));
    const camBId = ok(editor.addObject(createCameraObject('B 相机')));

    // 活动场景是 B：A 的机位不可设置为活动机位
    expect(editor.setActiveCamera('sample-camera').ok).toBe(false);

    // 切回 A：B 的机位不可设置
    ok(editor.setActiveScene(aSceneId));
    expect(editor.setActiveCamera(camBId).ok).toBe(false);
    expect(editor.getProject()!.scenes.find((s) => s.id === aSceneId)!.activeCameraId).toBe('sample-camera');

    // 同场景内设置成功；撤销恢复原机位
    ok(editor.setActiveScene(bSceneId));
    ok(editor.setActiveCamera(camBId));
    expect(editor.getProject()!.scenes.find((s) => s.id === bSceneId)!.activeCameraId).toBe(camBId);
    ok(editor.undo());
    expect(editor.getProject()!.scenes.find((s) => s.id === bSceneId)!.activeCameraId).toBeNull();
  });

  it('setViewMode 直接校验：机位不属于活动场景或不是摄像机 → 回退导演视图', () => {
    const editor = makeEditor();
    const aSceneId = editor.getProject()!.activeSceneId;
    const bSceneId = ok(editor.addScene('场景 B'));
    const camBId = ok(editor.addObject(createCameraObject('B 相机')));
    const sphereId = ok(editor.addObject(createPrimitiveObject('sphere', 'B 球')));
    // addScene 后活动场景是 B：切回 A，B 的机位即不可达
    ok(editor.setActiveScene(aSceneId));

    // 活动场景 A：B 的机位不可达 → 回退；非摄像机对象 → 回退
    editor.setViewMode({ cameraObjectId: camBId });
    expect(editor.getView().viewMode).toBe('director');
    editor.setViewMode({ cameraObjectId: sphereId });
    expect(editor.getView().viewMode).toBe('director');
    // 不存在的 id → 回退
    editor.setViewMode({ cameraObjectId: 'no-such-id' });
    expect(editor.getView().viewMode).toBe('director');

    // 活动场景 B：B 机位可设置；重复设置不产生事件
    ok(editor.setActiveScene(bSceneId));
    editor.setViewMode({ cameraObjectId: camBId });
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: camBId });
    let emissions = 0;
    const unsubscribe = editor.events.on('view:changed', () => {
      emissions += 1;
    });
    editor.setViewMode({ cameraObjectId: camBId });
    expect(emissions).toBe(0);
    unsubscribe.dispose();

    // A 的机位在 B 中不可达
    editor.setViewMode({ cameraObjectId: 'sample-camera' });
    expect(editor.getView().viewMode).toBe('director');
  });
});

describe('SceneEditor 第三轮：原子应用与事件序（P-9）', () => {
  it('提交按固定顺序发 project:changed → selection:changed → history:changed，观察者不见跨场景中间态', () => {
    const editor = makeEditor();
    const order: string[] = [];
    editor.events.on('project:changed', ({ project }) => {
      order.push('project:changed');
      // 项目已含新场景且选择已过滤为空：观察者不会看到「新项目 + 旧场景选择」
      expect(project!.scenes.some((s) => s.name === '场景 B')).toBe(true);
      expect(editor.getSelection()).toEqual([]);
    });
    editor.events.on('selection:changed', () => {
      order.push('selection:changed');
      expect(editor.getProject()!.scenes.some((s) => s.name === '场景 B')).toBe(true);
    });
    editor.events.on('history:changed', () => {
      order.push('history:changed');
    });

    ok(editor.addScene('场景 B'));
    expect(order).toEqual(['project:changed', 'selection:changed', 'history:changed']);
  });

  it('revision 每次应用状态严格单调：提交/撤销/重做均递增；持久化 baseline 后仍单调', () => {
    const editor = makeEditor();
    const rev0 = editor.getProject()!.revision;
    expect(rev0).toBe(0);

    ok(editor.addObject(createGroupObject()));
    const rev1 = editor.getProject()!.revision;
    expect(rev1).toBeGreaterThan(rev0);
    ok(editor.undo());
    const rev2 = editor.getProject()!.revision;
    expect(rev2).toBeGreaterThan(rev1);
    ok(editor.redo());
    const rev3 = editor.getProject()!.revision;
    expect(rev3).toBeGreaterThan(rev2);

    // 持久化项目携带高 revision：打开后首次提交仍严格递增（不小于打开时的值）
    const persisted = createSampleProject();
    persisted.revision = 42;
    editor.openProject(persisted);
    expect(editor.getProject()!.revision).toBe(42);
    ok(editor.addObject(createGroupObject()));
    expect(editor.getProject()!.revision).toBe(43);
    ok(editor.undo());
    expect(editor.getProject()!.revision).toBe(44);
  });
});

describe('SceneEditor 第三轮：拖动事务不吞并发编辑（P-9）', () => {
  it('begin→并发可见性编辑→commitTransform：生成仅含变换的历史项，undo 分开回退', () => {
    const editor = makeEditor();
    const beforeTransform = findObject(editor.getProject()!, 'sample-cube')!.transform;

    // 拖动开始后发生并发编辑（树内隐藏）：拖动事务不得吞并
    editor.beginTransform();
    ok(editor.setVisible(['sample-cube'], false));
    ok(editor.commitTransform('sample-cube', MOVED));
    const project = editor.getProject()!;
    expect(findObject(project, 'sample-cube')!.transform.position).toEqual([1, 1, 1]);
    expect(findObject(project, 'sample-cube')!.visible).toBe(false);

    // 两步历史：可见性编辑 + 变换提交
    expect(editor.getHistoryState().undoLabel).toBe('变换对象');
    ok(editor.undo());
    // 第一次撤销只回退变换：并发编辑（隐藏）保留
    const afterTransformUndo = editor.getProject()!;
    expect(findObject(afterTransformUndo, 'sample-cube')!.transform).toEqual(beforeTransform);
    expect(findObject(afterTransformUndo, 'sample-cube')!.visible).toBe(false);
    // 第二次撤销回退可见性
    ok(editor.undo());
    expect(findObject(editor.getProject()!, 'sample-cube')!.visible).toBe(true);
    expect(editor.getProject()!.revision).toBeGreaterThan(afterTransformUndo.revision);
  });
});

describe('SceneEditor 第三轮：dispose 后无晚到写入（P-9）', () => {
  it('dispose 使会话失效：项目置空、历史清空，一切写入被拒绝', () => {
    const editor = makeEditor();
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
    editor.importModel(asset, { id: 'obj-x', type: 'model', name: 'x', parentId: null, transform: MOVED, visible: true, locked: false });
    editor.dispose();

    expect(editor.getProject()).toBeNull();
    expect(editor.getSelection()).toEqual([]);
    expect(editor.getHistoryState().canUndo).toBe(false);

    // 一切写入以「未打开项目」拒绝 —— 卸载后不得产生任何提交
    expect(editor.addObject(createGroupObject()).ok).toBe(false);
    expect(editor.setTransform('sample-cube', MOVED).ok).toBe(false);
    expect(editor.deleteSelection().ok).toBe(false);
    expect(
      editor.importModel(asset, { id: 'obj-y', type: 'model', name: 'y', parentId: null, transform: MOVED, visible: true, locked: false }).ok,
    ).toBe(false);
    expect(editor.undo().ok).toBe(false);
    expect(editor.redo().ok).toBe(false);
    expect(editor.setParent('sample-cube', null).ok).toBe(false);
    expect(editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: 'x' }), '改名').ok).toBe(false);
    expect(editor.setVisible(['sample-cube'], false).ok).toBe(false);
    expect(editor.setLocked(['sample-cube'], true).ok).toBe(false);
    editor.beginTransform();
    expect(editor.commitTransform('sample-cube', MOVED).ok).toBe(false);
    expect(editor.setActiveCamera('sample-camera').ok).toBe(false);
  });
});
