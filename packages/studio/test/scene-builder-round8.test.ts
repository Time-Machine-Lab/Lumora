import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import { attachModelContent, buildScene, findNode, syncScene } from '../src/components/editor/scene-builder';

/**
 * R8-4 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * Project/Three 增量同步分叉（scene-builder.ts syncScene）：
 * - child-first 恢复数组（子在前父在后）单遍创建时父节点尚不存在 → 永久跳过；
 * - 同 ID 复用但 type 变化 → 旧类型节点被复用（type 分叉）；
 * - 同 ID 模型换资源（assetId）→ 旧 GLB 内容残留（asset 分叉）。
 * 修复：先建全部缺失/身份分叉节点，再统一挂载；type/assetId 变化整节点重建。
 */

const ASPECT = 16 / 9;

function obj(partial: Partial<SceneObjectData> & { id: string; type: SceneObjectData['type']; name: string }): SceneObjectData {
  return {
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    ...partial,
  };
}

function makeProject(objects: SceneObjectData[]): Project {
  const sample = createSampleProject();
  const roots = objects.filter((o) => o.parentId === null).map((o) => o.id);
  return {
    ...sample,
    objects,
    scenes: [{ id: 'scene-1', name: '主场景', rootObjectIds: roots, activeCameraId: null }],
  };
}

describe('R8-4 syncScene：缺失节点先建后挂，type/asset 身份分叉整节点重建', () => {
  it('R8-4-T1 子在前父在后的恢复数组：单遍同步不永久跳过孤儿节点', () => {
    // 场景：A 挂在 B 下；删除 B（连带 A）后撤销，恢复数组 child-first（A 在 B 前）
    const a = obj({ id: 'A', name: '子组', type: 'group', parentId: 'B' });
    const b = obj({ id: 'B', name: '父组', type: 'group' });
    const prev = makeProject([]);
    const next = makeProject([a, b]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    const bNode = findNode(root, 'B');
    const aNode = findNode(root, 'A');
    // RED：旧实现单遍遍历，A 的父节点 B 尚未创建 → continue 永久跳过
    expect(bNode).not.toBeNull();
    expect(aNode).not.toBeNull();
    expect(aNode!.parent).toBe(bNode);
  });

  it('R8-4-T2 同 ID 复用但 type 变化：整节点按新类型重建', () => {
    const cube = obj({
      id: 'x',
      name: '方块',
      type: 'primitive',
      geometry: { kind: 'box' },
      material: { color: '#ff0000' },
    });
    const light = obj({ id: 'x', name: '点灯', type: 'light', light: { kind: 'point', color: '#ffffff', intensity: 2 } });
    const prev = makeProject([cube]);
    const next = makeProject([light]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    const node = findNode(root, 'x');
    // RED：旧实现按 id 复用旧 Mesh 节点，applyObjectData 不会跨类型重建
    expect(node).not.toBeNull();
    expect(node).toBeInstanceOf(THREE.PointLight);
    expect(node!.userData.type).toBe('light');
  });

  it('R8-4-T3 同 ID 模型更换资源：旧 GLB 内容卸载，新占位符就位', () => {
    const m1 = obj({ id: 'm1', name: '模型', type: 'model', assetId: 'a1' });
    const m2 = obj({ id: 'm1', name: '模型', type: 'model', assetId: 'a2' });
    const prev = makeProject([m1]);
    const next = makeProject([m2]);
    const root = buildScene(prev, ASPECT);
    const node = findNode(root, 'm1')!;
    attachModelContent(node, { scene: new THREE.Group() } as unknown as GLTF);
    expect(node.getObjectByName('__glb-content__')).toBeDefined();

    syncScene(root, prev, next, ASPECT);

    const synced = findNode(root, 'm1')!;
    // RED：旧实现复用节点，内容子树与旧资源标识残留（three 未命中返回 undefined）
    expect(synced.userData.assetId).toBe('a2');
    expect(synced.getObjectByName('__glb-content__')).toBeUndefined();
    expect(synced.getObjectByName('model-placeholder')).not.toBeNull();
  });
});
