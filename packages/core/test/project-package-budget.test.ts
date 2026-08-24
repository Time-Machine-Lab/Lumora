import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { genId } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { compositeContentHash, hashBytes } from '../src/scene/assets';
import { buildProjectPackage, parseProjectPackage, serializeProjectPackage } from '../src/project/package';
import type { AssetData, AssetPartData, Project } from '../src/scene/types';

/** 小预算限额（与真实常量同语义，注入以便在可负担的尺寸上验证预算累计） */
const LIMITS = {
  maxAssetPayloadBytes: 1000,
  maxTotalPayloadBytes: 5000,
  maxAssetParts: 16,
  maxAssetsPerProject: 16,
  maxObjectsPerProject: 200,
  maxSceneDepth: 16,
} as const;

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** 含模型（引用 assets[0]，含主载荷 + 分件，真实组合哈希）的项目 */
async function buildProject(mainSize: number, partSizes: number[]): Promise<Project> {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  const mainBytes = new TextEncoder().encode('m'.repeat(mainSize));
  const parts: AssetPartData[] = partSizes.map((size, i) => ({
    path: `ext/${i}.bin`,
    mime: 'application/octet-stream',
    payload: b64(new TextEncoder().encode('p'.repeat(size))),
  }));
  const partHashes = await Promise.all(
    parts.map(async (p) => ({ path: p.path, partHash: await hashBytes(new TextEncoder().encode(atob(p.payload))) })),
  );
  const composite = await compositeContentHash(await hashBytes(mainBytes), partHashes);
  const asset: AssetData = {
    id: genId('asset'),
    kind: 'gltf',
    name: '分包模型.glb',
    format: 'glb',
    mime: 'model/gltf-binary',
    hash: composite,
    size: mainSize + partSizes.reduce((s, n) => s + n, 0),
    source: 'file',
    storageRef: 'blob:runtime-only',
    payload: b64(mainBytes),
    parts,
    createdAt: new Date().toISOString(),
  };
  editor.registerAsset(asset);
  editor.addObject({
    id: genId('obj'),
    type: 'model',
    name: '分包模型',
    parentId: null,
    transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetId: asset.id,
  });
  return editor.getProject()!;
}

/** 多资产项目：N 个主载荷资产（无分件），各自真实哈希，全部被模型对象引用 */
async function buildMultiAssetProject(assetByteSizes: number[]): Promise<Project> {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  for (const [i, size] of assetByteSizes.entries()) {
    // 内容互异（同内容同哈希会被 registerAsset 去重，无法凑出多资产）
    const bytes = new TextEncoder().encode(`${'abcdefghij'[i] ?? 'x'}`.repeat(size));
    const assetId = genId('asset');
    const asset: AssetData = {
      id: assetId,
      kind: 'gltf',
      name: `模型${i}.glb`,
      format: 'glb',
      mime: 'model/gltf-binary',
      hash: await hashBytes(bytes),
      size,
      source: 'file',
      storageRef: 'blob:runtime-only',
      payload: b64(bytes),
      createdAt: new Date().toISOString(),
    };
    editor.registerAsset(asset);
    editor.addObject({
      id: genId('obj'),
      type: 'model',
      name: `模型${i}`,
      parentId: null,
      transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      assetId,
    });
  }
  return editor.getProject()!;
}

describe('per-bundle 字节预算累计（TML-53 第三轮 #7：多分件拆分不得绕过单资产上限）', () => {
  it('主载荷 + 分件累计不超预算：正常导入', async () => {
    const project = await buildProject(700, [150, 100]); // 950 ≤ 1000
    const result = await parseProjectPackage(serializeProjectPackage(buildProjectPackage(project)), LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.assets[0]!.parts).toHaveLength(2);
  });

  it('分件把资产累计推到 0 剩余额度：下一份按「资产已满」拒绝（拆分绕过无效）', async () => {
    // 700 + 150 + 150 = 1000 恰好满额；再加 150 字节分件 → 剩余额度 0 → 解码前拒绝
    const project = await buildProject(700, [150, 150, 150]);
    const result = await parseProjectPackage(serializeProjectPackage(buildProjectPackage(project)), LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('单资产上限');
    }
  });

  it('分件累计越界（解码后精确核对路径）：剩余额度内预检通过、解码后精确核对拒绝', async () => {
    // 700 + 200 → 剩余额度 100；下一份 102 字节（136 字符 = 4*ceil(100/3) 恰好过编码预检）
    // → 解码字节 102 > 剩余 100 → 精确核对拒绝
    const project = await buildProject(700, [200, 102]);
    const result = await parseProjectPackage(serializeProjectPackage(buildProjectPackage(project)), LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('单资产上限');
    }
  });

  it('单包总预算：多资产累计超过总上限 → 拒绝', async () => {
    // 6 个资产 × 1000 字节 = 6000 > 5000；单个资产都在单资产限内
    const project = await buildMultiAssetProject([1000, 1000, 1000, 1000, 1000, 1000]);
    const result = await parseProjectPackage(serializeProjectPackage(buildProjectPackage(project)), LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('累计');
    }
  });
});

describe('载荷哈希必填与格式（TML-53 第三轮 #5：有载荷必须非空且格式明确的 hash 并无条件校验）', () => {
  it('载荷存在但 hash 缺失 → 拒绝导入', async () => {
    const project = await buildProject(700, [10]);
    const raw = JSON.parse(serializeProjectPackage(buildProjectPackage(project))) as {
      project: { assets: Array<Record<string, unknown>> };
    };
    delete raw.project.assets[0]!.hash;
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('哈希');
    }
  });

  it('载荷存在但 hash 格式非法（非 64 位十六进制）→ 拒绝导入', async () => {
    const project = await buildProject(700, [10]);
    const raw = JSON.parse(serializeProjectPackage(buildProjectPackage(project))) as {
      project: { assets: Array<Record<string, unknown>> };
    };
    raw.project.assets[0]!.hash = 'abc';
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('哈希');
    }
  });

  it('载荷存在但 hash 与内容不符（64 位但错误）→ 无条件校验拒绝', async () => {
    const project = await buildProject(700, [10]);
    const raw = JSON.parse(serializeProjectPackage(buildProjectPackage(project))) as {
      project: { assets: Array<Record<string, unknown>> };
    };
    raw.project.assets[0]!.hash = 'f'.repeat(64);
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('哈希不一致');
    }
  });
});

describe('模型主载荷强制存在（TML-53 第三轮 #6：parts-only 不得判为导入成功）', () => {
  it('被引用的模型只有外部分件、无主载荷 → 拒绝导入', async () => {
    const project = await buildProject(700, [10]);
    const raw = JSON.parse(serializeProjectPackage(buildProjectPackage(project))) as {
      assets: Record<string, { payload?: string }>;
    };
    delete Object.values(raw.assets)[0]!.payload;
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('主载荷');
    }
  });
});
