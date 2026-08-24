import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import { createGroupObject, createPrimitiveObject } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project, SceneObjectData, TransformData } from '../src/scene/types';

/**
 * M1 EditorState 边界重建对抗测试（TML-57 第五轮复审）：
 * - owned immutable：getter 暴露冻结引用，篡改抛 TypeError；输入与编辑器状态解耦
 * - updater 收到工作副本：原地改 id/type/transform 不可能污染编辑器状态
 * - 候选状态完整 schema + 有限数值校验（NaN 拒绝）
 * - 原子提交：校验失败时状态与历史游标均不变
 * - dispose 终态优先：不发出事件、不可重入，事件总线永久关闭
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

describe('M1 owned immutable：getter 只暴露冻结引用', () => {
  it('getProject 的任意写入（含嵌套）在严格模式下抛 TypeError，状态不受影响', () => {
    const editor = makeEditor();
    const project = editor.getProject()!;
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.objects)).toBe(true);
    expect(Object.isFrozen(project.objects[0])).toBe(true);
    expect(Object.isFrozen(project.scenes[0]!.rootObjectIds)).toBe(true);
    expect(Object.isFrozen(project.assets)).toBe(true);

    expect(() => {
      (project.objects as SceneObjectData[]).push(createGroupObject());
    }).toThrow(TypeError);
    expect(() => {
      project.objects[0]!.name = 'hacked';
    }).toThrow(TypeError);
    expect(() => {
      project.objects[0]!.transform.position[0] = 99;
    }).toThrow(TypeError);
    expect(() => {
      project.scenes[0]!.rootObjectIds.push('x');
    }).toThrow(TypeError);
    expect(() => {
      (project.assets as unknown[]).push({});
    }).toThrow(TypeError);
    expect(editor.getProject()!.objects.length).toBe(project.objects.length);
    expect(editor.getProject()!.objects[0]!.name).not.toBe('hacked');
  });

  it('getSelectedObjects 返回的也是冻结引用', () => {
    const editor = makeEditor();
    editor.setSelection(['sample-cube']);
    const selected = editor.getSelectedObjects();
    expect(Object.isFrozen(selected[0]!)).toBe(true);
    expect(() => {
      selected[0]!.name = 'hacked';
    }).toThrow(TypeError);
  });

  it('openProject 后输入与编辑器状态解耦：篡改输入不影响编辑器，编辑器篡改输入也不发生', () => {
    const editor = makeEditor();
    const input = createSampleProject();
    editor.openProject(input);
    input.objects[0]!.name = 'hacked-input';
    input.scenes[0]!.rootObjectIds.pop();
    expect(editor.getProject()!.objects[0]!.name).not.toBe('hacked-input');
    expect(editor.getProject()!.scenes[0]!.rootObjectIds.length).toBe(
      createSampleProject().scenes[0]!.rootObjectIds.length,
    );
    // 编辑器快照独立于输入：双方对彼此的改动互不可见
    expect(editor.getProject()).not.toBe(input);
  });

  it('project:changed 载荷即为编辑器持有的冻结快照（同一引用）', () => {
    const editor = makeEditor();
    const seen: (Project | null)[] = [];
    const unsubscribe = editor.events.on('project:changed', ({ project }) => seen.push(project));
    ok(editor.addObject(createGroupObject()));
    expect(seen.at(-1)).toBe(editor.getProject());
    expect(Object.isFrozen(seen.at(-1))).toBe(true);
    unsubscribe.dispose();
  });
});

describe('M1 updater 工作副本：原地篡改不可能污染编辑器', () => {
  it('updater 原地改 id：副本上改，编辑器状态不变，操作被拒绝', () => {
    const editor = makeEditor();
    const result = editor.updateObjectProps('sample-cube', (o) => {
      o.id = 'stolen';
      return o;
    }, '改 ID');
    expect(result.ok).toBe(false);
    expect((result as { error: Error }).error.message).toBe('结构标识（id/type）不可修改');
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')).toBeDefined();
    expect(editor.getProject()!.objects.find((o) => o.id === 'stolen')).toBeUndefined();
  });

  it('updater 原地改 type：拒绝；数据保持不变', () => {
    const editor = makeEditor();
    const result = editor.updateObjectProps('sample-cube', (o) => {
      o.type = 'group';
      return o;
    }, '改类型');
    expect(result.ok).toBe(false);
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.type).toBe('primitive');
  });

  it('updater 原地改 transform：解锁对象生效进入历史；锁定对象按值比较拒绝', () => {
    const editor = makeEditor();
    ok(editor.updateObjectProps('sample-cube', (o) => {
      o.transform = { ...o.transform, position: [5, 5, 5] };
      return o;
    }, '移动'));
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.transform.position).toEqual([5, 5, 5]);
    ok(editor.undo());
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.transform.position).toEqual([-2.5, 0.5, 0]);

    ok(editor.setLocked(['sample-cube'], true));
    const locked = editor.updateObjectProps('sample-cube', (o) => {
      o.transform = { ...o.transform, position: [1, 2, 3] };
      return o;
    }, '移动');
    expect(locked.ok).toBe(false);
    // 锁定对象仅改名（变换值不变）仍允许
    ok(editor.updateObjectProps('sample-cube', (o) => {
      o.name = '改名';
      return o;
    }, '改名'));
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe('改名');
  });

  it('updater 原地篡改后返回 null：拒绝且无副作用', () => {
    const editor = makeEditor();
    const result = editor.updateObjectProps('sample-cube', (o) => {
      o.name = 'x';
      return null;
    }, '改名');
    expect(result.ok).toBe(false);
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe('立方体');
    expect(editor.getHistoryState().canUndo).toBe(false);
  });
});

describe('M1 候选状态完整校验：NaN/Infinity 拒绝', () => {
  it('updater 写入 NaN 位置：完整 schema 校验拒绝，状态与游标不变', () => {
    const editor = makeEditor();
    const before = editor.getProject();
    const result = editor.updateObjectProps('sample-cube', (o) => {
      o.transform = { ...o.transform, position: [NaN, 0, 0] };
      return o;
    }, '移动');
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBe(before); // 状态引用不变
    expect(editor.getProject()!.revision).toBe(before!.revision);
    expect(editor.getHistoryState().canUndo).toBe(false); // 游标不变
  });

  it('addObject 通过浅校验但含 NaN：提交路径拒绝（原子失败）', () => {
    const editor = makeEditor();
    const before = editor.getProject();
    const bad: SceneObjectData = {
      id: 'bad-nan',
      type: 'primitive',
      name: '坏对象',
      parentId: null,
      transform: { position: [0, Infinity, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      geometry: { kind: 'box' },
      material: { color: '#ffffff' },
    };
    const result = editor.addObject(bad);
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBe(before);
    expect(editor.getProject()!.revision).toBe(before!.revision);
    expect(editor.getProject()!.objects.find((o) => o.id === 'bad-nan')).toBeUndefined();
    expect(editor.getHistoryState().canUndo).toBe(false);
  });

  it('非法 camera/light 数值同样被完整 schema 拒绝', () => {
    const editor = makeEditor();
    expect(
      editor.updateObjectProps('sample-camera', (o) => ({
        ...o,
        camera: { ...o.camera!, fov: Number.NaN },
      }), '改视场角').ok,
    ).toBe(false);
    expect(
      editor.updateObjectProps('sample-light', (o) => ({
        ...o,
        light: { ...o.light!, intensity: Number.POSITIVE_INFINITY },
      }), '改强度').ok,
    ).toBe(false);
    expect(editor.getHistoryState().canUndo).toBe(false);
  });

  it('未知几何/灯光种类与非法枚举被拒绝', () => {
    const editor = makeEditor();
    const result = editor.updateObjectProps('sample-cube', (o) => ({
      ...o,
      geometry: { kind: 'icosahedron' as never },
    }), '改几何');
    expect(result.ok).toBe(false);
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.geometry).toEqual({ kind: 'box' });
  });
});

describe('M1 原子提交：失败时状态与历史游标均不变', () => {
  it('failed commit 后 undo/redo 仍报告无操作，可继续正常提交', () => {
    const editor = makeEditor();
    ok(editor.addObject(createGroupObject())); // 一个成功步骤
    const before = editor.getProject();
    const beforeRevision = before!.revision;
    const bad = {
      ...createPrimitiveObject('box'),
      id: 'dup-root',
      transform: { position: [NaN, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const failed = editor.addObject(bad as SceneObjectData);
    expect(failed.ok).toBe(false);
    expect(editor.getProject()).toBe(before);
    expect(editor.getProject()!.revision).toBe(beforeRevision);
    // 游标未被失败提交移动：仍只有最初那一步可撤销
    expect(editor.getHistoryState().canUndo).toBe(true);
    expect(editor.getHistoryState().canRedo).toBe(false);
    ok(editor.undo());
    expect(editor.getProject()!.objects.find((o) => o.id === 'dup-root')).toBeUndefined();
    expect(editor.redo().ok).toBe(true);
    // 失败提交不产生历史步骤：redo 回来的是最初的 addObject，不是坏对象
    expect(editor.getProject()!.objects.find((o) => o.id === 'dup-root')).toBeUndefined();
  });

  it('撤销/重做后 revision 严格单调：应用即盖章，从不复用旧值', () => {
    const editor = makeEditor();
    const rev0 = editor.getProject()!.revision;
    ok(editor.addObject(createGroupObject()));
    const rev1 = editor.getProject()!.revision;
    ok(editor.undo());
    const rev2 = editor.getProject()!.revision;
    expect(rev2).toBeGreaterThan(rev1);
    ok(editor.redo());
    const rev3 = editor.getProject()!.revision;
    expect(rev3).toBeGreaterThan(rev2);
    expect(rev3).toBeGreaterThan(rev1);
    expect(rev1).toBeGreaterThan(rev0);
  });

  it('undo/redo 应用的状态同样是冻结快照，且与历史内快照引用不同', () => {
    const editor = makeEditor();
    ok(editor.addObject(createGroupObject()));
    ok(editor.undo());
    const undone = editor.getProject()!;
    expect(Object.isFrozen(undone)).toBe(true);
    ok(editor.redo());
    const redone = editor.getProject()!;
    expect(Object.isFrozen(redone)).toBe(true);
    expect(redone).not.toBe(undone);
    expect(redone.revision).toBeGreaterThan(undone.revision);
  });
});

describe('M1 dispose 终态优先：不可重入、无事件、总线永久关闭', () => {
  it('dispose 从事件处理器内被调用：不重入、不发出任何事件，之后订阅即抛错', () => {
    const editor = makeEditor();
    const seen: string[] = [];
    const unsubscribe = editor.events.on('project:changed', ({ project }) => {
      seen.push('project:changed');
      if (project !== null) editor.dispose(); // 处理器内触发 dispose（重入场景）
    });
    ok(editor.addObject(createGroupObject()));
    // 处理器内 dispose 后：本事件序列不再继续，无 selection/view/history 事件
    expect(seen).toEqual(['project:changed']);
    expect(editor.getProject()).toBeNull();
    unsubscribe.dispose();
    // 事件总线已永久关闭：一切订阅接口抛「事件总线已关闭」
    expect(() => editor.events.on('project:changed', () => {})).toThrow('事件总线已关闭');
    expect(() => editor.events.once('project:changed', () => {})).toThrow('事件总线已关闭');
    expect(() => editor.events.onAny(() => {})).toThrow('事件总线已关闭');
    expect(() => editor.dispose()).not.toThrow(); // 幂等
  });

  it('dispose 前订阅的处理器在 dispose 后不再被调用（无晚到事件）', () => {
    const editor = makeEditor();
    let calls = 0;
    const unsubscribe = editor.events.on('project:changed', () => {
      calls += 1;
    });
    editor.dispose();
    unsubscribe.dispose();
    expect(calls).toBe(0);
    // 状态已置空：读接口返回终态
    expect(editor.getProject()).toBeNull();
    expect(editor.getSelection()).toEqual([]);
    expect(editor.getHistoryState().canUndo).toBe(false);
    expect(editor.getView().viewMode).toBe('director');
  });

  it('dispose 后 beginTransform 捕获为空、commitTransform 拒绝、视图 setter 静默', () => {
    const editor = makeEditor();
    editor.dispose();
    editor.beginTransform();
    expect(editor.commitTransform('sample-cube', MOVED).ok).toBe(false);
    editor.setTransformMode('rotate');
    editor.setViewMode({ cameraObjectId: 'sample-camera' });
    expect(editor.getView().transformMode).toBe('translate');
    expect(editor.getView().viewMode).toBe('director');
  });
});

describe('M1 结构校验边界（O(n) 索引 + DFS）', () => {
  it('深层父子循环（非自环）被拒绝：B→C→B 封闭环', () => {
    const editor = new SceneEditor();
    const project = createSampleProject();
    project.objects.push({
      id: 'b',
      type: 'group',
      name: 'B',
      parentId: 'c',
      transform: MOVED,
      visible: true,
      locked: false,
    });
    project.objects.push({
      id: 'c',
      type: 'group',
      name: 'C',
      parentId: 'b',
      transform: MOVED,
      visible: true,
      locked: false,
    });
    expect(() => editor.openProject(project)).toThrow(/父子关系存在循环/);
    expect(editor.getProject()).toBeNull();
  });

  it('重复对象 id 被拒绝', () => {
    const editor = new SceneEditor();
    const project = createSampleProject();
    project.objects.push({ ...project.objects[0]! });
    expect(() => editor.openProject(project)).toThrow(/对象数据不合法/);
    expect(editor.getProject()).toBeNull();
  });

  it('大层级项目（1000 节点）打开与提交均通过校验，revision 正常', () => {
    const editor = new SceneEditor();
    const project = createSampleProject();
    const objects: SceneObjectData[] = [...project.objects];
    const rootIds: string[] = [
      'sample-group',
      'sample-ground',
      'sample-light',
      'sample-camera',
      'sample-camera-2',
    ];
    for (let i = 0; i < 1000; i += 1) {
      const id = `bulk-${i}`;
      objects.push({
        id,
        type: 'group',
        name: `节点 ${i}`,
        parentId: i === 0 ? null : `bulk-${i - 1}`,
        transform: MOVED,
        visible: true,
        locked: false,
      });
      if (i === 0) rootIds.push(id);
    }
    const started = performance.now();
    editor.openProject({ ...project, objects, scenes: [{ ...project.scenes[0]!, rootObjectIds: rootIds }] });
    ok(editor.setTransform('bulk-999', MOVED)); // 提交路径 O(n) 校验
    ok(editor.undo());
    ok(editor.redo()); // 撤销/重做同样 O(n)
    ok(editor.setParent('bulk-1', null)); // 子树提根：父级变更 + 全量校验
    const elapsed = performance.now() - started;
    // 宽松上界：O(n) 校验在 1000 节点下应在几十毫秒内完成（防 O(n²)/O(n³) 回归的哨兵）
    expect(elapsed).toBeLessThan(2000);
    expect(editor.getProject()!.objects.length).toBe(project.objects.length + 1000);
    expect(editor.getHistoryState().canUndo).toBe(true);
  });
});
