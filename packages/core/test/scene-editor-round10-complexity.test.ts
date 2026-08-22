// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project, SceneObjectData } from '../src/scene/types';

/**
 * R10-M3 #7 对抗测试（TML-57 第十轮 M3，修复前必须失败）：
 * duplicateSubtree 逐节点 findObject(project, id)——findObject 是
 * project.objects.find 线性扫描 → 复制 n 节点链 = n×n 次谓词调用（O(n²)，
 * n=4000 时 ≈ 1600 万次）。R9-M2 只消除了递归栈溢出，复杂度缺陷仍在。
 * 修复：duplicateSelection 一次构建 byId Map 并在全部复制根间共享，
 * duplicateSubtree 改读 byId（缺失 continue 语义保持）。
 * RED 格（现 HEAD 行为）：T1 谓词计数 ≈ n² ≫ 8n 线性上界；T2/T3 回归保持。
 */

function chainObject(id: string, parentId: string | null, depth: number): SceneObjectData {
  return {
    id,
    type: 'group',
    name: `链 ${depth}`,
    parentId,
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as SceneObjectData;
}

function chainProject(depth: number): Project {
  const sample = createSampleProject();
  const objects: SceneObjectData[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < depth; i++) {
    const id = `chain-${i}`;
    objects.push(chainObject(id, parentId, i));
    parentId = id;
  }
  return {
    ...sample,
    objects,
    scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: ['chain-0'], activeCameraId: null }],
    tracks: [],
  };
}

/** 从根沿子链下探，统计完整层级长度（复制结果应等于原链长） */
function chainLength(project: Project, rootId: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const object of project.objects) {
    if (object.parentId === null) continue;
    const list = childrenOf.get(object.parentId);
    if (list) list.push(object.id);
    else childrenOf.set(object.parentId, [object.id]);
  }
  let count = 0;
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    count += 1;
    const children = childrenOf.get(id);
    if (children) stack.push(...children);
  }
  return count;
}

describe('R10-M3 #7 复制复杂度：byId 共享消除逐节点线性扫描', () => {
  it('R10-7-T1 全链复制的 Array.find 谓词执行次数 < 8n 线性上界（n=2000/4000，RED）', () => {
    for (const n of [2000, 4000]) {
      const editor = new SceneEditor();
      editor.openProject(chainProject(n));
      editor.setSelection(['chain-0']);
      // 计数谓词执行次数（扫描工作量），而非 find 调用次数：一次 find 内部可
      // 执行 O(n) 次谓词——线性扫描的代价在谓词执行，不在调用
      const originalFind = Array.prototype.find;
      let predicates = 0;
      const spy = vi.spyOn(Array.prototype, 'find').mockImplementation(function <T>(
        this: T[],
        predicate: (value: T, index: number, array: T[]) => unknown,
        thisArg?: unknown,
      ): T | undefined {
        return originalFind.call(this, (value, index, array) => {
          predicates += 1;
          return predicate(value, index, array);
        }, thisArg);
      });
      const result = editor.duplicateSelection();
      spy.mockRestore();

      expect(result.ok).toBe(true);
      // RED：现 HEAD duplicateSubtree 每节点 findObject 全量扫描 → 谓词 ≈ n²/2
      //（n=4000 ≈ 800 万）；修复后 byId 共享 → 常数级（< 8n 线性上界）
      expect(predicates).toBeLessThan(8 * n);
    }
  }, 60000);

  it('R10-7-T2 6000 层链复制回归：不抛错、副本层级完整', () => {
    const editor = new SceneEditor();
    editor.openProject(chainProject(6000));
    editor.setSelection(['chain-0']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const newRootId = result.value!.ids[0]!;
    expect(chainLength(editor.getProject()!, newRootId)).toBe(6000);
  }, 60000);

  it('R10-7-T3 复制正确性回归：副本父链映射、根列表追加、原树不动、后代不重复', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    // 选中组与组内后代：后代应被 isInSubtree 去重，不产生第二个副本
    editor.setSelection(['sample-group', 'sample-cube']);
    const result = editor.duplicateSelection();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const [copyId] = result.value!.ids;
    const project = editor.getProject()!;
    const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
    // 副本根追加进活动场景根列表
    expect(scene.rootObjectIds).toContain(copyId);
    const copy = project.objects.find((o) => o.id === copyId)!;
    expect(copy.name).toBe('场景对象 副本');
    expect(copy.parentId).toBeNull();
    // 子对象副本挂在副本组下
    const cubeCopy = project.objects.find((o) => o.parentId === copyId)!;
    expect(cubeCopy.name).toBe('立方体 副本');
    expect(cubeCopy.id).not.toBe('sample-cube');
    // 原对象保持原样：未被改名、数量不变
    expect(project.objects.filter((o) => o.id === 'sample-group')).toHaveLength(1);
    expect(project.objects.filter((o) => o.id === 'sample-cube')).toHaveLength(1);
    // 返回列表只有副本根（后代不重复复制）
    expect(result.value!.ids).toEqual([copyId]);
  });
});
