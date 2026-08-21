// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import { findObject } from '../src/scene/scene-graph';
import type { Project, SceneObjectData } from '../src/scene/types';

/**
 * R9-M2 深层链对抗测试（TML-57 第九轮 M2，修复前必须失败）：
 * duplicateSubtree 现 HEAD 为递归实现，每层另做 project.objects.filter——
 * 6000 层链上 duplicateSelection 抛 RangeError（调用栈溢出）。
 * 修复：一次 childrenOf 索引在全部复制根间共享 + 迭代栈复制。
 * T1 为红探针（6000 层）；T2 为多规模验证（500/1500/3000 层复制后层级完整）。
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

describe('R9-M2 深层链复制：迭代栈 + 共享 childrenOf 索引', () => {
  it('R9-M2-T1 6000 层链 duplicateSelection：不抛栈溢出，副本层级完整', () => {
    const editor = new SceneEditor();
    editor.openProject(chainProject(6000));
    editor.setSelection(['chain-0']);

    // RED：现 HEAD 递归 duplicateSubtree 在 ~4k 层处抛 RangeError
    let result: ReturnType<SceneEditor['duplicateSelection']>;
    expect(() => {
      result = editor.duplicateSelection();
    }).not.toThrow();
    expect(result!.ok).toBe(true);
    const newRootId = result!.value!.ids[0]!;
    expect(chainLength(editor.getProject()!, newRootId)).toBe(6000);
  });

  it('R9-M2-T2 多规模链（500/1500/3000 层）：全部复制成功且子副本父链映射完整', () => {
    for (const depth of [500, 1500, 3000]) {
      const editor = new SceneEditor();
      editor.openProject(chainProject(depth));
      editor.setSelection(['chain-0']);
      const result = editor.duplicateSelection();
      expect(result.ok).toBe(true);
      const newRootId = result.value!.ids[0]!;
      expect(chainLength(editor.getProject()!, newRootId)).toBe(depth);
    }
  });
});
