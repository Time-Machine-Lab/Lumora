// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createGroupObject, createModelObject, createSampleProject, hashBytes, SceneEditor } from '@lumora/core';
import type { AssetData, Project } from '@lumora/core';
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
/** gate 可选：挂起 fetch，把 GLB 解析挡在门后，用于模拟解析期间会话/场景切换 */
function stubBlobFetch(gate?: Promise<void>): void {
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:fixture-${blobSeq++}`;
    if (blob instanceof Blob) blobStore.set(url, blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', async (input: string | Request) => {
    if (gate) await gate;
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

function makeFile(name: string, bytes: Uint8Array, type = 'model/gltf-binary'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/**
 * 把真实 GLB 拆成 .gltf + 外部 .bin（glTF 2.0 容器规范）：
 * GLB 的 BIN 缓冲在 JSON 中无 uri（隐含指向 BIN chunk），注入外部引用
 * 使多文件 .gltf 拆分成立；bin 数据从 BIN chunk 头之后开始。
 */
function splitGlb(glb: Uint8Array): { gltfText: string; bin: Uint8Array } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error('unexpected first chunk');
  const jsonBytes = glb.subarray(20, 20 + jsonLength);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes).trimEnd()) as {
    buffers?: { uri?: string; byteLength?: number }[];
  };
  json.buffers = json.buffers ?? [];
  json.buffers[0] = { ...(json.buffers[0] ?? {}), uri: 'car.bin' };
  const binStart = 28 + jsonLength; // 12 头 + JSON chunk(8 头 + 数据) + BIN chunk 头
  return { gltfText: JSON.stringify(json), bin: glb.subarray(binStart) };
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

describe('第二轮修复：同 hash 统一引用、项目级缓存引用、会话绑定', () => {
  it('P0-1 不同 assetId 同 hash 的导入统一引用有效资源，去重内容不被误解析', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();

    const imported = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const hash = editor.getProject()!.assets[0]!.hash;

    // 另一导入器携带不同 assetId 的同 hash 内容：虚假载荷 + 不同 id
    const dupAsset: AssetData = {
      id: 'asset-manual-dup',
      kind: 'gltf',
      name: 'car-copy.glb',
      mime: 'model/gltf-binary',
      hash,
      size: FIXTURE.length,
      source: 'file',
      storageRef: '',
      payload: 'AAAA', // 去重短路：载荷绝不参与解析
      createdAt: '2026-01-01',
    };
    const created = editor.importModel(dupAsset, createModelObject(dupAsset.id, 'car-copy'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const project = editor.getProject()!;
    expect(project.assets).toHaveLength(1);
    const models = project.objects.filter((o) => o.type === 'model');
    expect(models).toHaveLength(2);
    // 规范化：两个对象都指向有效资源（首个导入的资产 id），而非重复导入器携带的 id
    expect(models[0]!.assetId).toBe(project.assets[0]!.id);
    expect(models[1]!.assetId).toBe(project.assets[0]!.id);
    expect(models[1]!.assetId).not.toBe('asset-manual-dup');
    expect(created.value).toBe(models[1]!.id);

    // 删除第一个实例：有效资源仍被第二个实例引用 → 资源保留
    editor.setSelection([imported.objectId]);
    okStudioDelete(editor);
    expect(editor.getProject()!.assets).toHaveLength(1);
    expect(editor.getProject()!.objects.filter((o) => o.type === 'model')).toHaveLength(1);

    // 撤销：两个实例与唯一资源全部恢复
    editor.undo();
    expect(editor.getProject()!.assets).toHaveLength(1);
    expect(editor.getProject()!.objects.filter((o) => o.type === 'model')).toHaveLength(2);
  });

  it('P0-2 Ctrl+D 复制后删除原件：缓存以项目关系为准，副本仍持有内容', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();

    const imported = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const project = editor.getProject()!;
    const hash = project.assets[0]!.hash;

    // Ctrl+D 复制：两个 model 引用同一资源，选择移到副本
    const duplicated = editor.duplicateSelection();
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const copyId = duplicated.value!.ids[0]!;
    expect(editor.getProject()!.objects.filter((o) => o.type === 'model')).toHaveLength(2);

    const root = buildScene(editor.getProject()!, 16 / 9);
    const nodeA = findNode(root, imported.objectId)!;
    const nodeB = findNode(root, copyId)!;
    attachModelContent(nodeA, cache.get(hash)!.gltf!);
    attachModelContent(nodeB, cache.get(hash)!.gltf!);
    const bodyA = nodeA.getObjectByName('BodyMesh') as THREE.Mesh;
    const bodyB = nodeB.getObjectByName('BodyMesh') as THREE.Mesh;
    expect(bodyA.geometry).toBe(bodyB.geometry);
    const disposeSpy = vi.spyOn(bodyB.geometry, 'dispose');

    // 删除原件（旧实现的引用计数会在这一步把缓存内容释放掉）
    editor.setSelection([imported.objectId]);
    okStudioDelete(editor);
    const afterDelete = editor.getProject()!;
    const remaining = afterDelete.objects.filter((o) => o.type === 'model');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(copyId);
    cache.sweep(afterDelete);
    expect(cache.has(hash)).toBe(true);
    expect(disposeSpy).not.toHaveBeenCalled();

    // 副本内容仍可从缓存挂载（项目全量 model/asset 关系才是引用依据）
    const rootAfter = buildScene(afterDelete, 16 / 9);
    const copyNode = findNode(rootAfter, copyId)!;
    attachModelContent(copyNode, cache.get(hash)!.gltf!);
    expect(copyNode.getObjectByName('BodyMesh')).not.toBeNull();
    expect(copyNode.getObjectByName(PLACEHOLDER_HINT)).toBeUndefined();

    // 删除副本：项目不再引用 → 缓存释放 GPU 资源
    editor.setSelection([copyId]);
    okStudioDelete(editor);
    cache.sweep(editor.getProject()!);
    expect(cache.has(hash)).toBe(false);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('P0-3 解析期间切换项目：取消提交、不污染新项目、缓存条目释放', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBlobFetch(gate);
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const hash = await hashBytes(new Uint8Array(FIXTURE));

    const importing = importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    // 解析挂起期间打开另一个项目（新会话）
    editor.openProject(createSampleProject());
    release();
    const result = await importing;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('项目已切换');
    // 新项目未被污染：无资源、无模型对象、无历史
    expect(editor.getProject()!.assets).toHaveLength(0);
    expect(editor.getProject()!.objects.find((o) => o.type === 'model')).toBeUndefined();
    expect(editor.getHistoryState().canUndo).toBe(false);
    // 缓存条目已释放（新会话未引用该内容）
    expect(cache.has(hash)).toBe(false);
  });

  it('P0-3 解析期间关闭项目：取消提交并释放缓存', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBlobFetch(gate);
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const hash = await hashBytes(new Uint8Array(FIXTURE));

    const importing = importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    editor.reset();
    release();
    const result = await importing;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('项目已切换');
    expect(editor.getProject()).toBeNull();
    expect(cache.has(hash)).toBe(false);
  });

  it('P0-3 解析期间切换目标场景：取消提交、缓存释放、切换历史不受影响', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBlobFetch(gate);
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const hash = await hashBytes(new Uint8Array(FIXTURE));

    const importing = importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    // 同一会话内新建并切换到场景 B：目标场景已变更
    const added = editor.addScene('场景 B');
    if (!added.ok) throw new Error(`addScene 失败: ${added.error.message}`);
    release();
    const result = await importing;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('目标场景已切换');
    // 场景切换历史保留（addScene 一步），导入未产生新历史
    const project = editor.getProject()!;
    expect(project.activeSceneId).toBe(added.value);
    expect(project.assets).toHaveLength(0);
    expect(project.objects.filter((o) => o.type === 'model')).toHaveLength(0);
    expect(cache.has(hash)).toBe(false);
  });

  it('P0-3 解析期间同内容已在新会话导入：共享条目保留，旧会话取消不释放新会话的内容', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBlobFetch(gate);
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const hash = await hashBytes(new Uint8Array(FIXTURE));

    const importing = importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    // 新会话导入同内容：命中同一条解析条目（waiters > 1）
    editor.openProject(createSampleProject());
    const fresh = importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    release();
    const results = await Promise.all([importing, fresh]);

    expect(results[0]!.ok).toBe(false);
    if (results[0]!.ok) return;
    expect((results[0] as { error: Error }).error.message).toContain('项目已切换');
    expect(results[1]!.ok).toBe(true);
    if (!results[1]!.ok) return;
    const freshResult = results[1] as { ok: true; objectId: string };
    // 新会话的导入正常提交；旧会话取消不得释放被新会话等待/引用的共享条目
    expect(editor.getProject()!.assets).toHaveLength(1);
    expect(editor.getProject()!.objects.filter((o) => o.type === 'model')).toHaveLength(1);
    expect(cache.has(hash)).toBe(true);
    // 后续清扫以项目引用为准：条目被引用 → 保留
    cache.sweep(editor.getProject()!);
    expect(cache.has(hash)).toBe(true);
    // 内容可正常挂载
    const root = buildScene(editor.getProject()!, 16 / 9);
    const freshNode = findNode(root, freshResult.objectId)!;
    attachModelContent(freshNode, cache.get(hash)!.gltf!);
    expect(freshNode.getObjectByName('BodyMesh')).not.toBeNull();
  });
});

/** 删除当前选择；失败即抛错（断言辅助） */
function okStudioDelete(editor: SceneEditor): void {
  const result = editor.deleteSelection();
  if (!result.ok) throw new Error(`expected delete ok, got: ${result.error.message}`);
}

describe('第三轮修复：生命周期 settle 清理与 .gltf 多文件', () => {
  it('M1 重开 hydrate 期间关闭项目：解析 settle 后立即清理，不依赖后续 sweep', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const imported = await importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const hash = editor.getProject()!.assets[0]!.hash;

    // 模拟重开：序列化项目 → 关闭旧会话 → 新编辑器 + 新缓存 hydrate（解析挂起）
    const serialized = JSON.parse(JSON.stringify(editor.getProject())) as Project;
    editor.reset();
    const reopened = new SceneEditor();
    reopened.openProject(serialized);
    const freshCache = new AssetCache();
    stubBlobFetch(gate); // 之后的解析全部挂在门后
    // 注意：spy 必须在最后一次 stubBlobFetch 之后创建（spyOn 每次包新 mock）
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const seeds = ensureCacheSeeded(freshCache, serialized);
    expect(seeds).toHaveLength(1);

    // hydrate 挂起期间关闭项目：解析中的条目标记待释放，条目本身仍在
    reopened.reset();
    freshCache.sweep(null);
    expect(freshCache.has(hash)).toBe(true);

    release();
    await Promise.all(seeds);
    // settle 后立即清理（无需再次 sweep）并 revoke object URL
    expect(freshCache.has(hash)).toBe(false);
    expect(revokeSpy).toHaveBeenCalled();
  });

  it('M1 导入解析期间卸载（dispose）：取消提交、无晚到写入、整体清理', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();
    const hash = await hashBytes(new Uint8Array(FIXTURE));

    stubBlobFetch(gate);
    const importing = importModelFile(editor, cache, makeFile('car.glb', FIXTURE));
    // 组件卸载：runtime.dispose → editor.dispose() + cache.dispose()
    editor.dispose();
    cache.dispose();
    expect(cache.has(hash)).toBe(false); // 整体释放立即清理解析中条目
    release();
    const result = await importing;

    // 会话失效：导入取消，无任何提交/历史/对象
    // （dispose 落在文件读取等待期间 → acquire 以「缓存已释放」拒绝；
    //  若落在解析后提交前 → 以「项目已切换」拒绝 —— 两种都是正确取消路径）
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/项目已切换|缓存已释放/);
    expect(editor.getProject()).toBeNull();
    expect(editor.getHistoryState().canUndo).toBe(false);
    // 后续写入一律拒绝（无晚到写入）
    expect(editor.addObject(createGroupObject()).ok).toBe(false);
    // dispose 后的 acquire 直接拒绝
    await expect(
      cache.acquire(hash, FIXTURE.buffer as ArrayBuffer, 'model/gltf-binary'),
    ).rejects.toThrow('缓存已释放');
  });

  it('M3 .gltf 多文件：外部 .bin 依赖映射、组合哈希去重、缺依赖失败、重开重建', async () => {
    stubBlobFetch();
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const cache = new AssetCache();

    // 把真实 GLB 拆成 .gltf + 外部 .bin；主文件放在数组末尾（按扩展名识别）
    const { gltfText, bin } = splitGlb(FIXTURE);
    const gltfBytes = new TextEncoder().encode(gltfText);
    const gltfFile = makeFile('car.gltf', gltfBytes, 'model/gltf+json');
    const binFile = makeFile('car.bin', bin, 'application/octet-stream');
    const imported = await importModelFile(editor, cache, [binFile, gltfFile]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const asset = editor.getProject()!.assets[0]!;
    expect(asset.mime).toBe('model/gltf+json');
    expect(asset.parts).toHaveLength(1);
    expect(asset.parts![0]!.path).toBe('car.bin');
    expect(asset.parts![0]!.payload.length).toBeGreaterThan(0);
    // 组合内容哈希 ≠ 仅主文件的哈希：依赖字节参与去重
    const mainOnlyHash = await hashBytes(gltfBytes);
    expect(asset.hash).not.toBe(mainOnlyHash);

    // 内容真实可挂载：外部 BIN 经 blob URL 映射后解析出几何
    const root = buildScene(editor.getProject()!, 16 / 9);
    const modelNode = findNode(root, imported.objectId)!;
    attachModelContent(modelNode, cache.get(asset.hash)!.gltf!);
    const body = modelNode.getObjectByName('BodyMesh') as THREE.Mesh;
    expect(body.geometry?.attributes.position.count).toBeGreaterThan(0);

    // 同内容再导入 → 去重（依赖一致 → 组合哈希一致）
    const again = await importModelFile(editor, cache, [gltfFile, binFile]);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.deduped).toBe(true);
    expect(editor.getProject()!.assets).toHaveLength(1);

    // 缺少依赖 → 失败，不产生历史与缓存条目
    const missing = await importModelFile(editor, cache, [gltfFile]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.message).toContain('缺少依赖文件');
    expect(editor.getHistoryState().canUndo).toBe(true); // 只有导入两步历史，缺依赖失败无新历史
    expect(cache.has(mainOnlyHash)).toBe(false);

    // 重开：仅凭项目 JSON（payload + parts）重建依赖映射并解析
    const serialized = JSON.parse(JSON.stringify(editor.getProject())) as Project;
    const freshCache = new AssetCache();
    const seeds = ensureCacheSeeded(freshCache, serialized);
    expect(seeds).toHaveLength(1);
    await Promise.all(seeds);
    const reopened = buildScene(serialized, 16 / 9);
    const reopenedNode = findNode(reopened, imported.objectId)!;
    attachModelContent(reopenedNode, freshCache.get(asset.hash)!.gltf!);
    expect(
      (reopenedNode.getObjectByName('BodyMesh') as THREE.Mesh).geometry.attributes.position.count,
    ).toBeGreaterThan(0);
  });
});
