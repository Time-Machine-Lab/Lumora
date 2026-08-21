// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject } from '@lumora/core';
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
 * R12-2（TML-57 第十二轮嵌套 CONTENT_MARK 收敛，修复前必须失败）：
 * resolveOwnedIdAboveContent 在 crossed 后遇首个品牌即早退——攻击链
 * A(brand) > outerContent(mark) > 伪造B(brand) > innerContent(mark) > hit
 * 在触达 outerContent（会清空候选）前即返回 'B' → 跨模型劫持，且与
 * findNode（内容子树整体跳过）读口不一致。
 * 修复：循环内不返回——最近有效品牌定格、遇任意 CONTENT_MARK 清空候选、
 * 走完父链后在根处决议；objectId 非字符串的品牌不冻结、不采纳。
 * RED 格（现 HEAD 行为）：T1 返回 'B'、T5 返回 123（number）；其余格回归。
 */

const ASPECT = 16 / 9;
const OBJECT_ID_MARK_DESC = 'lumora.object-id';
const CONTENT_MARK_DESC = 'lumora.model-content';

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

/** 品牌/内容标记符号（模块私有）：从已标记节点反射探出，用于伪造注入 */
function findMarkSymbol(node: THREE.Object3D, description: string): symbol {
  const found = Object.getOwnPropertySymbols(node.userData).find((s) => s.description === description);
  if (!found) throw new Error(`标记符号 ${description} 未找到`);
  return found;
}

function anyBrandSymbol(root: THREE.Object3D): symbol {
  const stack: THREE.Object3D[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Object.getOwnPropertySymbols(node.userData).some((s) => s.description === OBJECT_ID_MARK_DESC)) {
      return findMarkSymbol(node, OBJECT_ID_MARK_DESC);
    }
    for (const child of node.children) stack.push(child);
  }
  throw new Error('品牌符号未找到');
}

function anyContentMarkSymbol(root: THREE.Object3D): symbol {
  const stack: THREE.Object3D[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Object.getOwnPropertySymbols(node.userData).some((s) => s.description === CONTENT_MARK_DESC)) {
      return findMarkSymbol(node, CONTENT_MARK_DESC);
    }
    for (const child of node.children) stack.push(child);
  }
  throw new Error('内容标记符号未找到');
}

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

describe('R12-2 嵌套 CONTENT_MARK：任意内容边界清空候选、根处决议', () => {
  it('R12-2-T1 嵌套双边界跨模型：outerContent > 伪造B > innerContent > hit → A（RED）', () => {
    const modelA = obj({ id: 'A', name: '模型A', type: 'model', assetId: 'a1' });
    const modelB = obj({ id: 'B', name: '模型B', type: 'model', assetId: 'a2' });
    const project = makeProject([modelA, modelB]);
    const root = buildScene(project, ASPECT);
    attachContent('A', new THREE.Group(), root);
    attachContent('B', new THREE.Group(), root);
    const nodeA = findNode(root, 'A')!;
    const outerContent = nodeA.getObjectByName('__glb-content__')!;
    const brand = anyBrandSymbol(root);
    const contentMark = anyContentMarkSymbol(root);
    // 攻击链：A 的内容子树内伪造 B 品牌，其下再套一层内容边界
    const forgedB = new THREE.Group();
    forgedB.userData.objectId = 'B';
    (forgedB.userData as Record<string | symbol, unknown>)[brand] = true;
    outerContent.add(forgedB);
    const innerContent = new THREE.Group();
    (innerContent.userData as Record<string | symbol, unknown>)[contentMark] = true;
    forgedB.add(innerContent);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    innerContent.add(hit);
    expect(hasBrand(forgedB)).toBe(true); // 探针自检：伪造确实存在

    // RED：现 HEAD 在触达 outerContent 前即返回伪造的 'B'；修复后 innerContent
    // 清空 → B 定格 → outerContent 再清空 → A 定格 → 根处决议返回 'A'
    expect(resolveObjectId(hit)).toBe('A');
  });

  it('R12-2-T2 拾取-查询一致性：解析结果必须是 findNode 可见的真实对象（RED 侧收敛）', () => {
    const modelA = obj({ id: 'A', name: '模型A', type: 'model', assetId: 'a1' });
    const modelB = obj({ id: 'B', name: '模型B', type: 'model', assetId: 'a2' });
    const project = makeProject([modelA, modelB]);
    const root = buildScene(project, ASPECT);
    attachContent('A', new THREE.Group(), root);
    const nodeA = findNode(root, 'A')!;
    const outerContent = nodeA.getObjectByName('__glb-content__')!;
    const brand = anyBrandSymbol(root);
    const contentMark = anyContentMarkSymbol(root);
    const forgedB = new THREE.Group();
    forgedB.userData.objectId = 'B';
    (forgedB.userData as Record<string | symbol, unknown>)[brand] = true;
    outerContent.add(forgedB);
    const innerContent = new THREE.Group();
    (innerContent.userData as Record<string | symbol, unknown>)[contentMark] = true;
    forgedB.add(innerContent);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    innerContent.add(hit);

    // 两个读口一致：拾取解析出的 id 必须能被 findNode 从根寻得；
    // 伪造的 'B' 因内容边界对 findNode 不可见（内容子树整体跳过）
    const picked = resolveObjectId(hit);
    expect(picked).toBe('A');
    expect(findNode(root, picked!)).not.toBeNull();
    expect(findNode(root, 'B')).not.toBeNull(); // 真实兄弟 B 仍可寻得
  });

  it('R12-2-T3 真实嵌套内容点击归属回归：内容孙网格 → 模型 id', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    attachContent('M', new THREE.Group(), root);
    const contentGroup = findNode(root, 'M')!.getObjectByName('__glb-content__')!;
    const contentGrandchild = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    contentGroup.add(contentGrandchild);

    expect(resolveObjectId(contentGrandchild)).toBe('M');
  });

  it('R12-2-T4 双品牌最近定格回归：无内容链取最近品牌', () => {
    const a = obj({ id: 'A', name: 'A', type: 'group' });
    const b = obj({ id: 'B', name: 'B', type: 'group', parentId: 'A' });
    const project = makeProject([a, b]);
    const root = buildScene(project, ASPECT);

    expect(resolveObjectId(findNode(root, 'B')!)).toBe('B');
    expect(resolveObjectId(findNode(root, 'A')!)).toBe('A');
  });

  it('R12-2-T5 非字符串 objectId 伪造：品牌真实但 id 非字符串 → 跳过并上溯（RED）', () => {
    const a = obj({ id: 'A', name: 'A', type: 'group' });
    const project = makeProject([a]);
    const root = buildScene(project, ASPECT);
    const nodeA = findNode(root, 'A')!;
    const brand = anyBrandSymbol(root);
    const fake = new THREE.Group();
    fake.userData.objectId = 123; // 品牌真实注入但 objectId 非字符串
    (fake.userData as Record<string | symbol, unknown>)[brand] = true;
    nodeA.add(fake);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    fake.add(hit);
    expect(hasBrand(fake)).toBe(true); // 探针自检：伪造确实存在

    // RED：现 HEAD 无字符串校验，candidate 定格为 123 并返回；
    // 修复后非字符串品牌不冻结、不采纳 → 上溯到 A
    expect(resolveObjectId(hit)).toBe('A');
  });

  it('R12-2-T6 全链无有效品牌：悬空内容节点 → null 不崩溃', () => {
    const project = makeProject([]);
    const root = buildScene(project, ASPECT);
    // 从带真实内容的模型探出 CONTENT_MARK 符号，注入悬空内容组
    const donor = buildScene(makeProject([obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' })]), ASPECT);
    attachContent('M', new THREE.Group(), donor);
    const contentMark = anyContentMarkSymbol(donor);
    const contentGroup = new THREE.Group();
    (contentGroup.userData as Record<string | symbol, unknown>)[contentMark] = true;
    root.add(contentGroup);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    contentGroup.add(hit);

    expect(resolveObjectId(hit)).toBeNull();
  });

  it('R12-2-T7 内容根伪造品牌回归：内容根自身带伪造品牌 → 解析到模型', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    attachContent('M', new THREE.Group(), root);
    const contentGroup = findNode(root, 'M')!.getObjectByName('__glb-content__')!;
    const brand = anyBrandSymbol(root);
    contentGroup.userData.objectId = 'fake';
    (contentGroup.userData as Record<string | symbol, unknown>)[brand] = true;
    expect(hasBrand(contentGroup)).toBe(true);

    expect(resolveObjectId(contentGroup)).toBe('M');
  });
});
