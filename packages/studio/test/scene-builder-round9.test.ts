import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSampleProject } from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import {
  attachModelContent,
  buildScene,
  findNode,
  syncScene,
} from '../src/components/editor/scene-builder';

/**
 * R9-M2 对抗测试（TML-57 第九轮 M2 节点身份/所有权，修复前必须失败）：
 * syncScene 身份判定现 HEAD 只看 type（model 多查 assetId）：
 * - T1 light kind 互换（directional→point）：type 不变 → 旧类型灯光节点被复用，
 *   点光专属属性（distance）永不生效（kind 身份分叉）；
 * - T2 父节点身份分叉重建：旧父被 remove+dispose 后子树仍挂在旧父实例下，
 *   从 root 不可达 → 未变化的子节点丢失（无最终 coordination pass）；
 * - T3 删除含子树根：removeUnreachable 对每个不可达 idToNode 各 disposeNode 一次，
 *   子节点几何被重复处置（topmost 单次处置缺失）；
 * - T6 模型身份分叉后 syncScene 未返回 rebuiltModelIds，内容重新挂载无信号。
 * T4（内容子树跳过处置）与 T5（reparent）为既有防护覆盖，现 HEAD 即绿。
 * 修复：identity = type + light.kind + camera.projection + assetId；fork 时整体
 * 子树重建 + 最终无条件 coordination pass；removeUnreachable 从 root 遍历、
 * 首个不可达节点单次 disposeNode 并跳过子树；disposeNode 线程化 insideContent。
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

describe('R9-M2 节点身份与所有权：identityKey fork、coordination、单次处置', () => {
  it('R9-M2-T1 light kind 互换（directional→point）：身份分叉整节点重建为点光', () => {
    const directional = obj({
      id: 'x',
      name: '方向灯',
      type: 'light',
      light: { kind: 'directional', color: '#ffffff', intensity: 2 },
    });
    const point = obj({
      id: 'x',
      name: '点灯',
      type: 'light',
      light: { kind: 'point', color: '#ffffff', intensity: 2, distance: 7 },
    });
    const prev = makeProject([directional]);
    const next = makeProject([point]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    const node = findNode(root, 'x');
    // RED：现 HEAD 身份判定只看 type（'light' 相同）→ 复用 DirectionalLight，
    // applyObjectData 的 PointLight 专属分支永不生效
    expect(node).toBeInstanceOf(THREE.PointLight);
    expect((node as THREE.PointLight | null)?.distance).toBe(7);
    expect(node!.userData.identityKey).toBe('light:point');
  });

  it('R9-M2-T2 父节点身份分叉重建：未变化的子节点仍在新父下可达', () => {
    const pGroup = obj({ id: 'P', name: '父组', type: 'group' });
    const c = obj({ id: 'C', name: '子组', type: 'group', parentId: 'P' });
    const pBox = obj({ id: 'P', name: '父块', type: 'primitive', geometry: { kind: 'box' } });
    const prev = makeProject([pGroup, c]);
    const next = makeProject([pBox, c]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    // RED：现 HEAD 重建 P 后旧 P 被 remove+dispose，C 仍挂在旧 P 实例下
    //（其 objectId 也是 'P'，parentId 未变 → 第三遍不重挂）→ 从 root 不可达
    const pNode = findNode(root, 'P');
    const cNode = findNode(root, 'C');
    expect(pNode).toBeInstanceOf(THREE.Mesh);
    expect(cNode).not.toBeNull();
    expect(cNode!.parent).toBe(pNode);
  });

  it('R9-M2-T3 删除含子树根：每个不可达对象只处置一次（topmost 单次）', () => {
    const p = obj({ id: 'P', name: '父块', type: 'primitive', geometry: { kind: 'box' } });
    const c = obj({ id: 'C', name: '子块', type: 'primitive', geometry: { kind: 'box' }, parentId: 'P' });
    const prev = makeProject([p, c]);
    const next = makeProject([]);
    const root = buildScene(prev, ASPECT);
    const cGeometry = findNode(root, 'C')!.geometry;
    const spy = vi.spyOn(cGeometry, 'dispose');

    syncScene(root, prev, next, ASPECT);

    // RED：现 HEAD 对 P、C 两个不可达 idToNode 各 disposeNode 一次，
    // P 的 disposeNode 递归已处置 C → C 几何被 dispose 两次
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('R9-M2-T4 删除模型：内容子树整体跳过处置（资源归 ContentCache 所有）', () => {
    const model = obj({ id: 'M', name: '模型', type: 'model', assetId: 'a1' });
    const prev = makeProject([model]);
    const next = makeProject([]);
    const root = buildScene(prev, ASPECT);
    const node = findNode(root, 'M')!;
    const contentMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    attachModelContent(node, { scene: new THREE.Group().add(contentMesh) } as unknown as GLTF);
    const contentGroup = node.getObjectByName('__glb-content__')!;
    const contentGeoms = new Set<THREE.BufferGeometry>();
    contentGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) contentGeoms.add(child.geometry);
    });
    expect(contentGeoms.size).toBeGreaterThan(0);
    const disposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');

    syncScene(root, prev, next, ASPECT);

    // syncScene 处置期间零次释放：占位框在 attach 时已释放，内容子树一个几何
    // 都不处置（共享资源不可被实例误杀）；任何内容几何被处置都会使计数 > 0
    const disposed = new Set(disposeSpy.mock.instances as THREE.BufferGeometry[]);
    expect(disposed.size).toBe(0);
    for (const geometry of contentGeoms) {
      expect(disposed.has(geometry)).toBe(false);
    }
  });

  it('R9-M2-T5 重挂靠（parentId 变化）：节点移到新父（既有覆盖）', () => {
    const p1 = obj({ id: 'P1', name: '父一', type: 'group' });
    const p2 = obj({ id: 'P2', name: '父二', type: 'group' });
    const c = obj({ id: 'C', name: '子组', type: 'group', parentId: 'P1' });
    const nextC = { ...c, parentId: 'P2' };
    const prev = makeProject([p1, p2, c]);
    const next = makeProject([p1, p2, nextC]);
    const root = buildScene(prev, ASPECT);

    syncScene(root, prev, next, ASPECT);

    const cNode = findNode(root, 'C');
    expect(cNode).not.toBeNull();
    expect(cNode!.parent!.userData.objectId).toBe('P2');
  });

  it('R9-M2-T6 模型身份分叉（换 assetId）：syncScene 返回 rebuiltModelIds 供内容重挂', () => {
    const m1 = obj({ id: 'm1', name: '模型', type: 'model', assetId: 'a1' });
    const m2 = obj({ id: 'm1', name: '模型', type: 'model', assetId: 'a2' });
    const prev = makeProject([m1]);
    const next = makeProject([m2]);
    const root = buildScene(prev, ASPECT);

    const result = syncScene(root, prev, next, ASPECT) as { rebuiltModelIds?: string[] };

    // RED：现 HEAD syncScene 返回 void → result.rebuiltModelIds 读取即 TypeError
    expect(result.rebuiltModelIds).toContain('m1');
  });
});
