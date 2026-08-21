import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import {
  attachModelContent,
  buildScene,
  findNode,
  getReachableObjectIds,
  syncScene,
} from '../src/components/editor/scene-builder';
import * as EditorViewportModule from '../src/components/editor/EditorViewport';

vi.mock('@react-three/fiber', () => ({
  Canvas: () => null,
  useThree: () => ({ scene: null, camera: null, set: () => undefined, gl: {}, size: {} }),
  useFrame: () => undefined,
}));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null, TransformControls: () => null }));

/**
 * R10-M2 唯一节点 + OBJECT_ID_MARK 品牌（TML-57 第十轮，修复前必须失败）：
 * 现 HEAD buildSubtree 重建子树时只登记根（syncScene pass-1 单独 idToNode.set），
 * 后代未登记 → pass-2 视为缺失重建 → 分叉重建产生重复节点；所有权解析一律读
 * 原始 userData.objectId —— 用户 GLB extras 或手工伪造即可冒充/劫持对象身份。
 * 修复：OBJECT_ID_MARK Symbol 品牌（buildObject 双写，Symbol 不可能被用户数据
 * 携带），buildSubtree 登记全部节点，所有所有权读取只读品牌，遍历遇 CONTENT_MARK
 * 整体跳过子树（双保险：即使内容子树伪造 objectId/brand 也不进入）。
 * RED 格（现 HEAD 行为）：T1/T2/T4/T5 与 S3-T1/T2/T3 断言新行为，旧实现违反。
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

/** 品牌符号（模块私有）：测试经反射从已品牌节点探出描述名，用于唯一性计数 */
const OBJECT_ID_MARK_DESC = 'lumora.object-id';
function hasBrand(node: THREE.Object3D): boolean {
  return Object.getOwnPropertySymbols(node.userData).some((s) => s.description === OBJECT_ID_MARK_DESC);
}

/** 唯一性断言：每个可达对象 id 恰好一个品牌节点；树中无多余品牌节点 */
function assertUniqueOwnedNodes(root: THREE.Object3D, reachableIds: Set<string>): void {
  const counts = new Map<string, number>();
  const stack: THREE.Object3D[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (hasBrand(node)) {
      const id = node.userData.objectId as string;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  for (const id of reachableIds) {
    expect(counts.get(id), `可达对象 ${id} 应恰好一个品牌节点`).toBe(1);
  }
  for (const [id, count] of counts) {
    if (!reachableIds.has(id)) throw new Error(`多余品牌节点：${id}`);
    expect(count, `节点 ${id} 应唯一`).toBe(1);
  }
}

/** 拾取解析核心（EditorViewport findObjectId）：阶段 2 修复前不存在该导出，
 * 命名空间导入避免链接期失败，逐用例在调用处失败（TypeError → RED） */
function resolveObjectId(object: THREE.Object3D): string | null {
  const fn = (EditorViewportModule as unknown as Record<string, unknown>).findObjectId as
    | ((o: THREE.Object3D) => string | null)
    | undefined;
  if (!fn) throw new Error('findObjectId 未导出（R10-M2 修复尚未应用）');
  return fn(object);
}

describe('R10-M2 唯一节点：buildSubtree 全注册 + 品牌所有权', () => {
  it('T1 分叉重建含 2 层后代：后代全注册、无重复节点（RED）', () => {
    const pGroup = obj({ id: 'P', name: '父组', type: 'group' });
    const c = obj({ id: 'C', name: '子组', type: 'group', parentId: 'P' });
    const gc = obj({ id: 'GC', name: '孙组', type: 'group', parentId: 'C' });
    const pBox = obj({ id: 'P', name: '父块', type: 'primitive', geometry: { kind: 'box' } });
    const prev = makeProject([pGroup, c, gc]);
    const next = makeProject([pBox, c, gc]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    // RED：现 HEAD buildSubtree 仅登记根 → pass-2 重建 C/GC → 树中 C×2、GC×2
    expect(findNode(root, 'P')).toBeInstanceOf(THREE.Mesh);
    assertUniqueOwnedNodes(root, getReachableObjectIds(next));
    expect(findNode(root, 'C')!.parent!.userData.objectId).toBe('P');
  });

  it('T2 新子树全注册：新建根+后代同步后全部可解析、唯一', () => {
    const a = obj({ id: 'A', name: '父组', type: 'group' });
    const b = obj({ id: 'B', name: '子组', type: 'group', parentId: 'A' });
    const bc = obj({ id: 'BC', name: '孙组', type: 'group', parentId: 'B' });
    const prev = makeProject([a]);
    const next = makeProject([a, b, bc]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    expect(findNode(root, 'B')).not.toBeNull();
    expect(findNode(root, 'BC')).not.toBeNull();
    assertUniqueOwnedNodes(root, getReachableObjectIds(next));
  });

  it('T3 删除含子树根：残留品牌节点全部移除', () => {
    const p = obj({ id: 'P', name: '父块', type: 'primitive', geometry: { kind: 'box' } });
    const c = obj({ id: 'C', name: '子组', type: 'group', parentId: 'P' });
    const gc = obj({ id: 'GC', name: '孙组', type: 'group', parentId: 'C' });
    const prev = makeProject([p, c, gc]);
    const next = makeProject([]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    expect(findNode(root, 'P')).toBeNull();
    expect(findNode(root, 'C')).toBeNull();
    assertUniqueOwnedNodes(root, getReachableObjectIds(next));
  });

  it('T4 内容子树重同步：伪造 objectId 的网格不被登记、处置、移除（RED）', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    const node = findNode(root, 'M')!;
    // glTF extras 风格：内容网格数据来自用户 GLB，objectId 完全不可信
    const contentMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    contentMesh.userData.objectId = 'forged';
    const contentGroup = new THREE.Group();
    contentGroup.add(contentMesh);
    attachModelContent(node, { scene: contentGroup } as unknown as GLTF);
    const disposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');

    // 无变化重同步：内容子树必须原样保留（资源归 ContentCache 所有）
    syncScene(root, project, project, ASPECT);

    // RED：现 HEAD pass-6 把带 extras objectId 的内容网格当不可达对象移除并处置
    expect(contentMesh.parent).toBe(contentGroup);
    expect(disposeSpy.mock.instances).not.toContain(contentMesh.geometry);
    expect(findNode(root, 'forged')).toBeNull();
    // 内容子树零品牌：所有权只属于项目对象
    expect(hasBrand(contentMesh)).toBe(false);
    expect(hasBrand(contentGroup)).toBe(false);
  });

  it('T5 唯一性断言本体：干净树通过、重复节点树抛错', () => {
    const a = obj({ id: 'A', name: '父组', type: 'group' });
    const b = obj({ id: 'B', name: '子组', type: 'group', parentId: 'A' });
    const project = makeProject([a, b]);
    const root = buildScene(project, ASPECT);
    const reachable = getReachableObjectIds(project);
    expect(() => assertUniqueOwnedNodes(root, reachable)).not.toThrow();
    // 人为挂入第二个同结构场景 → A/B 各出现两次 → 断言必须拒绝
    root.add(buildScene(project, ASPECT));
    expect(() => assertUniqueOwnedNodes(root, reachable)).toThrow();
  });
});

describe('R10-M2 内容子树所有权隔离：品牌 + CONTENT_MARK 双保险', () => {
  it('S3-T1 普通节点伪造 objectId：findNode/findObjectId 均不解析（RED）', () => {
    const a = obj({ id: 'A', name: '组', type: 'group' });
    const project = makeProject([a]);
    const root = buildScene(project, ASPECT);
    const plain = new THREE.Group();
    plain.userData.objectId = 'forged';
    root.add(plain);

    // RED：现 HEAD findNode 按原始 objectId 命中、findObjectId 直接返回伪造值
    expect(findNode(root, 'forged')).toBeNull();
    expect(resolveObjectId(plain)).toBeNull();
  });

  it('S3-T2 内容子树伪造 objectId 重同步后：拾取解析到模型、伪造值不可查（RED）', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    const node = findNode(root, 'M')!;
    const contentMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    contentMesh.userData.objectId = 'forged-content';
    attachModelContent(node, { scene: new THREE.Group().add(contentMesh) } as unknown as GLTF);
    const contentGroup = node.getObjectByName('__glb-content__')!;

    syncScene(root, project, project, ASPECT);

    // RED：现 HEAD findObjectId 命中内容网格的伪造 objectId；修复后沿父链
    // 透明穿过内容子树解析到模型
    expect(resolveObjectId(contentMesh)).toBe('M');
    expect(findNode(root, 'forged-content')).toBeNull();
    expect(contentGroup.children).toContain(contentMesh);
  });

  it('S3-T3 CONTENT_MARK 双保险：内容节点反射伪造品牌也不解析、不被移除（RED）', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const project = makeProject([model]);
    const root = buildScene(project, ASPECT);
    const node = findNode(root, 'M')!;
    const contentMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    attachModelContent(node, { scene: new THREE.Group().add(contentMesh) } as unknown as GLTF);
    const contentGroup = node.getObjectByName('__glb-content__')!;
    // 反射取得品牌符号（模块私有；glTF extras/JSON 无法携带 Symbol——双保险
    // 针对直接注入伪造）
    const brand = Object.getOwnPropertySymbols(node.userData).find((s) => s.description === OBJECT_ID_MARK_DESC);
    contentGroup.userData.objectId = 'fake';
    (contentGroup.userData as Record<string | symbol, unknown>)[brand!] = true;
    expect(hasBrand(contentGroup)).toBe(true); // 伪造确实存在（探针自检）

    syncScene(root, project, project, ASPECT);

    // 双保险：内容根即使伪造品牌+objectId，遍历也不解析、不索引、不处置
    expect(findNode(root, 'fake')).toBeNull();
    expect(resolveObjectId(contentGroup)).toBe('M');
    expect(contentGroup.parent).toBe(node);
  });
});
