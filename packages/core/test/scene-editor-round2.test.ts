import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import { createCameraObject, createModelObject, createPrimitiveObject } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { findObject } from '../src/scene/scene-graph';

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value as T;
}

function makeAsset(name = 'character.glb') {
  return {
    id: `asset-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'gltf',
    name,
    mime: 'model/gltf-binary',
    hash: `hash-${name}`,
    size: 42,
    source: 'file',
    storageRef: 'blob:test',
    createdAt: '2026-01-01',
  } as const;
}

const NOOP_TRANSFORM = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;
const MOVED_TRANSFORM = { position: [1, 1, 1], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;

describe('SceneEditor：P0-1 同 hash 重复导入统一引用有效资源', () => {
  it('调用方携带不同 assetId 时，对象统一指向首个有效资源；删除其一不影响另一实例', () => {
    const editor = makeEditor();
    // makeAsset 同名 → 同 hash，但 id 各自生成（模拟不同导入器/不同本地文件）
    const first = makeAsset('hero.glb');
    const second = makeAsset('hero.glb');
    expect(first.id).not.toBe(second.id);
    expect(first.hash).toBe(second.hash);

    const modelA = ok(editor.importModel(first, createModelObject(first.id, 'hero')));
    const modelB = ok(editor.importModel(second, createModelObject(second.id, 'hero-副本')));

    const project = editor.getProject()!;
    expect(project.assets).toHaveLength(1);
    const models = project.objects.filter((o) => o.type === 'model');
    expect(models).toHaveLength(2);
    // 规范化：两个对象引用同一有效资源 id（等于首个资源），而不是各自携带的 assetId
    expect(models[0]!.id).toBe(modelA);
    expect(models[1]!.id).toBe(modelB);
    expect(models[0]!.assetId).toBe(project.assets[0]!.id);
    expect(models[1]!.assetId).toBe(project.assets[0]!.id);
    expect(models[1]!.assetId).toBe(first.id);
    expect(models[1]!.assetId).not.toBe(second.id);

    // 删除第一个实例：资源仍被第二个实例引用 → 资源保留
    editor.setSelection([modelA]);
    ok(editor.deleteSelection());
    const afterDelete = editor.getProject()!;
    expect(afterDelete.objects.filter((o) => o.type === 'model')).toHaveLength(1);
    expect(afterDelete.assets).toHaveLength(1);
    expect(afterDelete.assets[0]!.id).toBe(first.id);

    // 撤销删除：两个实例都回来，资源依旧唯一
    ok(editor.undo());
    const undone = editor.getProject()!;
    expect(undone.objects.filter((o) => o.type === 'model')).toHaveLength(2);
    expect(undone.assets).toHaveLength(1);
  });
});

describe('SceneEditor：P0-4 selection/viewMode 按活动场景隔离', () => {
  it('setSelection 只接受活动场景可达对象；切场景时选择在同一个历史快照内原子过滤', () => {
    const editor = makeEditor();
    const aSceneId = editor.getProject()!.activeSceneId;
    const bSceneId = ok(editor.addScene('场景 B'));
    const bSphereId = ok(editor.addObject(createPrimitiveObject('sphere', 'B 球')));

    // 跨场景选择被过滤：活动场景是 B，A 的对象不可选
    editor.setSelection(['sample-cube', bSphereId]);
    expect(editor.getSelection()).toEqual([bSphereId]);

    // 切回 A：选择随活动场景原子过滤为空（同一快照：after.selection 与 activeSceneId 一致）
    ok(editor.setActiveScene(aSceneId));
    expect(editor.getProject()!.activeSceneId).toBe(aSceneId);
    expect(editor.getSelection()).toEqual([]);

    // undo 切场景 → 场景与选择一起恢复；redo 同样一致
    ok(editor.undo());
    expect(editor.getProject()!.activeSceneId).toBe(bSceneId);
    expect(editor.getSelection()).toEqual([bSphereId]);
    ok(editor.redo());
    expect(editor.getProject()!.activeSceneId).toBe(aSceneId);
    expect(editor.getSelection()).toEqual([]);

    // 直接选中 A 的对象在 B 中不可达
    editor.setActiveScene(bSceneId);
    editor.setSelection(['sample-cube']);
    expect(editor.getSelection()).toEqual([]);
  });

  it('核心 mutation 拒绝活动场景外的对象；批量可见/锁定忽略场景外 id', () => {
    const editor = makeEditor();
    const aSceneId = editor.getProject()!.activeSceneId;
    ok(editor.addScene('场景 B'));
    const bSphereId = ok(editor.addObject(createPrimitiveObject('sphere', 'B 球')));
    ok(editor.setActiveScene(aSceneId));

    expect(editor.setTransform(bSphereId, MOVED_TRANSFORM).ok).toBe(false);
    expect(editor.updateObjectProps(bSphereId, (o) => ({ ...o, name: 'x' }), '改名').ok).toBe(false);
    expect(editor.setParent(bSphereId, null).ok).toBe(false);

    // 删除：场景外对象不可选 → 删除落空（0 个对象被删，无历史）
    editor.setSelection([bSphereId]);
    expect(editor.getSelection()).toEqual([]);
    const deleted = editor.deleteSelection();
    expect(deleted.ok).toBe(true);
    expect(editor.getProject()!.objects.some((o) => o.id === bSphereId)).toBe(true);

    // 批量可见/锁定：场景外 id 被忽略，不产生提交
    expect(editor.setVisible([bSphereId], false).ok).toBe(true);
    expect(findObject(editor.getProject()!, bSphereId)!.visible).toBe(true);
    expect(editor.setLocked([bSphereId], true).ok).toBe(true);
    expect(findObject(editor.getProject()!, bSphereId)!.locked).toBe(false);

    // 拖动提交同样拒绝场景外对象
    editor.beginTransform();
    expect(editor.commitTransform(bSphereId, NOOP_TRANSFORM).ok).toBe(false);
  });

  it('机位视图按活动场景隔离：切场景/删机位回退导演视图；新项目复位', () => {
    const editor = makeEditor();
    const aSceneId = editor.getProject()!.activeSceneId;
    const bSceneId = ok(editor.addScene('场景 B'));
    const camBId = ok(editor.addObject(createCameraObject('B 相机')));

    // 在 B 中查看 B 相机
    editor.setViewMode({ cameraObjectId: camBId });
    expect(editor.getView().viewMode).toEqual({ cameraObjectId: camBId });

    // 切回 A：B 相机不在可达集 → viewMode 回退导演视图
    ok(editor.setActiveScene(aSceneId));
    expect(editor.getView().viewMode).toBe('director');

    // 回 B 查看 B 相机后删除该机位 → 回退导演视图
    ok(editor.setActiveScene(bSceneId));
    editor.setViewMode({ cameraObjectId: camBId });
    editor.setSelection([camBId]);
    ok(editor.deleteSelection());
    expect(editor.getView().viewMode).toBe('director');

    // 打开新项目：视图状态整体复位（含模式/机位）
    editor.setViewMode({ cameraObjectId: 'sample-camera' });
    editor.openProject(createSampleProject());
    expect(editor.getView().viewMode).toBe('director');
  });
});

describe('SceneEditor：P0-7 历史记录持有项目引用，不克隆/不序列化载荷', () => {
  it('撤销后对象/资源数组引用与拖动前完全一致（无克隆）；载荷字符串未被复制', () => {
    const editor = makeEditor();
    const payload = 'A'.repeat(4 * 1024 * 1024); // 4MiB base64 载荷
    const asset = { ...makeAsset('hero.glb'), payload };
    const modelId = ok(editor.importModel(asset, createModelObject(asset.id, 'hero')));

    const beforeObjects = editor.getProject()!.objects;
    const beforeAssets = editor.getProject()!.assets;
    const beforeAsset = beforeAssets[0]!;

    editor.beginTransform();
    ok(editor.commitTransform(modelId, { ...MOVED_TRANSFORM, position: [9, 9, 9] }));
    editor.undo();

    const undone = editor.getProject()!;
    // 快照复用同一数组/对象引用 → 载荷从未被结构化克隆或重新序列化
    expect(undone.objects).toBe(beforeObjects);
    expect(undone.assets).toBe(beforeAssets);
    expect(undone.assets[0]).toBe(beforeAsset);
    expect(undone.assets[0]!.payload).toBe(payload);
  });

  it('begin/commit 全流程不调用 structuredClone/JSON.stringify 于项目对象', () => {
    const editor = makeEditor();
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const isProject = (arg: unknown): boolean =>
      typeof arg === 'object' && arg !== null && 'objects' in arg && 'assets' in arg;

    // 变化拖动：一步历史
    editor.beginTransform();
    ok(editor.commitTransform('sample-cube', MOVED_TRANSFORM));
    expect(editor.getHistoryState().canUndo).toBe(true);

    // 未变化拖动：sameTransform 短路，无新历史
    editor.beginTransform();
    ok(editor.commitTransform('sample-cube', MOVED_TRANSFORM));
    expect(editor.getHistoryState().canUndo).toBe(true);

    expect(cloneSpy.mock.calls.some((call) => isProject(call[0]))).toBe(false);
    expect(stringifySpy.mock.calls.some((call) => isProject(call[0]))).toBe(false);
  });
});
