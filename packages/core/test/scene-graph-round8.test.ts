// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSampleProject } from '../src/scene/sample-project';
import { getReachableIds, isInSubtree } from '../src/scene/scene-graph';
import type { Project, SceneObjectData } from '../src/scene/types';

/**
 * R8-7 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 递归 DFS 深层链爆栈（scene-graph.ts isInSubtree/getReachableIds）：
 * - isInSubtree 沿父链逐层递归（每层一个栈帧），且每层 findObject 线性扫描；
 * - getReachableIds 对子节点递归（每节点一个栈帧）。
 * 2 万层深链下旧实现 RangeError。修复：父链迭代上溯 + byId 索引；
 * 可达集迭代栈 + 单遍 childrenOf 构建。
 */

const DEEP = 20_000;

function deepChainProject(depth: number): Project {
  const sample = createSampleProject();
  const objects: SceneObjectData[] = [];
  for (let i = 0; i < depth; i++) {
    objects.push({
      id: `n${i}`,
      type: 'group',
      name: `节点${i}`,
      parentId: i === 0 ? null : `n${i - 1}`,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
    });
  }
  return {
    ...sample,
    objects,
    scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: ['n0'], activeCameraId: null }],
  };
}

describe('R8-7 深层链迭代遍历：不爆栈', () => {
  it('R8-7-T1 isInSubtree 深层父链：迭代上溯，不 RangeError', () => {
    const project = deepChainProject(DEEP);
    // RED：旧实现沿父链逐层递归（2 万层栈帧），V8 栈溢出
    expect(isInSubtree(project, `n${DEEP - 1}`, 'n0')).toBe(true);
    expect(isInSubtree(project, 'n0', `n${DEEP - 1}`)).toBe(false);
  });

  it('R8-7-T2 getReachableIds 深层链：迭代栈，不 RangeError', () => {
    const project = deepChainProject(DEEP);
    const reachable = getReachableIds(project, 'scene-1');
    expect(reachable.size).toBe(DEEP);
    expect(reachable.has(`n${DEEP - 1}`)).toBe(true);
  });
});
