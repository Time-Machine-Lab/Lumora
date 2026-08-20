// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createGroupObject, createSampleProject, hashBytes, SceneEditor } from '@lumora/core';
import type { Project } from '@lumora/core';
import { AssetCache, ensureCacheSeeded } from '../src/components/editor/asset-cache';
import { importModelFile } from '../src/components/editor/model-import';
import {
  attachModelContent,
  buildScene,
  findNode,
  getReachableObjectIds,
  syncScene,
} from '../src/components/editor/scene-builder';

const PLACEHOLDER_HINT = 'model-placeholder';

/**
 * 真实 GLB 夹具（scripts/gen-fixture-glb.mjs 生成并提交）：
 * CarRoot → BodyMesh（0xd9480f）+ WheelMesh1-4（共享材质 0x212529），含 BIN 缓冲。
 */
const FIXTURE = new Uint8Array(readFileSync(new URL('./fixtures/nested-mesh.glb', import.meta.url)));

/**
 * Node 环境无法 fetch blob: URL，且 GLTFLoader 一律走全局 fetch：
 * 用确定性 blob URL + fetch 桩把 URL 映射回 Blob 字节。
 */
const blobStore = new Map<string, Blob>();
let blobSeq = 0;
function stubBlobFetch(): void {
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:fixture-${blobSeq++}`;
    if (blob instanceof Blob) blobStore.set(url, blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', (input: string | Request) => {
    const url = typeof input === 'string' ? input : input.url;
    const blob = blobStore.get(url);
    if (!blob) return Promise.reject(new Error(`fetch failed: ${url}`));
    return blob.arrayBuffer().then((buffer) => ({
      status: 200,
      statusText: 'OK',
      url,
      headers: { get: () => null },
      body: undefined,
      arrayBuffer: async () => buffer,
    }));
  });
}

function makeFile(name: string, bytes: Uint8Array): File {
  return new File([new Uint8Array(bytes)], name, { type: 'model/gltf-binary' });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('真实 GLB 证据：持久化、原子性、共享资源、多场景隔离', () => {
  it('P0-1 跨运行时重开：资源以 base64 载荷持久化，新缓存从载荷重建嵌套节点与材质', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();

    const imported = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // 项目 JSON：无 blob: URL 引用，字节以 base64 载荷随项目持久化
    const serialized = JSON.parse(JSON.stringify(editor.getProject())) as Project;
    expect(JSON.stringify(serialized)).not.toContain('blob:');
    const asset = serialized.assets[0]!;
    const payload = asset.payload!;
    expect(payload).toBeDefined();
    expect(payload.length).toBeGreaterThan(0);
    expect(atob(payload)).toHaveLength(FIXTURE.length);

    // 模拟重开：全新编辑器 + 全新缓存，只凭项目 JSON（载荷）重建内容
    const reopened = new SceneEditor();
    reopened.openProject(serialized);
    const freshCache = new AssetCache();
    expect(freshCache.has(asset.hash)).toBe(false);
    const seeds = ensureCacheSeeded(freshCache, serialized);
    expect(seeds).toHaveLength(1);
    await Promise.all(seeds);

    const root = buildScene(serialized, 16 / 9);
    const modelNode = findNode(root, imported.objectId)!;
    attachModelContent(modelNode, freshCache.get(asset.hash)!.gltf!);

    // 嵌套节点结构完整
    const carRoot = modelNode.getObjectByName('CarRoot');
    expect(carRoot).not.toBeNull();
    expect(carRoot!.children.map((c) => c.name)).toEqual([
      'WheelMesh1',
      'WheelMesh2',
      'WheelMesh3',
      'WheelMesh4',
      'BodyMesh',
    ]);
    // 材质与几何真实存在（BIN 缓冲已解析）
    const body = modelNode.getObjectByName('BodyMesh') as THREE.Mesh;
    expect(body.geometry?.attributes.position.count).toBeGreaterThan(0);
    expect((body.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('d9480f');
    const wheel1 = modelNode.getObjectByName('WheelMesh1') as THREE.Mesh;
    const wheel3 = modelNode.getObjectByName('WheelMesh3') as THREE.Mesh;
    expect((wheel1.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('212529');
    // clone(true) 共享材质/几何实例（同资源多处引用的 GPU 资源共享）
    expect(wheel1.material).toBe(wheel3.material);
  });

  it('P0-2 导入原子性：导入=一步历史；撤销移除资源与对象，重做恢复资源与内容', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();

    const imported = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const hash = editor.getProject()!.assets[0]!.hash;

    const history = editor.getHistoryState();
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    // 撤销：资源与对象一并消失，缓存经清扫后无孤立条目
    editor.undo();
    let project = editor.getProject()!;
    expect(project.assets).toHaveLength(0);
    expect(project.objects.find((o) => o.id === imported.objectId)).toBeUndefined();
    cache.sweep(project);
    expect(cache.has(hash)).toBe(false);

    // 重做：资源与对象恢复，内容从持久化载荷重建（不再是占位符）
    editor.redo();
    project = editor.getProject()!;
    expect(project.assets).toHaveLength(1);
    expect(project.objects.find((o) => o.id === imported.objectId)).toBeDefined();
    const seeds = ensureCacheSeeded(cache, project);
    expect(seeds).toHaveLength(1);
    await Promise.all(seeds);
    expect(cache.has(hash)).toBe(true);

    const root = buildScene(project, 16 / 9);
    const modelNode = findNode(root, imported.objectId)!;
    attachModelContent(modelNode, cache.get(hash)!.gltf!);
    expect(modelNode.getObjectByName('BodyMesh')).not.toBeNull();
    expect(modelNode.getObjectByName(PLACEHOLDER_HINT)).toBeUndefined();
  });

  it('P0-2 解析失败：不产生历史步骤、资源与对象，缓存回滚', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const badBytes = new Uint8Array([0x01, 0x02, 0x03]);

    const result = await importModelFile(editor, cache, makeFile('bad.glb', badBytes));
    expect(result.ok).toBe(false);
    expect(editor.getProject()!.assets).toHaveLength(0);
    expect(editor.getProject()!.objects).toHaveLength(createSampleProject().objects.length);
    expect(editor.getHistoryState().canUndo).toBe(false);
    expect(cache.has(await hashBytes(badBytes))).toBe(false);
  });

  it('S-6 共享资源释放：多实例删其一不释放 GPU 资源，删尽后释放', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();

    const first = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    const second = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;
    const project = editor.getProject()!;
    // 去重：同一资源，两个模型对象
    expect(project.assets).toHaveLength(1);
    const hash = project.assets[0]!.hash;

    const root = buildScene(project, 16 / 9);
    const nodeA = findNode(root, first.objectId)!;
    const nodeB = findNode(root, second.objectId)!;
    attachModelContent(nodeA, cache.get(hash)!.gltf!);
    attachModelContent(nodeB, cache.get(hash)!.gltf!);
    const bodyA = nodeA.getObjectByName('BodyMesh') as THREE.Mesh;
    const bodyB = nodeB.getObjectByName('BodyMesh') as THREE.Mesh;
    expect(bodyA.geometry).toBe(bodyB.geometry);
    const disposeSpy = vi.spyOn(bodyB.geometry, 'dispose');

    // 删除实例 A：缓存仍有实例 B 的引用；场景树同步不释放共享几何/材质
    editor.setSelection([first.objectId]);
    editor.deleteSelection();
    const afterA = editor.getProject()!;
    cache.sweep(afterA);
    expect(cache.has(hash)).toBe(true);
    expect(disposeSpy).not.toHaveBeenCalled();
    syncScene(root, project, afterA, 16 / 9);
    expect(nodeB.getObjectByName('BodyMesh')).not.toBeNull();

    // 删除实例 B：最后一个引用消失 → 缓存释放资源
    editor.setSelection([second.objectId]);
    editor.deleteSelection();
    const afterB = editor.getProject()!;
    cache.sweep(afterB);
    expect(cache.has(hash)).toBe(false);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('S-5 多场景隔离：场景 B 的编辑/删除不进入场景 A 的视口树', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const aSceneId = editor.getProject()!.activeSceneId;
    const addedScene = editor.addScene('场景 B');
    expect(addedScene.ok).toBe(true);
    if (!addedScene.ok) return;
    const bSceneId = addedScene.value!;

    // 场景 B 中创建对象；B 的场景树含自身对象
    editor.setActiveScene(bSceneId);
    const created = editor.addObject(createGroupObject());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const bObjectId = created.value!;
    expect(findNode(buildScene(editor.getProject()!, 16 / 9), bObjectId)).not.toBeNull();

    // 切回 A：A 的视口树不含 B 的对象
    editor.setActiveScene(aSceneId);
    const projectB = editor.getProject()!;
    const aRoot = buildScene(projectB, 16 / 9);
    expect(findNode(aRoot, bObjectId)).toBeNull();
    expect(findNode(aRoot, 'sample-cube')).not.toBeNull();

    // A 树持续增量同步时，B 的变更（改名、删除）不进入 A 树
    editor.setActiveScene(bSceneId);
    editor.updateObjectProps(bObjectId, (o) => ({ ...o, name: 'B 改名' }), '改名');
    editor.setSelection([bObjectId]);
    editor.deleteSelection();
    editor.setActiveScene(aSceneId);
    syncScene(aRoot, projectB, editor.getProject()!, 16 / 9);
    expect(findNode(aRoot, bObjectId)).toBeNull();
    expect(findNode(aRoot, 'sample-cube')).not.toBeNull();
    expect(findNode(aRoot, 'sample-ground')).not.toBeNull();

    // 可达集只覆盖活动场景
    const reachable = getReachableObjectIds(editor.getProject()!);
    expect(reachable.has(bObjectId)).toBe(false);
    expect(reachable.has('sample-cube')).toBe(true);
  });
});
