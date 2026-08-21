import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import { attachModelContent, buildScene, disposeNode, findNode } from '../src/components/editor/scene-builder';

/**
 * R8-5 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 可编辑名称被当作模型资源所有权标记（scene-builder.ts）：
 * - 模型对象名为 'model-placeholder'（导入同名文件而来）：getObjectByName
 *   先命中模型组自身 → 整组被当占位框移除并释放，内容挂到已脱离的节点；
 * - 模型对象名为 '__glb-content__'：挂载守卫误判已有内容 → 永不挂载；
 * - 用户把任意对象命名为 '__glb-content__'：disposeNode 按名跳过 → GPU 泄漏。
 * 修复：所有权判定改用 userData Symbol 标记 + 仅查直接内部子节点，名称仅作标签。
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

function gltfWithMesh(): GLTF {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  return { scene } as unknown as GLTF;
}

describe('R8-5 模型所有权标记：名称不可伪造，内容挂载不误伤', () => {
  it('R8-5-T1 模型对象名为 model-placeholder：内容挂载不把模型组当占位框移除', () => {
    // 导入 model-placeholder.glb 时对象名取自文件名（model-import.ts）
    const model = obj({ id: 'm1', name: 'model-placeholder', type: 'model', assetId: 'a1' });
    const root = buildScene(makeProject([model]), ASPECT);
    const node = findNode(root, 'm1')!;

    attachModelContent(node, gltfWithMesh());

    // RED：旧实现 getObjectByName 先命中组自身 → 整组脱离场景树
    expect(root.children.includes(node)).toBe(true);
    // 内容已挂载（占位框被内容组替换）
    expect(node.children.some((c) => c instanceof THREE.Group)).toBe(true);
  });

  it('R8-5-T2 模型对象名为 __glb-content__：挂载守卫不把模型组当已有内容', () => {
    const model = obj({ id: 'm1', name: '__glb-content__', type: 'model', assetId: 'a1' });
    const root = buildScene(makeProject([model]), ASPECT);
    const node = findNode(root, 'm1')!;

    attachModelContent(node, gltfWithMesh());

    // RED：旧实现 getObjectByName 命中组自身 → 早退，内容永不挂载（children 只有占位框）
    expect(node.children.some((c) => c instanceof THREE.Group)).toBe(true);
  });

  it('R8-5-T3 普通对象命名为 __glb-content__：释放不再被名称伪造跳过，缓存内容仍受保护', () => {
    const prim = obj({ id: 'p1', name: '__glb-content__', type: 'primitive', geometry: { kind: 'box' }, material: { color: '#ff0000' } });
    const model = obj({ id: 'm1', name: '模型', type: 'model', assetId: 'a1' });
    const root = buildScene(makeProject([prim, model]), ASPECT);
    const modelNode = findNode(root, 'm1')!;
    const primNode = findNode(root, 'p1') as THREE.Mesh;
    const gltf = gltfWithMesh();
    attachModelContent(modelNode, gltf);

    const primSpy = vi.spyOn(primNode.geometry, 'dispose');
    // 内容克隆与缓存资源共享几何：缓存内容必须继续被跳过（保护共享 GPU 资源）
    const contentMesh = modelNode.children[0]!.children[0] as THREE.Mesh;
    const contentSpy = vi.spyOn(contentMesh.geometry, 'dispose');

    disposeNode(root);

    // RED：旧实现按名称判定内容所有权 → 普通对象被跳过，几何永不释放
    expect(primSpy).toHaveBeenCalledTimes(1);
    expect(contentSpy).not.toHaveBeenCalled();
  });
});
