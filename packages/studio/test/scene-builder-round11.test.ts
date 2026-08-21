import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject, SceneEditor } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import { attachModelContent, buildScene, findNode } from '../src/components/editor/scene-builder';
import * as EditorViewportModule from '../src/components/editor/EditorViewport';

vi.mock('@react-three/fiber', () => ({
  Canvas: () => null,
  useThree: () => ({ scene: null, camera: null, set: () => undefined, gl: {}, size: {} }),
  useFrame: () => undefined,
}));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null, TransformControls: () => null }));

/**
 * R11-2 CONTENT_MARK 拾取边界统一（TML-57 第十一轮，修复前必须失败）：
 * findObjectId 自底向上遇首个「非内容且有品牌」节点即返回——CONTENT_MARK
 * 只写在内容根（attachModelContent），内容孙节点（内容根的后代）无 MARK，
 * 反射注入品牌 + 伪造 objectId 时在触达内容根前即被接受 → 劫持拾取身份。
 * 修复：完整走父链，遇 CONTENT_MARK 丢弃其下全部候选（含伪造品牌的内容
 * 后代），只返回边界上方品牌节点；未跨边界保持「最近品牌」原语义。
 * RED 格（现 HEAD 行为）：T1 返回 'HIJACK'、T4 返回 'B'；T2/T3 回归保持。
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
    activeSceneId: 'scene-1',
  };
}

/** 品牌符号（模块私有）：测试经反射从已品牌节点探出描述名，用于伪造注入 */
const OBJECT_ID_MARK_DESC = 'lumora.object-id';
function hasBrand(node: THREE.Object3D): boolean {
  return Object.getOwnPropertySymbols(node.userData).some((s) => s.description === OBJECT_ID_MARK_DESC);
}

/** 拾取解析核心（EditorViewport findObjectId）：命名空间导入避免链接期失败 */
function resolveObjectId(object: THREE.Object3D): string | null {
  const fn = (EditorViewportModule as unknown as Record<string, unknown>).findObjectId as
    | ((o: THREE.Object3D) => string | null)
    | undefined;
  if (!fn) throw new Error('findObjectId 未导出');
  return fn(object);
}

/** 挂模型内容：buildScene → findNode → attachModelContent */
function attachContent(modelId: string, scene: THREE.Group, root: THREE.Group): void {
  const node = findNode(root, modelId)!;
  attachModelContent(node, { scene } as unknown as GLTF);
}

describe('R11-2 CONTENT_MARK 拾取边界：内容后代伪造品牌不劫持拾取', () => {
  it('R11-2-T1 内容孙节点反射伪造品牌：解析到模型 id 而非伪造值（RED）', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    const node = findNode(root, 'M')!;
    attachContent('M', new THREE.Group(), root);
    const contentGroup = node.getObjectByName('__glb-content__')!;
    // 内容孙节点：GLB 真实结构为内容根 > 子组 > 网格
    const contentGrandchild = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    contentGroup.add(contentGrandchild);
    // 反射注入品牌 + 伪造 objectId（S3-T3 同款手法，作用在内容后代上）
    const brand = Object.getOwnPropertySymbols(node.userData).find((s) => s.description === OBJECT_ID_MARK_DESC);
    contentGrandchild.userData.objectId = 'HIJACK';
    (contentGrandchild.userData as Record<string | symbol, unknown>)[brand!] = true;
    expect(hasBrand(contentGrandchild)).toBe(true); // 探针自检：伪造确实存在

    // RED：现 HEAD 自底向上在触达内容根前接受伪造品牌 → 返回 'HIJACK'；
    // 修复后遇 CONTENT_MARK 丢弃其下候选，返回边界上方模型 'M'
    expect(resolveObjectId(contentGrandchild)).toBe('M');
  });

  it('R11-2-T2 内容根反射伪造品牌（S3-T3 语义经拾取入口回归）：解析到模型', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    const node = findNode(root, 'M')!;
    attachContent('M', new THREE.Group(), root);
    const contentGroup = node.getObjectByName('__glb-content__')!;
    const brand = Object.getOwnPropertySymbols(node.userData).find((s) => s.description === OBJECT_ID_MARK_DESC);
    contentGroup.userData.objectId = 'fake';
    (contentGroup.userData as Record<string | symbol, unknown>)[brand!] = true;
    expect(hasBrand(contentGroup)).toBe(true);

    expect(resolveObjectId(contentGroup)).toBe('M');
  });

  it('R11-2-T3 普通对象子树拾取语义不变：返回最近品牌节点 id', () => {
    const group = obj({ id: 'G', name: '组', type: 'group' });
    const child = obj({ id: 'C', name: '子', type: 'group', parentId: 'G' });
    const project = makeProject([group, child]);
    const root = buildScene(project, ASPECT);

    expect(resolveObjectId(findNode(root, 'C')!)).toBe('C');
    expect(resolveObjectId(findNode(root, 'G')!)).toBe('G');
  });

  it('R11-2-T4 双模型互不串扰：A 的内容子树内伪造 B 品牌 → 解析到 A（RED）', () => {
    const modelA = obj({ id: 'A', name: '模型A', type: 'model', assetId: 'a1' });
    const modelB = obj({ id: 'B', name: '模型B', type: 'model', assetId: 'a2' });
    const project = makeProject([modelA, modelB]);
    const root = buildScene(project, ASPECT);
    attachContent('A', new THREE.Group(), root);
    attachContent('B', new THREE.Group(), root);
    const nodeA = findNode(root, 'A')!;
    const contentGroupA = nodeA.getObjectByName('__glb-content__')!;
    const brandA = Object.getOwnPropertySymbols(nodeA.userData).find((s) => s.description === OBJECT_ID_MARK_DESC);
    // A 的内容子树内伪造 B 的品牌与 objectId
    const hijack = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    contentGroupA.add(hijack);
    hijack.userData.objectId = 'B';
    (hijack.userData as Record<string | symbol, unknown>)[brandA!] = true;
    expect(hasBrand(hijack)).toBe(true);

    // RED：现 HEAD 返回伪造的 'B'（拾取可劫持另一模型身份）；修复后返回 'A'
    expect(resolveObjectId(hijack)).toBe('A');
  });
});
