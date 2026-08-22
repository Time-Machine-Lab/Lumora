import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createCameraObject, genId } from '../src/scene/create';
import { createSampleProject } from '../src/scene/sample-project';
import { createBlankProject } from '../src/project/create-project';
import { compositeContentHash, hashBytes } from '../src/scene/assets';
import {
  MAX_ASSET_PARTS,
  MAX_ASSETS_PER_PROJECT,
  MAX_OBJECTS_PER_PROJECT,
  buildProjectPackage,
  parseProjectPackage,
  serializeProjectPackage,
  stripSensitiveFields,
} from '../src/project/package';
import { PACKAGE_FORMAT_VERSION, PROJECT_PACKAGE_FORMAT } from '../src/project/schema';
import type { AssetData, AssetPartData, Project, SceneObjectData } from '../src/scene/types';

/** 生成含模型（含载荷）与三镜头（三场景各一台活动机位）的项目。
 *  经 SceneEditor 打开与提交构造，保证满足全部结构不变量。
 *  hash/size 为真实 SHA-256 与解码字节数（导入校验按内容验证哈希）。 */
async function buildFixtureProject(): Promise<Project> {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  // 三个镜头：新增两个场景，各挂一台摄像机并设为活动机位
  for (const name of ['镜头二', '镜头三']) {
    editor.addScene(name);
    const camera = createCameraObject(`机位-${name}`);
    const objectId = (editor.addObject(camera) as { value: string }).value;
    const result = editor.setActiveCamera(objectId);
    if (!result.ok) throw result.error;
  }
  // 模型资产：GLB 载荷（base64 真字节 + 真哈希）
  const rawBytes = new TextEncoder().encode('mock glb payload bytes');
  const payload = btoa(String.fromCharCode(...rawBytes));
  const asset: AssetData = {
    id: genId('asset'),
    kind: 'gltf',
    name: '测试模型.glb',
    format: 'glb',
    mime: 'model/gltf-binary',
    hash: await hashBytes(rawBytes),
    size: rawBytes.length,
    source: 'file',
    storageRef: 'blob:runtime-only',
    payload,
    createdAt: new Date().toISOString(),
  };
  editor.registerAsset(asset);
  const object: SceneObjectData = {
    id: genId('obj'),
    type: 'model',
    name: '测试模型',
    parentId: null,
    transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetId: asset.id,
  };
  editor.addObject(object);
  return editor.getProject()!;
}

/** 不含可保存载荷的资产（URL 来源，可重建缓存场景） */
async function buildPayloadlessProject(): Promise<Project> {
  const project = await buildFixtureProject();
  const asset: AssetData = {
    id: genId('asset'),
    kind: 'gltf',
    name: '远端模型.glb',
    format: 'glb',
    mime: 'model/gltf-binary',
    hash: 'remote-hash-001',
    size: 0,
    source: 'url',
    storageRef: 'blob:runtime',
    createdAt: new Date().toISOString(),
  };
  return { ...project, assets: [...project.assets, asset] };
}

/** 期望的归一化形态：storageRef 恒为空串、payload/parts 已回挂 */
function normalized(project: Project): Project {
  return {
    ...project,
    assets: project.assets.map(({ payload, parts, storageRef: _storageRef, ...rest }) => ({
      ...rest,
      storageRef: '',
      ...(payload !== undefined ? { payload } : {}),
      ...(parts !== undefined ? { parts } : {}),
    })),
  };
}

describe('buildProjectPackage：私有数据默认排除（FR-011 / NFR-008）', () => {
  it('默认导出不含 pluginData 与凭据族字段；includePrivate 仅放行 pluginData', async () => {
    const project = await buildFixtureProject();
    // NFR-008 防御：凭据族字段不属于 Project schema（凭据走独立本地配置），
    // 即使非法数据进入项目，任何情况下也不得进入包
    const rich = {
      ...project,
      pluginData: { 'com.example': { theme: 'dark' } },
      credentials: { 'ai-provider': 'sk-secret-value-xyz' },
    } as Project & { credentials: Record<string, string> };
    const pkg = buildProjectPackage(rich, { appVersion: '0.1.0', exportedAt: '2026-08-21T00:00:00.000Z' });
    expect(pkg.manifest.format).toBe(PROJECT_PACKAGE_FORMAT);
    expect(pkg.manifest.formatVersion).toBe(PACKAGE_FORMAT_VERSION);
    expect(pkg.manifest.includePrivate).toBe(false);
    expect(pkg.manifest.project.revision).toBe(project.revision);
    expect(pkg.manifest.assetCount).toBe(project.assets.filter((a) => a.payload).length);

    const serialized = serializeProjectPackage(pkg);
    expect(serialized).not.toContain('pluginData');
    expect(serialized).not.toContain('sk-secret-value-xyz');
    expect(serialized).not.toContain('credentials');
    expect(serialized).not.toContain('blob:runtime-only');

    const privatePkg = buildProjectPackage(rich, { includePrivate: true });
    const privateJson = JSON.stringify(privatePkg);
    expect(privateJson).toContain('pluginData');
    expect(privateJson).toContain('theme');
    expect(privateJson).not.toContain('sk-secret-value-xyz');
    expect(privateJson).not.toContain('credentials');
  });

  it('资产字节移入 assets 段，storageRef（运行期缓存引用）置空', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const withPayload = project.assets.filter((a) => a.payload !== undefined);
    expect(Object.keys(pkg.assets)).toHaveLength(withPayload.length);
    for (const asset of withPayload) {
      expect(pkg.assets[asset.id]?.payload).toBe(asset.payload);
    }
    for (const entry of pkg.project.assets) {
      expect(entry.storageRef).toBe('');
      expect(entry.payload).toBeUndefined();
      expect(entry.parts).toBeUndefined();
    }
  });
});

describe('工程包凭据清除（NFR-008：嵌套扩展数据递归清除）', () => {
  it('pluginData 深层嵌套的凭据族键被清除；非敏感字段保留（includePrivate）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          theme: 'dark',
          settings: { accessToken: 'tok-secret-abc', apiKey: 'key-secret-xyz' },
          api: { authorization: 'Bearer abc' },
          users: [{ name: 'u1' }, { name: 'u2', password: 'pwd-1' }],
        },
      },
    } as Project;
    const pkg = buildProjectPackage(rich, { includePrivate: true });
    const json = JSON.stringify(pkg);
    expect(json).toContain('theme');
    expect(json).toContain('u1');
    expect(json).not.toContain('tok-secret-abc');
    expect(json).not.toContain('key-secret-xyz');
    expect(json).not.toContain('Bearer abc');
    expect(json).not.toContain('pwd-1');
    expect(json).not.toContain('accessToken');
    expect(json).not.toContain('authorization');
  });

  it('对象扩展字段（customFields）中的凭据族键被递归清除', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      objects: project.objects.map((o) => ({ ...o, customFields: { note: '保留', apiKey: 'sk-secret-456' } })),
    } as Project;
    const json = JSON.stringify(buildProjectPackage(rich));
    expect(json).toContain('保留');
    expect(json).not.toContain('sk-secret-456');
    expect(json).not.toContain('apiKey');
  });

  it('未知顶层字段不进入工程包（公开字段白名单）', async () => {
    const project = await buildFixtureProject();
    const rich = { ...project, runtimeCache: { x: 1 }, internalNote: 'zzz' } as Project & Record<string, unknown>;
    const json = JSON.stringify(buildProjectPackage(rich));
    expect(json).not.toContain('runtimeCache');
    expect(json).not.toContain('internalNote');
  });

  it('stripSensitiveFields 对循环引用安全：不崩溃且敏感键清除', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a, token: 'secret' };
    a.b = b;
    stripSensitiveFields(a);
    expect(a.b).toBe(b);
    expect(b.token).toBeUndefined();
    expect(b.a).toBe(a);
  });
});

describe('parseProjectPackage：导出 → 导入 完整恢复（AC1）', () => {
  it('含模型与三机位的项目往返后数据与引用完整一致', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project, { exportedAt: '2026-08-21T00:00:00.000Z' });
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.project).toEqual(normalized(project));
    // 引用完整：模型对象 → 资源 → 载荷链路在恢复后依然成立
    const model = result.project.objects.find((o) => o.type === 'model')!;
    const asset = result.project.assets.find((a) => a.id === model.assetId)!;
    expect(asset.payload).toBeDefined();
    expect(result.project.scenes.filter((s) => s.activeCameraId !== null)).toHaveLength(3);
  });

  it('缺失资产载荷 → 打开成功但给出缺失明细（缺失资产报告）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    // 人为移除全部资产载荷，模拟包内资产丢失
    pkg.assets = {};
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const withPayload = project.assets.filter((a) => a.payload !== undefined);
    expect(result.warnings).toHaveLength(withPayload.length);
    for (const warning of result.warnings) {
      expect(warning.reason).toBe('payload-missing');
      expect(project.assets.find((a) => a.id === warning.assetId)).toBeDefined();
    }
    // 项目仍可打开：模型对象引用仍指向已注册资源
    const model = result.project.objects.find((o) => o.type === 'model')!;
    expect(result.project.assets.some((a) => a.id === model.assetId)).toBe(true);
    expect(result.project.assets.find((a) => a.id === model.assetId)!.payload).toBeUndefined();
  });

  it('无载荷资产的往返不产生缺失报告（本就无可保存内容）', async () => {
    const project = await buildPayloadlessProject();
    const pkg = buildProjectPackage(project);
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });
});

describe('parseProjectPackage：损坏资产载荷一律拒绝导入（严重项回归）', () => {
  it('非法 base64 字符 → invalid-project', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { payload: string }> };
    const key = Object.keys(raw.assets)[0]!;
    raw.assets[key]!.payload = 'not base64!!!';
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-project');
  });

  it('base64 填充不规范（aB== 尾部非零位，重编码为 aA==）→ invalid-project', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { payload: string }> };
    const key = Object.keys(raw.assets)[0]!;
    raw.assets[key]!.payload = 'aB==';
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('填充');
    }
  });

  it('空载荷 → invalid-project', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { payload: string }> };
    const key = Object.keys(raw.assets)[0]!;
    raw.assets[key]!.payload = '';
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('空载荷');
    }
  });

  it('解码字节数与声明 size 不一致（双向精确核对，偏大方向）→ invalid-project', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { payload: string }> };
    const key = Object.keys(raw.assets)[0]!;
    raw.assets[key]!.payload = btoa('much larger payload content than declared');
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('声明 size');
    }
  });

  it('解码字节数与声明 size 不一致（偏小方向：3 字节 vs size 999）→ invalid-project', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as {
      assets: Record<string, { payload: string }>;
      project: { assets: Array<Record<string, unknown>> };
    };
    const key = Object.keys(raw.assets)[0]!;
    raw.assets[key]!.payload = btoa('xyz');
    const entry = raw.project.assets.find((a) => a.id === key)!;
    entry.size = 999;
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('声明 size');
    }
  });

  it('SHA-256 与声明 hash 不一致（同长不同内容）→ invalid-project', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { payload: string }> };
    const key = Object.keys(raw.assets)[0]!;
    // 与原载荷同长（22 字节）：先通过 size 精确核对，再由哈希校验拦截
    raw.assets[key]!.payload = btoa('mock glb payload bytez');
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('哈希不一致');
    }
  });

  it('外部分件载荷非法 → invalid-project', async () => {
    const project = await buildFixtureProject();
    const parts: AssetPartData[] = [
      { path: 'bin/scene.bin', mime: 'application/octet-stream', payload: btoa('valid part bytes') },
      { path: 'textures/tex.png', mime: 'image/png', payload: 'not base64!!!' },
    ];
    const rich = { ...project, assets: [{ ...project.assets[0]!, payload: undefined, parts }] } as Project;
    const pkg = buildProjectPackage(rich);
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('外部分件');
    }
  });

  it('外部分件数超过上限 → invalid-project（拒绝解码攻击）', async () => {
    const project = await buildFixtureProject();
    const parts: AssetPartData[] = Array.from({ length: MAX_ASSET_PARTS + 1 }, (_, i) => ({
      path: `ext/${i}.bin`,
      mime: 'application/octet-stream',
      payload: btoa(`part-${i}-bytes`),
    }));
    const rich = { ...project, assets: [{ ...project.assets[0]!, payload: undefined, parts }] } as Project;
    const pkg = buildProjectPackage(rich);
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('外部分件数超过上限');
    }
  });

  it('对象数超过上限 → too-large', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    const base = (raw.project.objects as Array<Record<string, unknown>>)[0]!;
    raw.project.objects = Array.from({ length: MAX_OBJECTS_PER_PROJECT + 1 }, (_, i) => ({
      ...base,
      id: `inflated-${i}`,
    }));
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('too-large');
      expect(result.error.message).toContain('对象数超过上限');
    }
  });

  it('资产数超过上限 → too-large', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    const base = (raw.project.assets as Array<Record<string, unknown>>)[0]!;
    raw.project.assets = Array.from({ length: MAX_ASSETS_PER_PROJECT + 1 }, (_, i) => ({
      ...base,
      id: `inflated-asset-${i}`,
    }));
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('too-large');
      expect(result.error.message).toContain('资产数超过上限');
    }
  });
});

describe('parseProjectPackage：多文件模型（.gltf + 外部分件）组合哈希（阻断项回归）', () => {
  /** 构建含真实主载荷 + 2 个外部分件（真实组合哈希）的项目 */
  async function buildMultipartProject(): Promise<Project> {
    const project = await buildFixtureProject();
    const mainBytes = new TextEncoder().encode('gltf-json-main-content-0123456789');
    const partA = new TextEncoder().encode('bin-scene-bytes-AAAA');
    const partB = new TextEncoder().encode('tex-png-bytes-BBBB');
    const parts: AssetPartData[] = [
      { path: 'bin/scene.bin', mime: 'application/octet-stream', payload: btoa(String.fromCharCode(...partA)) },
      { path: 'textures/tex.png', mime: 'image/png', payload: btoa(String.fromCharCode(...partB)) },
    ];
    const partHashes = await Promise.all(
      parts.map(async (p) => ({ path: p.path, partHash: await hashBytes(new TextEncoder().encode(atob(p.payload))) })),
    );
    const composite = await compositeContentHash(await hashBytes(mainBytes), partHashes);
    return {
      ...project,
      assets: [
        {
          ...project.assets[0]!,
          payload: btoa(String.fromCharCode(...mainBytes)),
          parts,
          hash: composite,
          size: mainBytes.length + partA.length + partB.length,
        },
      ],
    };
  }

  it('真实多文件往返：组合哈希校验通过，主载荷与分件完整恢复（与模型导入同一算法）', async () => {
    const project = await buildMultipartProject();
    const pkg = buildProjectPackage(project);
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.project.assets.find((a) => a.id === project.assets[0]!.id)!;
    expect(asset.payload).toBe(pkg.assets[project.assets[0]!.id]!.payload);
    expect(asset.parts).toEqual(project.assets[0]!.parts);
    expect(result.warnings).toEqual([]);
  });

  it('篡改任意外部分件 → 组合哈希不一致 → 拒绝导入', async () => {
    const project = await buildMultipartProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as {
      assets: Record<string, { parts?: AssetPartData[] }>;
    };
    const bundle = Object.values(raw.assets)[0]!;
    // 同长篡改（18 字节）：先通过 size 精确核对，再由组合哈希校验拦截
    bundle.parts![1]!.payload = btoa('tampered-part-XYZQ');
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('哈希不一致');
    }
  });

  it('声明了 parts 却为空数组 → 视为损坏 → 拒绝导入', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { parts?: unknown }> };
    const bundle = Object.values(raw.assets)[0]!;
    bundle.parts = [];
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('外部分件为空');
    }
  });

  it('未引用孤儿包（包内载荷无对应资产条目）→ 同样全量校验，损坏即拒绝（无法绕过校验）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, unknown> };
    raw.assets['orphan-bundle-1'] = { payload: 'not base64!!!' };
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('未引用资产');
    }
  });

  it('未引用孤儿包合法载荷可通过（校验不误杀，仅要求完整性与计入累计）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, unknown> };
    raw.assets['orphan-bundle-1'] = { payload: btoa('orphan payload bytes') };
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(true);
  });
});

describe('parseProjectPackage：损坏包与未知 schema 拒绝（AC3）', () => {
  it('非 JSON 文本 → not-json', async () => {
    const result = await parseProjectPackage('这不是 JSON {{{');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-json');
    expect(result.error.message).toContain('JSON');
  });

  it('缺少 manifest → invalid-manifest', async () => {
    const result = await parseProjectPackage('{"project":{}}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-manifest');
  });

  it('format 不是 lumora.project → invalid-manifest', async () => {
    const result = await parseProjectPackage(
      JSON.stringify({ manifest: { format: 'other.format', formatVersion: 1 }, project: {} }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-manifest');
    expect(result.error.message).toContain('不是 Lumora 工程包');
  });

  it('未来 formatVersion → unsupported-format-version（升级提示）', async () => {
    const result = await parseProjectPackage(
      JSON.stringify({ manifest: { format: PROJECT_PACKAGE_FORMAT, formatVersion: 99 }, project: {} }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported-format-version');
    expect(result.error.message).toContain('升级');
  });

  it('非法 formatVersion（0）→ invalid-manifest', async () => {
    const result = await parseProjectPackage(
      JSON.stringify({ manifest: { format: PROJECT_PACKAGE_FORMAT, formatVersion: 0 }, project: {} }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-manifest');
  });

  it('未知未来 schemaVersion → migration-failed（升级提示，不猜测解释）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    raw.project.schemaVersion = 3;
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('migration-failed');
    expect(result.error.message).toContain('升级');
  });

  it('缺少 schemaVersion → migration-failed（schemaVersion 必填）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    delete raw.project.schemaVersion;
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('migration-failed');
    expect(result.error.message).toContain('schemaVersion');
  });

  it('项目数据校验失败 → invalid-project 并给出失败明细', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    const objects = raw.project.objects as Array<Record<string, unknown>>;
    objects[0]!.transform = { position: [NaN, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-project');
    expect(result.error.message).toContain('校验失败');
  });
});

describe('createBlankProject（FR-001：默认场景与摄像机）', () => {
  it('新项目含默认场景、活动机位与 16:9 画幅设置', () => {
    const project = createBlankProject('lumora://project/test', '新片场');
    expect(project.name).toBe('新片场');
    expect(project.schemaVersion).toBe(2);
    expect(project.revision).toBe(0);
    expect(project.settings).toEqual({ fps: 24, aspect: [16, 9] });
    expect(project.scenes).toHaveLength(1);
    const scene = project.scenes[0]!;
    expect(scene.name).toBe('主场景');
    expect(scene.rootObjectIds).toHaveLength(1);
    const camera = project.objects.find((o) => o.id === scene.activeCameraId)!;
    expect(camera.type).toBe('camera');
    expect(project.objects).toHaveLength(1);
  });

  it('生成的 uri 不冲突且可被 SceneEditor 打开', () => {
    const project = createBlankProject();
    const editor = new SceneEditor();
    expect(() => editor.openProject(project)).not.toThrow();
  });
});
