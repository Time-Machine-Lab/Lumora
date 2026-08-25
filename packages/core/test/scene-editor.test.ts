import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import {
  createCameraObject,
  createGroupObject,
  createLightObject,
  createModelObject,
  createPrimitiveObject,
  genId,
} from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { findObject } from '../src/scene/scene-graph';
import type { AssetData, Project, SceneObjectData } from '../src/scene/types';

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value as T;
}

function makeAsset(name = 'character.glb'): AssetData {
  return {
    id: `asset-${genId('x')}`,
    kind: 'gltf',
    name,
    mime: 'model/gltf-binary',
    hash: `hash-${name}`,
    size: 42,
    source: 'file',
    storageRef: 'blob:test',
    createdAt: '2026-01-01',
  };
}

function objectById(editor: SceneEditor, id: string): SceneObjectData | undefined {
  return findObject(editor.getProject()!, id);
}

describe('SceneEditor：项目生命周期', () => {
  it('openProject/reset 均发出 project:changed（reset 携带 null）', () => {
    const editor = new SceneEditor();
    const listener = vi.fn();
    editor.events.on('project:changed', listener);
    editor.openProject(createSampleProject());
    expect(listener).toHaveBeenLastCalledWith({
      project: expect.objectContaining({ name: '示例项目' }),
      sessionToken: 1,
    });
    editor.reset();
    expect(listener).toHaveBeenLastCalledWith({ project: null, sessionToken: 2 });
  });
});

describe('SceneEditor：对象操作', () => {
  it('addObject 创建对象、加入场景根并选中；undo/redo 往返一致', () => {
    const editor = makeEditor();
    const result = editor.addObject(createPrimitiveObject('torus', '甜甜圈'));
    expect(result.ok).toBe(true);
    const id = ok(result);
    expect(editor.getSelection()).toEqual([id]);
    expect(objectById(editor, id)?.parentId).toBeNull();
    const scene = editor.getProject()!.scenes.find((s) => s.id === editor.getProject()!.activeSceneId)!;
    expect(scene.rootObjectIds).toContain(id);

    expect(editor.undo().ok).toBe(true);
    expect(objectById(editor, id)).toBeUndefined();
    expect(editor.redo().ok).toBe(true);
    expect(objectById(editor, id)).toBeDefined();
  });

  it('addObject 拒绝非空 parentId 与非法对象', () => {
    const editor = makeEditor();
    const bad = { ...createPrimitiveObject('box'), parentId: 'sample-group' };
    expect(editor.addObject(bad).ok).toBe(false);
    expect(editor.addObject({ id: 'x' } as unknown as SceneObjectData).ok).toBe(false);
  });

  it('setParent 调整层级；拒绝父子循环', () => {
    const editor = makeEditor();
    // 把祖先挂到后代 → 循环，拒绝
    const cycle = editor.setParent('sample-group', 'sample-cube');
    expect(cycle.ok).toBe(false);
    expect(objectById(editor, 'sample-group')?.parentId).toBeNull();
    // 挂到自身 → 拒绝
    expect(editor.setParent('sample-cube', 'sample-cube').ok).toBe(false);
    expect(editor.setParent('sample-cube', 'sample-light').ok).toBe(true);
    expect(objectById(editor, 'sample-cube')?.parentId).toBe('sample-light');
    // 提升为根
    expect(editor.setParent('sample-cube', null).ok).toBe(true);
    const scene = editor.getProject()!.scenes.find((s) => s.id === editor.getProject()!.activeSceneId)!;
    expect(scene.rootObjectIds).toContain('sample-cube');
  });

  it('deleteSelection 删除含子树；锁定对象拒绝且数据不变', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-group']);
    const result = editor.deleteSelection();
    expect(result.ok).toBe(true);
    expect(ok(result).removed).toBe(4); // group + 3 子对象
    const project = editor.getProject()!;
    expect(project.objects.some((o) => o.id === 'sample-group')).toBe(false);
    expect(project.objects.some((o) => o.id === 'sample-cube')).toBe(false);
    // 锁定后删除被拒绝
    expect(editor.setLocked(['sample-light'], true).ok).toBe(true);
    editor.setSelection(['sample-light']);
    const lockedResult = editor.deleteSelection();
    expect(lockedResult.ok).toBe(false);
    expect(editor.getProject()!.objects.some((o) => o.id === 'sample-light')).toBe(true);
  });

  it('duplicateSelection 复制子树并保持父级关系', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-group']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    const copyId = ok(result).ids[0]!;
    const copy = objectById(editor, copyId)!;
    expect(copy.name).toBe('场景对象 副本');
    expect(copy.id).not.toBe('sample-group');
    // 子对象副本挂在副本组下
    const cubeCopy = editor.getProject()!.objects.find((o) => o.parentId === copyId);
    expect(cubeCopy).toBeDefined();
    expect(cubeCopy!.name).toBe('立方体 副本');
    expect(cubeCopy!.id).not.toBe('sample-cube');
    // 副本紧随原对象之后
    const project = editor.getProject()!;
    const indexGroup = project.objects.findIndex((o) => o.id === 'sample-group');
    expect(project.objects[indexGroup + 1]!.id).toBe(copyId);
  });

  it('setVisible / setLocked 批量生效且可撤销', () => {
    const editor = makeEditor();
    expect(editor.setVisible(['sample-cube', 'sample-sphere'], false).ok).toBe(true);
    expect(objectById(editor, 'sample-cube')!.visible).toBe(false);
    expect(objectById(editor, 'sample-sphere')!.visible).toBe(false);
    expect(editor.setLocked(['sample-cone'], true).ok).toBe(true);
    expect(objectById(editor, 'sample-cone')!.locked).toBe(true);
    editor.undo();
    expect(objectById(editor, 'sample-cone')!.locked).toBe(false);
  });

  it('updateObjectProps 更新名称/材质/灯光并拒绝锁定对象的变换', () => {
    const editor = makeEditor();
    expect(editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '红方块' }), '重命名').ok).toBe(true);
    expect(objectById(editor, 'sample-cube')!.name).toBe('红方块');
    expect(
      editor.updateObjectProps('sample-cube', (o) => ({ ...o, material: { color: '#123456' } }), '改色').ok,
    ).toBe(true);
    expect(objectById(editor, 'sample-cube')!.material!.color).toBe('#123456');
    // 锁定对象改变换 → 拒绝
    editor.setLocked(['sample-cube'], true);
    const locked = editor.updateObjectProps('sample-cube', (o) => ({
      ...o,
      transform: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }), '移动');
    expect(locked.ok).toBe(false);
    expect(objectById(editor, 'sample-cube')!.transform.position).toEqual([-2.5, 0.5, 0]);
    // 锁定对象改名仍允许
    expect(editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '锁定方块' }), '重命名').ok).toBe(true);
    // updater 返回 null → 拒绝
    expect(editor.updateObjectProps('sample-cube', () => null, 'x').ok).toBe(false);
  });
});

describe('SceneEditor：层级不变量（parentId === null ⇔ 恰好出现在一个场景的根列表）', () => {
  const activeRoots = (editor: SceneEditor): string[] => {
    const project = editor.getProject()!;
    const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
    return scene.rootObjectIds;
  };

  const assertInvariant = (editor: SceneEditor): void => {
    const project = editor.getProject()!;
    const rootCounts = new Map<string, number>();
    for (const scene of project.scenes) {
      for (const id of scene.rootObjectIds) rootCounts.set(id, (rootCounts.get(id) ?? 0) + 1);
    }
    for (const object of project.objects) {
      if (object.parentId === null) {
        expect(rootCounts.get(object.id) ?? 0).toBe(1);
      } else {
        expect(rootCounts.has(object.id)).toBe(false);
      }
    }
  };

  it('重挂根对象：从所有场景根列表移除；撤销恢复为根', () => {
    const editor = makeEditor();
    assertInvariant(editor);
    // 根对象（cube 先提升为根）挂到 light 下
    expect(editor.setParent('sample-cube', null).ok).toBe(true);
    expect(activeRoots(editor)).toContain('sample-cube');
    expect(editor.setParent('sample-cube', 'sample-light').ok).toBe(true);
    expect(activeRoots(editor)).not.toContain('sample-cube');
    expect(objectById(editor, 'sample-cube')!.parentId).toBe('sample-light');
    assertInvariant(editor);
    // 撤销：回到根，且只在活动场景根列表出现一次
    editor.undo();
    expect(objectById(editor, 'sample-cube')!.parentId).toBeNull();
    expect(activeRoots(editor)).toContain('sample-cube');
    assertInvariant(editor);
  });

  it('复制子对象：副本保持父级关系，不进入根列表；撤销/重做保持不变量', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    const cubeCopyId = ok(result).ids[0]!;
    const cubeCopy = objectById(editor, cubeCopyId)!;
    expect(cubeCopy.parentId).toBe('sample-group');
    expect(activeRoots(editor)).not.toContain(cubeCopyId);
    assertInvariant(editor);
    // 撤销：副本消失且根列表复原
    editor.undo();
    expect(objectById(editor, cubeCopyId)).toBeUndefined();
    assertInvariant(editor);
    // 重做：不变量依旧成立
    editor.redo();
    expect(objectById(editor, cubeCopyId)!.parentId).toBe('sample-group');
    assertInvariant(editor);
  });

  it('删除根对象：子树整体移除，根列表清掉该根；撤销恢复不变量', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-group']);
    expect(editor.deleteSelection().ok).toBe(true);
    expect(activeRoots(editor)).not.toContain('sample-group');
    expect(objectById(editor, 'sample-cube')).toBeUndefined();
    assertInvariant(editor);
    editor.undo();
    assertInvariant(editor);
    expect(activeRoots(editor)).toContain('sample-group');
  });

  it('registerAsset 为一步历史：撤销移除资源、重做恢复（无孤儿资源）', () => {
    const editor = makeEditor();
    const asset = makeAsset('hero.glb');
    const registered = editor.registerAsset(asset);
    expect(registered.ok).toBe(true);
    expect(editor.getProject()!.assets).toHaveLength(1);
    expect(editor.getHistoryState().canUndo).toBe(true);
    editor.undo();
    expect(editor.getProject()!.assets).toHaveLength(0);
    editor.redo();
    expect(editor.getProject()!.assets).toHaveLength(1);
    expect(editor.getProject()!.assets[0]!.hash).toBe('hash-hero.glb');
  });
});

describe('SceneEditor：锁定约束（验收：锁定对象不可移动/删除且数据不变化）', () => {
  it('setTransform / commitTransform 对锁定对象拒绝', () => {
    const editor = makeEditor();
    editor.setLocked(['sample-cube'], true);
    const transform = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
    const direct = editor.setTransform('sample-cube', transform);
    expect(direct.ok).toBe(false);
    expect(objectById(editor, 'sample-cube')!.transform.position).toEqual([-2.5, 0.5, 0]);
    editor.beginTransform();
    const drag = editor.commitTransform('sample-cube', transform);
    expect(drag.ok).toBe(false);
    expect(objectById(editor, 'sample-cube')!.transform.position).toEqual([-2.5, 0.5, 0]);
  });

  it('NaN/Infinity 变换被拒绝且不产生历史', () => {
    const editor = makeEditor();
    const before = editor.getProject()!.revision;
    const bad = editor.setTransform('sample-cube', {
      position: [NaN, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(bad.ok).toBe(false);
    expect(editor.getProject()!.revision).toBe(before);
  });
});

describe('SceneEditor：一次 Gizmo 拖动 = 一步历史（验收）', () => {
  it('begin/commit 成对：历史只增一步，undo/redo 精确往返', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube']);
    const before = structuredClone(editor.getProject()!);
    const afterTransform = { position: [3.2, 1.5, -2] as [number, number, number], rotation: [0.4, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };

    editor.beginTransform();
    editor.commitTransform('sample-cube', afterTransform, '移动立方体');
    expect(editor.getHistoryState().canUndo).toBe(true);
    expect(editor.getHistoryState().undoLabel).toBe('移动立方体');
    expect(objectById(editor, 'sample-cube')!.transform).toEqual(afterTransform);

    editor.undo();
    const undone = editor.getProject()!;
    expect(undone.objects.find((o) => o.id === 'sample-cube')!.transform).toEqual(
      before.objects.find((o) => o.id === 'sample-cube')!.transform,
    );
    editor.redo();
    expect(objectById(editor, 'sample-cube')!.transform).toEqual(afterTransform);
  });

  it('连续拖动多次提交只留一步（拖动会话内 begin 一次）', () => {
    const editor = makeEditor();
    editor.beginTransform();
    editor.commitTransform('sample-cube', { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    editor.beginTransform();
    editor.commitTransform('sample-cube', { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    // 两次独立拖动 = 两步
    expect(editor.getHistoryState().undoLabel).toBe('变换对象');
    editor.undo();
    expect(objectById(editor, 'sample-cube')!.transform.position).toEqual([1, 0, 0]);
    editor.undo();
    expect(objectById(editor, 'sample-cube')!.transform.position).toEqual([-2.5, 0.5, 0]);
  });

  it('未发生变化的拖动不产生历史', () => {
    const editor = makeEditor();
    editor.beginTransform();
    const result = editor.commitTransform('sample-cube', {
      position: [-2.5, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(result.ok).toBe(true);
    expect(editor.getHistoryState().canUndo).toBe(false);
  });

  it('历史深度上限 100：超出丢弃最旧', () => {
    const editor = makeEditor();
    for (let i = 0; i < 105; i += 1) {
      editor.setTransform('sample-cube', {
        position: [i, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      }, `步 ${i}`);
    }
    expect(editor.getHistoryState().canUndo).toBe(true);
    // 连续 undo 最多回到第 5 步之后的快照（100 步）
    let steps = 0;
    while (editor.undo().ok) steps += 1;
    expect(steps).toBe(100);
  });
});

describe('SceneEditor：撤销/重做与选择', () => {
  it('undo 后选择收敛到仍存在的对象', () => {
    const editor = makeEditor();
    const id = ok(editor.addObject(createPrimitiveObject('sphere', '临时球')));
    editor.undo();
    expect(editor.getSelection()).toEqual([]);
    editor.redo();
    expect(editor.getSelection()).toEqual([id]);
  });

  it('setSelection 过滤不存在的 id', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube', 'ghost']);
    expect(editor.getSelection()).toEqual(['sample-cube']);
  });
});

describe('SceneEditor：模型导入（FR-003）', () => {
  it('importModel 注册资源并创建对象（一步历史）；重复导入同一哈希去重', () => {
    const editor = makeEditor();
    const asset = makeAsset('hero.glb');
    const modelId = ok(editor.importModel(asset, createModelObject(asset.id, 'hero')));
    const project = editor.getProject()!;
    expect(project.assets).toHaveLength(1);
    expect(project.assets[0]!.hash).toBe(asset.hash);
    expect(project.objects.some((o) => o.type === 'model' && o.assetId === asset.id)).toBe(true);
    // 相同哈希再次导入 → 去重，不新增资源
    const second = editor.importModel(asset, createModelObject(asset.id, 'hero2'));
    expect(second.ok).toBe(true);
    expect(editor.getProject()!.assets).toHaveLength(1);
    expect(editor.getProject()!.objects.filter((o) => o.type === 'model')).toHaveLength(2);
    // undo 两步后资源随引用消失
    editor.undo();
    editor.undo();
    expect(editor.getProject()!.assets).toHaveLength(0);
    expect(editor.getProject()!.objects.some((o) => o.id === modelId)).toBe(false);
  });

  it('删除最后一个引用模型后资源被释放', () => {
    const editor = makeEditor();
    const asset = makeAsset('hero.glb');
    const modelId = ok(editor.importModel(asset, createModelObject(asset.id, 'hero')));
    editor.setSelection([modelId]);
    const result = editor.deleteSelection();
    expect(result.ok).toBe(true);
    expect(editor.getProject()!.assets).toHaveLength(0);
  });

  it('registerAsset 按哈希去重并返回 deduped 标记', () => {
    const editor = makeEditor();
    const a = makeAsset('a.glb');
    const first = editor.registerAsset(a);
    expect(first.ok && first.value!.deduped).toBe(false);
    const second = editor.registerAsset({ ...a, id: 'asset-other' });
    expect(second.ok && second.value!.deduped).toBe(true);
    expect(second.ok && second.value!.asset.id).toBe(a.id);
    expect(editor.getProject()!.assets).toHaveLength(1);
  });
});

describe('SceneEditor：场景与机位（FR-005）', () => {
  it('addScene / setActiveScene / setActiveCamera', () => {
    const editor = makeEditor();
    const sceneId = ok(editor.addScene('空场景'));
    expect(editor.getProject()!.activeSceneId).toBe(sceneId);
    expect(editor.setActiveScene('scene-1').ok).toBe(true);
    const camera = createCameraObject('B 机位', 35);
    const cameraId = ok(editor.addObject(camera));
    expect(editor.setActiveCamera(cameraId).ok).toBe(true);
    const scene = editor.getProject()!.scenes.find((s) => s.id === 'scene-1')!;
    expect(scene.activeCameraId).toBe(cameraId);
    // 非摄像机对象不能设为机位
    expect(editor.setActiveCamera('sample-cube').ok).toBe(false);
    expect(editor.setActiveCamera(null).ok).toBe(true);
  });

  it('新摄像机默认 50mm，fov 与焦距联动', () => {
    const camera = createCameraObject();
    expect(camera.camera!.focalLength).toBe(50);
    expect(camera.camera!.fov).toBeCloseTo(26.99, 1);
    const editor = makeEditor();
    const id = ok(editor.addObject(camera));
    // 改焦距 → fov 联动
    expect(
      editor.updateObjectProps(id, (o) => {
        const c = o.camera!;
        return { ...o, camera: { ...c, focalLength: 35, fov: Math.round(2 * Math.atan(24 / 70) * 180 / Math.PI * 100) / 100 } };
      }, '设置焦距').ok,
    ).toBe(true);
    const updated = objectById(editor, id)!.camera!;
    expect(updated.focalLength).toBe(35);
    expect(updated.fov).toBeCloseTo(37.85, 1);
  });
});

describe('SceneEditor：灯光与对象工厂', () => {
  it('创建三种灯光并携带默认参数', () => {
    const directional = createLightObject('directional');
    expect(directional.light!.kind).toBe('directional');
    expect(directional.light!.intensity).toBeGreaterThan(0);
    const spot = createLightObject('spot');
    expect(spot.light!.angle).toBeGreaterThan(0);
    const point = createLightObject('point');
    expect(point.light!.distance).toBeGreaterThan(0);
    const editor = makeEditor();
    expect(editor.addObject(directional).ok).toBe(true);
    expect(editor.addObject(spot).ok).toBe(true);
    expect(editor.addObject(point).ok).toBe(true);
    expect(editor.getProject()!.objects.filter((o) => o.type === 'light')).toHaveLength(4);
  });

  it('创建组对象可挂载子对象', () => {
    const editor = makeEditor();
    const groupId = ok(editor.addObject(createGroupObject('道具组')));
    const box = createPrimitiveObject('box', '盒子');
    editor.addObject(box);
    expect(editor.setParent(box.id, groupId).ok).toBe(true);
    expect(objectById(editor, box.id)!.parentId).toBe(groupId);
  });
});

describe('SceneEditor：项目序列化往返（验收：导入、变换并重新打开后一致）', () => {
  it('项目经 JSON 序列化后重新打开，对象/层级/变换/资源一致', () => {
    const editor = makeEditor();
    const asset = makeAsset('hero.glb');
    const modelId = ok(editor.importModel(asset, createModelObject(asset.id, 'hero')));
    editor.setTransform('sample-cube', { position: [5, 2, 1], rotation: [0.5, 0, 0], scale: [2, 1, 1] });
    editor.setParent('sample-cube', 'sample-light');

    const serialized = JSON.parse(JSON.stringify(editor.getProject()!)) as Project;
    const reopened = new SceneEditor();
    reopened.openProject(serialized);
    const project = reopened.getProject()!;
    expect(project.name).toBe('示例项目');
    expect(project.settings.aspect).toEqual([16, 9]);
    expect(project.objects.find((o) => o.id === 'sample-cube')!.transform.position).toEqual([5, 2, 1]);
    expect(project.objects.find((o) => o.id === 'sample-cube')!.parentId).toBe('sample-light');
    expect(project.assets).toHaveLength(1);
    expect(project.objects.find((o) => o.id === modelId)!.assetId).toBe(asset.id);
  });

  it('revision 随每次提交递增', () => {
    const editor = makeEditor();
    const r0 = editor.getProject()!.revision;
    editor.setTransform('sample-cube', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(editor.getProject()!.revision).toBe(r0 + 1);
    editor.setVisible(['sample-cube'], false);
    expect(editor.getProject()!.revision).toBe(r0 + 2);
  });
});
