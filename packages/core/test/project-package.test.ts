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
} from '../src/project/package';
import { CURRENT_PROJECT_SCHEMA_VERSION, PACKAGE_FORMAT_VERSION, PROJECT_PACKAGE_FORMAT } from '../src/project/schema';
import type { AssetData, AssetPartData, Project, SceneObjectData } from '../src/scene/types';

/** 生成含模型（含载荷）、三镜头（三场景各一台活动机位）与轨道的项目。
 *  经 SceneEditor 打开与提交构造，保证满足全部结构不变量；轨道引用模型对象。
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
  // 轨道引用模型对象（TML-88）：模型、三镜头与轨道三者同时随项目往返
  const project = editor.getProject()!;
  const track = {
    id: genId('track'),
    name: '模型位移动画',
    objectId: object.id,
    targetPath: 'position' as const,
    keyframes: [
      { time: 0, value: [0, 1, 0] as [number, number, number] },
      { time: 2, value: [0, 2, 0] as [number, number, number] },
    ],
  };
  return { ...project, tracks: [...project.tracks, track] };
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
  it('默认导出不含 pluginData 与白名单外字段；includePrivate 仅放行 pluginData', async () => {
    const project = await buildFixtureProject();
    // NFR-008 结构性隔离：凭据族字段不属于 Project schema（凭据走独立本地配置），
    // 即使非法数据混入项目，顶层白名单也保证其不进包
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

    // includePrivate：pluginData 放行（无声明时键原样保留 —— 契约不猜测键名）
    const privatePkg = buildProjectPackage(rich, { includePrivate: true });
    const privateJson = JSON.stringify(privatePkg);
    expect(privateJson).toContain('pluginData');
    expect(privateJson).toContain('theme');
    // 顶层白名单仍排除白名单外字段（credentials 不属于 Project schema）
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

describe('工程包私有数据契约（NFR-008：结构化隔离 + 声明制剥离，第十一轮）', () => {
  it('settings 契约投影：契约外键（含凭据类键名与嵌套形态）任何情况下不进包，fps/aspect 保留', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      settings: {
        ...project.settings,
        pass_word: 'pw-secret-1',
        passwd: 'pw-secret-2',
        authHeader: 'Bearer leak-3',
        apiKey: 'sk-leak-4',
        extraNested: { password: 'pw-secret-5' },
      },
    } as Project;
    for (const includePrivate of [false, true]) {
      const pkg = buildProjectPackage(rich, { includePrivate });
      const json = JSON.stringify(pkg);
      const settings = (pkg.project as unknown as { settings: Record<string, unknown> }).settings;
      expect(settings).toEqual({ fps: project.settings.fps, aspect: project.settings.aspect });
      for (const leaked of [
        'pw-secret-1',
        'pw-secret-2',
        'Bearer leak-3',
        'sk-leak-4',
        'pw-secret-5',
        'pass_word',
        'passwd',
        'authHeader',
        'extraNested',
      ]) {
        expect(json, `契约外键 ${leaked} 不得进入包`).not.toContain(leaked);
      }
    }
  });

  it('pluginData 默认整体排除；includePrivate 且无声明时凭据形态键无损保留（契约不猜测键名）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          theme: 'dark',
          apiKey: 'sk-keep-1',
          authHeader: 'Bearer keep-2',
          passwd: 'pw-keep-3',
        },
      },
    } as Project;
    const text = serializeProjectPackage(buildProjectPackage(rich));
    expect(text).not.toContain('pluginData');
    expect(text).not.toContain('sk-keep-1');

    const privateJson = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    expect(privateJson).toContain('theme');
    expect(privateJson).toContain('sk-keep-1');
    expect(privateJson).toContain('Bearer keep-2');
    expect(privateJson).toContain('pw-keep-3');
  });

  it('includePrivate + 声明剥离：manifest.privateSettings 声明的顶层键（含整棵子树）被剥除，未声明键保留', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          theme: 'dark',
          apiKey: 'sk-declared-1',
          clientSecret: 'cs-declared-2',
          accessToken: 'at-declared-3',
          auth: { apiKey: 'nested-4', accessToken: 'nested-5' },
        },
      },
    } as Project;
    const json = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        privateKeysByPlugin: { 'com.example': ['apiKey', 'clientSecret', 'accessToken', 'auth'] },
      }),
    );
    for (const leaked of ['sk-declared-1', 'cs-declared-2', 'at-declared-3', 'nested-4', 'nested-5']) {
      expect(json, `声明键值 ${leaked} 不得进入包`).not.toContain(leaked);
    }
    for (const key of ['"apiKey"', '"clientSecret"', '"accessToken"', '"auth"']) {
      expect(json, `声明键名 ${key} 不得进入包`).not.toContain(key);
    }
    expect(json).toContain('theme');
  });

  it('声明只作用于声明的插件实例：其他实例未声明的同形键保留', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.a': { apiKey: 'a-leak-1' },
        'com.b': { apiKey: 'b-keep-1' },
      },
    } as Project;
    const json = JSON.stringify(
      buildProjectPackage(rich, { includePrivate: true, privateKeysByPlugin: { 'com.a': ['apiKey'] } }),
    );
    expect(json).not.toContain('a-leak-1');
    expect(json).toContain('b-keep-1');
  });

  it('无损往返性质：pass_word/passwd/authHeader 与 benign 组合词及后缀变体未声明时导出→导入逐键一致（第十一轮严重 #2）', async () => {
    const project = await buildFixtureProject();
    const pluginData = {
      'com.example': {
        pass_word: 'pw-1',
        passwd: 'pw-2',
        authHeader: 'Bearer x',
        KEYBOARDLAYOUT: 'kb-1',
        keyboardLayoutIntl: 'kb-2',
        TOKENIZERCONFIG: 'tok-1',
        tokenizerConfigModel: 'tok-2',
        MONKEYPATCH: 'mp-1',
        HOTKEYMAP: 'hk-1',
        shortcutKeys: 'Ctrl+K',
        keyframeInterpolation: 'bezier',
        hotkeyMode: 'combo',
        tokenizerModel: 'cl100k',
      },
    };
    const pkg = buildProjectPackage({ ...project, pluginData }, { includePrivate: true });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.project.pluginData).toEqual(pluginData);
  });

  it('未知顶层字段不进入工程包（公开字段白名单）；tracks 属公开数据随包携带', async () => {
    const project = await buildFixtureProject();
    const rich = { ...project, runtimeCache: { x: 1 }, internalNote: 'zzz' } as Project & Record<string, unknown>;
    const json = JSON.stringify(buildProjectPackage(rich));
    expect(json).not.toContain('runtimeCache');
    expect(json).not.toContain('internalNote');
    expect(JSON.parse(json)).toMatchObject({ project: { tracks: project.tracks } });
  });

  it('导出导入往返 + 声明剥离：benign 组合词随包往返保留，声明键不进入包（第九轮 #4 契约化）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          keyboardLayout: 'kb-intl',
          tokenizerConfig: 'cl100k-base',
          monkeyPatch: 'off',
          hotkeyMap: 'default',
          shortcutKey: 'Ctrl+K',
          apiKey: 'sk-leak-1',
          accessToken: 'tok-leak-2',
          clientSecret: 'client-secret-3',
        },
      },
    } as Project;
    const pkg = buildProjectPackage(rich, {
      includePrivate: true,
      privateKeysByPlugin: { 'com.example': ['apiKey', 'accessToken', 'clientSecret'] },
    });
    const text = serializeProjectPackage(pkg);
    const parsed = await parseProjectPackage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    expect(plugin.keyboardLayout).toBe('kb-intl');
    expect(plugin.tokenizerConfig).toBe('cl100k-base');
    expect(plugin.monkeyPatch).toBe('off');
    expect(plugin.hotkeyMap).toBe('default');
    expect(plugin.shortcutKey).toBe('Ctrl+K');
    expect(plugin.apiKey).toBeUndefined();
    expect(plugin.accessToken).toBeUndefined();
    expect(plugin.clientSecret).toBeUndefined();
    const json = JSON.stringify(parsed.project);
    expect(json).not.toContain('sk-leak-1');
    expect(json).not.toContain('tok-leak-2');
    expect(json).not.toContain('client-secret-3');
  });
});

describe('parseProjectPackage：导出 → 导入 完整恢复（AC1）', () => {
  it('含模型与三机位的项目往返后数据与引用完整一致', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project, { exportedAt: '2026-08-21T00:00:00.000Z' });
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(result.warnings).toEqual([]);
    expect(result.project).toEqual(normalized(project));
    // 引用完整：模型对象 → 资源 → 载荷链路在恢复后依然成立
    const model = result.project.objects.find((o) => o.type === 'model')!;
    const asset = result.project.assets.find((a) => a.id === model.assetId)!;
    expect(asset.payload).toBeDefined();
    expect(result.project.scenes.filter((s) => s.activeCameraId !== null)).toHaveLength(3);
    // 轨道完整恢复（TML-88）：轨道数据与引用逐项一致
    expect(result.project.tracks).toEqual(project.tracks);
    for (const track of result.project.tracks) {
      expect(result.project.objects.some((o) => o.id === track.objectId)).toBe(true);
    }
  });

  it('__proto__ 资产 id：导入→导出→再导入 载荷与引用完整往返，无字节丢失（第四轮 #7）', async () => {
    const project = await buildFixtureProject();
    const text = serializeProjectPackage(
      buildProjectPackage(project, { exportedAt: '2026-08-21T00:00:00.000Z' }),
    );
    const first = await parseProjectPackage(text);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 把模型资产的 id 改为 __proto__：原型键写入普通对象字典会触发 setter 吞掉载荷
    const originalId = first.project.assets.find((a) => a.payload !== undefined)!.id;
    const payload = first.project.assets.find((a) => a.id === originalId)!.payload!;
    const poisoned: Project = {
      ...first.project,
      assets: first.project.assets.map((a) => (a.id === originalId ? { ...a, id: '__proto__' } : a)),
      objects: first.project.objects.map((o) =>
        o.type === 'model' && o.assetId === originalId ? { ...o, assetId: '__proto__' } : o,
      ),
    };

    // 二次导出：资产载荷必须仍在（字典写入不得被原型 setter 吞掉）
    const repacked = buildProjectPackage(poisoned);
    expect(repacked.assets['__proto__']?.payload).toBe(payload);
    // 再导入：资产与载荷完整恢复，无字节丢失
    const second = await parseProjectPackage(serializeProjectPackage(repacked));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const asset = second.project.assets.find((a) => a.id === '__proto__');
    expect(asset).toBeDefined();
    expect(asset!.payload).toBe(payload);
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
    const pkg = buildProjectPackage(project);
    // 手工构造 parts-only bundle（构建端已不产出；此处直接篡改包文本验证解析端）
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { parts?: AssetPartData[] }> };
    const bundle = Object.values(raw.assets)[0]!;
    delete (bundle as Record<string, unknown>).payload;
    bundle.parts = [
      { path: 'bin/scene.bin', mime: 'application/octet-stream', payload: btoa('valid part bytes') },
      { path: 'textures/tex.png', mime: 'image/png', payload: 'not base64!!!' },
    ];
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('外部分件');
    }
  });

  it('外部分件数超过上限 → invalid-project（拒绝解码攻击）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    // 手工构造 parts-only bundle（构建端已不产出；此处直接篡改包文本验证解析端）
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, { parts?: AssetPartData[] }> };
    const bundle = Object.values(raw.assets)[0]!;
    delete (bundle as Record<string, unknown>).payload;
    bundle.parts = Array.from({ length: MAX_ASSET_PARTS + 1 }, (_, i) => ({
      path: `ext/${i}.bin`,
      mime: 'application/octet-stream',
      payload: btoa(`part-${i}-bytes`),
    }));
    const result = await parseProjectPackage(JSON.stringify(raw));
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

  it('未引用孤儿包（包内载荷无对应资产条目）→ 拒绝导入（损坏即拒绝）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, unknown> };
    raw.assets['orphan-bundle-1'] = { payload: 'not base64!!!' };
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('孤儿');
    }
  });

  it('未引用孤儿包即使载荷合法也拒绝（无项目资产条目可挂载的 bundle 一律视为损坏）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { assets: Record<string, unknown> };
    raw.assets['orphan-bundle-1'] = { payload: btoa('orphan payload bytes') };
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-project');
      expect(result.error.message).toContain('孤儿');
    }
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
    raw.project.schemaVersion = 99;
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

  it('图关系损坏（对象挂到不存在的父级）→ invalid-project，与本地项目加载同源校验（第六轮 #2）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(project);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    const objects = raw.project.objects as Array<Record<string, unknown>>;
    objects[0]!.parentId = 'nonexistent-parent';
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-project');
    expect(result.error.message).toContain('对象缺少父级');
  });
});

describe('createBlankProject（FR-001：默认场景与摄像机）', () => {
  it('新项目含默认场景、活动机位与 16:9 画幅设置', () => {
    const project = createBlankProject('lumora://project/test', '新片场');
    expect(project.name).toBe('新片场');
    expect(project.schemaVersion).toBe(3);
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
