import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSampleProject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import {
  buildScene,
  disposeNode,
  findNode,
  getReachableObjectIds,
  syncScene,
} from '../src/components/editor/scene-builder';

/**
 * R8-7 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * scene-builder 递归 DFS 深层链爆栈 + 逐节点 filter 的 O(n²)：
 * - getReachableObjectIds 的 walk 逐层递归，且每节点 project.objects.filter；
 * - buildScene 的 attach 逐层递归（2 万层栈帧溢出），每节点 filter；
 * - findNode/disposeNode/syncScene 走 THREE 递归 traverse，深树同样溢出。
 * 修复：全部改迭代栈；childrenOf 单遍构建（O(n)），可达集复用 core 实现。
 */

const ASPECT = 16 / 9;
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

function emptyProject(): Project {
  const sample = createSampleProject();
  return {
    ...sample,
    objects: [],
    scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: [], activeCameraId: null }],
  };
}

/** 迭代统计场景树节点数（测试侧导航不依赖被测实现） */
function countNodes(root: THREE.Object3D): number {
  let count = 0;
  const stack: THREE.Object3D[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return count;
}

/** 计数代理：统计被测代码对 project.objects.filter 的调用次数（O(n²) 判别） */
function countObjectFilters(project: Project): { project: Project; filterCalls: () => number } {
  let calls = 0;
  const objects = new Proxy(project.objects, {
    get(target, prop, receiver) {
      if (prop === 'filter') {
        return (fn: (o: SceneObjectData) => boolean) => {
          calls += 1;
          return (target as SceneObjectData[]).filter(fn);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    project: new Proxy(project, {
      get(target, prop, receiver) {
        if (prop === 'objects') return objects;
        return Reflect.get(target, prop, receiver);
      },
    }) as Project,
    filterCalls: () => calls,
  };
}

describe('R8-7 深层链迭代遍历 + 线性复杂度', () => {
  it('R8-7-T3 getReachableObjectIds 深层链：不 RangeError', () => {
    const project = deepChainProject(DEEP);
    const reachable = getReachableObjectIds(project);
    // RED：旧实现递归 walk 每层栈帧 + 每节点 filter，2 万层溢出
    expect(reachable.size).toBe(DEEP);
    expect(reachable.has(`n${DEEP - 1}`)).toBe(true);
  });

  it('R8-7-T4 buildScene 深层链：迭代构建，全量挂载，不 RangeError', () => {
    const project = deepChainProject(DEEP);
    const root = buildScene(project, ASPECT);
    // RED：旧实现 attach 逐层递归，2 万层栈帧溢出
    expect(countNodes(root)).toBe(DEEP + 1);
    let node: THREE.Object3D = root;
    for (let i = 0; i < DEEP; i++) node = node.children[0]!;
    expect(node.userData.objectId).toBe(`n${DEEP - 1}`);
  });

  it('R8-7-T5 findNode 深层链：迭代先序搜索，不 RangeError', () => {
    const root = buildScene(deepChainProject(DEEP), ASPECT);
    const found = findNode(root, `n${DEEP - 1}`);
    // RED：旧实现 root.traverse（THREE 递归）溢出
    expect(found).not.toBeNull();
    expect(found!.userData.objectId).toBe(`n${DEEP - 1}`);
  });

  it('R8-7-T6 线性复杂度：childrenOf 单遍构建，无逐节点 filter', () => {
    const chain = deepChainProject(5_000);
    const counted = countObjectFilters(chain);
    const reachable = getReachableObjectIds(counted.project);
    expect(reachable.size).toBe(5_000);
    const root = buildScene(counted.project, ASPECT);
    expect(root.children.length).toBe(1);
    // RED：旧实现每节点一次 project.objects.filter（深链 O(n²)），两处合计 2n 次
    expect(counted.filterCalls()).toBeLessThan(10);
  });

  it('R8-7-T7 syncScene 从空项目到深层链：迭代同步，不 RangeError', () => {
    const prev = emptyProject();
    const next = deepChainProject(DEEP);
    const root = buildScene(prev, ASPECT);
    // RED：旧实现 syncScene 内 getReachableObjectIds 递归溢出
    syncScene(root, prev, next, ASPECT);
    expect(countNodes(root)).toBe(DEEP + 1);
    let node: THREE.Object3D = root;
    for (let i = 0; i < DEEP; i++) node = node.children[0]!;
    expect(node.userData.objectId).toBe(`n${DEEP - 1}`);
  });

  it('R8-7-T8 disposeNode 深层链：迭代释放，不 RangeError', () => {
    const root = buildScene(deepChainProject(DEEP), ASPECT);
    // RED：旧实现 object.traverse（THREE 递归）溢出
    expect(() => disposeNode(root)).not.toThrow();
  });
});
