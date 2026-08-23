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
  it('默认导出不含 pluginData 与白名单外字段；includePrivate 按命名空间 allowlist 放行已注册插件', async () => {
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

    // includePrivate 但未携带任何插件声明映射：fail-closed —— 全部命名空间排除，
    // 没有 manifest 声明的来源数据绝不进入包（第十二轮阻断 2）
    const noMappingJson = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    expect(noMappingJson).not.toContain('pluginData');
    expect(noMappingJson).not.toContain('theme');

    // includePrivate + 已注册插件键级 allowlist：只有显式声明的键进包
    // （第十三轮阻断 2：空 allowlist = 无公开字段 = 整段排除）
    const privatePkg = buildProjectPackage(rich, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['theme'] },
    });
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

  it('pluginData 默认整体排除；includePrivate 无声明映射或空声明时一律 fail-closed 整段排除（第十三轮阻断 2）', async () => {
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

    // includePrivate 但无声明映射（调用方未提供任何插件注册信息）：命名空间
    // 整体排除（第十二轮阻断 2）—— 凭据形态值绝不因 fail-open 进入包
    const noMappingJson = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    expect(noMappingJson).not.toContain('pluginData');
    expect(noMappingJson).not.toContain('sk-keep-1');
    expect(noMappingJson).not.toContain('Bearer keep-2');

    // includePrivate + 已注册插件空声明（无公开字段）：整段排除 —— 已注册但空/
    // 漏声明一律不整段放行，凭据形态值绝不因 fail-open 进入包（第十三轮阻断 2）
    const emptyJson = JSON.stringify(
      buildProjectPackage(rich, { includePrivate: true, publicKeysByPlugin: { 'com.example': [] } }),
    );
    expect(emptyJson).not.toContain('theme');
    expect(emptyJson).not.toContain('sk-keep-1');
    expect(emptyJson).not.toContain('Bearer keep-2');
    expect(emptyJson).not.toContain('pw-keep-3');

    // includePrivate + 显式 allowlist：只保留声明的键
    const privateJson = JSON.stringify(
      buildProjectPackage(rich, { includePrivate: true, publicKeysByPlugin: { 'com.example': ['theme'] } }),
    );
    expect(privateJson).toContain('theme');
    expect(privateJson).not.toContain('sk-keep-1');
    expect(privateJson).not.toContain('Bearer keep-2');
    expect(privateJson).not.toContain('pw-keep-3');
  });

  it('includePrivate + 键级 allowlist：路径声明导出嵌套公开字段；整对象声明与凭据形态键声明拒绝（第十五轮阻断 1）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          theme: 'dark',
          layout: { panel: 'left', density: 'compact' },
          apiKey: 'sk-declared-1',
          clientSecret: 'cs-declared-2',
          accessToken: 'at-declared-3',
          auth: { apiKey: 'nested-4', accessToken: 'nested-5' },
        },
      },
    } as Project;
    // 路径声明是导出嵌套对象字段的唯一合法形态（字符串声明仅接受 primitive 叶值）
    const json = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': [['layout', 'panel'], ['layout', 'density']] },
      }),
    );
    for (const kept of ['left', 'compact']) {
      expect(json, `路径声明值 ${kept} 必须进入包`).toContain(kept);
    }
    expect(json, '未声明的 theme 不得进入包').not.toContain('theme');

    // 整对象声明（layout 值为对象，非 primitive 叶值）→ 剥离，绝不绕过递归投影
    const objectJson = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['layout'] },
      }),
    );
    expect(objectJson, '整对象声明不得导出子树').not.toContain('panel');
    expect(objectJson, '整对象声明不得导出子树').not.toContain('density');

    // 凭据形态键声明（顶层键或路径任意段含 apikey/password/token/secret/auth
    // 等形态子串）→ 整条声明拒绝：即使显式 allowlist 声明，值也不得进包
    const credentialJson = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: {
          'com.example': ['apiKey', 'clientSecret', 'accessToken', 'auth', ['auth', 'apiKey']],
        },
      }),
    );
    for (const leaked of ['sk-declared-1', 'cs-declared-2', 'at-declared-3', 'nested-4', 'nested-5']) {
      expect(credentialJson, `凭据形态键值 ${leaked} 不得进入包`).not.toContain(leaked);
    }
    expect(credentialJson, '凭据声明拒绝后整段不残留').not.toContain('apiKey');
  });

  it('声明只作用于声明的插件实例：未知命名空间与空声明实例一律排除（第十三轮阻断 2）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.a': { apiKey: 'a-leak-1', theme: 'a-theme' },
        'com.b': { apiKey: 'b-keep-1', theme: 'b-theme' },
      },
    } as Project;
    // 仅 com.a 注册（allowlist 只含 theme）：apiKey 不导出；com.b 是未知命名空间
    // → 整体排除（隔离 fail-closed，第十二轮阻断 2）
    const json = JSON.stringify(
      buildProjectPackage(rich, { includePrivate: true, publicKeysByPlugin: { 'com.a': ['theme'] } }),
    );
    expect(json).not.toContain('a-leak-1');
    expect(json).toContain('a-theme');
    expect(json).not.toContain('b-keep-1');
    // com.b 已注册但空声明（无公开字段）：整段排除 —— 已注册不构成放行依据
    const bothJson = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.a': ['theme'], 'com.b': [] },
      }),
    );
    expect(bothJson).not.toContain('a-leak-1');
    expect(bothJson).not.toContain('b-keep-1');
    expect(bothJson).not.toContain('b-theme');
    // com.b 显式声明非凭据键为可导出：该实例键进包
    const explicitJson = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.a': ['theme'], 'com.b': ['theme'] },
      }),
    );
    expect(explicitJson).toContain('b-theme');
    expect(explicitJson).not.toContain('b-keep-1');
    expect(explicitJson).not.toContain('a-leak-1');
    // com.b 显式声明凭据形态键（apiKey）：声明被拒，值不得进包（第十五轮阻断 1）
    const credentialJson = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.a': ['theme'], 'com.b': ['apiKey'] },
      }),
    );
    expect(credentialJson, '凭据形态键声明拒绝').not.toContain('b-keep-1');
    expect(credentialJson, '其他实例声明不受影响').toContain('a-theme');
  });

  it('无损往返性质：非凭据键显式 allowlist 放行时导出→导入逐键一致；凭据形态键声明拒绝（第十一轮严重 #2 + 第十三轮 + 第十五轮阻断 1 + 第十七轮阻断 1）', async () => {
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
    // 空声明（无公开字段）：整段排除，任何键都不进包（第十三轮阻断 2）
    const emptyPkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': [] },
    });
    const emptyParsed = await parseProjectPackage(serializeProjectPackage(emptyPkg));
    expect(emptyParsed.ok).toBe(true);
    if (!emptyParsed.ok) return;
    expect(emptyParsed.project.pluginData).toBeUndefined();
    // 显式 allowlist（宿主核验过的全部键）：非凭据键逐键无损往返，值不被改动；
    // 凭据形态键（pass_word/passwd/authHeader 含 pass/passwd/auth 分词）声明
    // 逐条拒绝 —— allowlist 放行不豁免凭据形态（第十五轮阻断 1）；完整词
    // 匹配下 tokenizer*/keyboard* 等合法键（旧子串检测误剥）正常往返
    // （第十七轮阻断 1/严重 2）
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': Object.keys(pluginData['com.example']) },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const expected = { ...pluginData['com.example'] };
    for (const credentialKey of ['pass_word', 'passwd', 'authHeader'] as const) {
      delete expected[credentialKey];
    }
    expect(parsed.project.pluginData).toEqual({ 'com.example': expected });
  });

  it('凭据形态判定为完整词匹配：分隔符/camelCase 组合词顶层与嵌套路径一律拒绝，含 token/auth 子串的合法键放行（第十七轮阻断 1/严重 2 回归）', async () => {
    const project = await buildFixtureProject();
    const pluginData = {
      'com.example': {
        // 拒绝组：snake/kebab/dot/plain 分隔符组合词与 camelCase 组合词
        api_key: 'leak-1',
        pass_word: 'leak-2',
        private_key: 'leak-3',
        'api.key': 'leak-4',
        'pass-word': 'leak-5',
        apiKey: 'leak-6',
        password: 'leak-7',
        passwd: 'leak-8',
        api: 'leak-9',
        credentials: 'leak-10',
        accessToken: 'leak-11',
        clientSecret: 'leak-12',
        authHeader: 'leak-13',
        auth: 'leak-14',
        // privateSettings 显式拒绝语义保留（'private' 分词命中）
        privateSettings: 'leak-15',
        // 放行组：完整词包含 token/auth 的合法键（旧子串匹配误剥）
        tokenizerConfig: 'keep-1',
        tokenizerModel: 'keep-2',
        authorName: 'keep-3',
        authorizationMode: 'keep-4',
        tokenizerConfigModel: 'keep-5',
        keyboardLayout: 'keep-6',
        MONKEYPATCH: 'keep-7',
        HOTKEYMAP: 'keep-8',
      },
    };
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': Object.keys(pluginData['com.example']) },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    expect(plugin.tokenizerConfig).toBe('keep-1');
    expect(plugin.tokenizerModel).toBe('keep-2');
    expect(plugin.authorName).toBe('keep-3');
    expect(plugin.authorizationMode).toBe('keep-4');
    expect(plugin.tokenizerConfigModel).toBe('keep-5');
    expect(plugin.keyboardLayout).toBe('keep-6');
    expect(plugin.MONKEYPATCH).toBe('keep-7');
    expect(plugin.HOTKEYMAP).toBe('keep-8');
    const json = JSON.stringify(parsed.project);
    for (let i = 1; i <= 15; i += 1) expect(json).not.toContain(`leak-${i}`);
    for (let i = 1; i <= 8; i += 1) expect(json).toContain(`keep-${i}`);
    // 嵌套路径声明同判据：路径任意层命中凭据词整条声明拒绝；合法组合词路径放行
    const nestedPkg = buildProjectPackage(
      {
        ...project,
        pluginData: {
          'com.example': {
            profile: {
              username: 'alice',
              api_key: 'n-1',
              pass_word: 'n-2',
              'api.key': 'n-3',
              'pass-word': 'n-4',
              private_key: 'n-5',
              apiKey: 'n-6',
              tokenizerConfig: 'n-ok-1',
              authorName: 'n-ok-2',
              authorizationMode: 'n-ok-3',
            },
          },
        },
      },
      {
        includePrivate: true,
        publicKeysByPlugin: {
          'com.example': [
            ['profile', 'username'],
            ['profile', 'api_key'],
            ['profile', 'pass_word'],
            ['profile', 'api.key'],
            ['profile', 'pass-word'],
            ['profile', 'private_key'],
            ['profile', 'apiKey'],
            ['profile', 'tokenizerConfig'],
            ['profile', 'authorName'],
            ['profile', 'authorizationMode'],
          ],
        },
      },
    );
    const nestedParsed = await parseProjectPackage(serializeProjectPackage(nestedPkg));
    expect(nestedParsed.ok).toBe(true);
    if (!nestedParsed.ok) return;
    const nested = (nestedParsed.project.pluginData as Record<string, { profile: Record<string, string> }>)['com.example'];
    expect(nested).toEqual({
      profile: {
        username: 'alice',
        tokenizerConfig: 'n-ok-1',
        authorName: 'n-ok-2',
        authorizationMode: 'n-ok-3',
      },
    });
  });

  it('未知顶层字段不进入工程包（公开字段白名单）；tracks 属公开数据随包携带', async () => {
    const project = await buildFixtureProject();
    const rich = { ...project, runtimeCache: { x: 1 }, internalNote: 'zzz' } as Project & Record<string, unknown>;
    const json = JSON.stringify(buildProjectPackage(rich));
    expect(json).not.toContain('runtimeCache');
    expect(json).not.toContain('internalNote');
    expect(JSON.parse(json)).toMatchObject({ project: { tracks: project.tracks } });
  });

  it('导出导入往返 + 键级 allowlist：显式声明的键随包往返保留，未声明键（benign 组合词）与凭据形态键声明不进入包（第九轮 #4 契约化 + 第十三轮阻断 2 + 第十五轮阻断 1）', async () => {
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
      publicKeysByPlugin: {
        'com.example': [
          'keyboardLayout',
          'monkeyPatch',
          'tokenizerConfig',
          'apiKey',
          'accessToken',
          'clientSecret',
        ],
      },
    });
    const text = serializeProjectPackage(pkg);
    const parsed = await parseProjectPackage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    // 声明的非凭据键随包往返保留；未声明键（benign 组合词）一律排除
    expect(plugin.keyboardLayout).toBe('kb-intl');
    expect(plugin.monkeyPatch).toBe('off');
    expect(plugin.hotkeyMap).toBeUndefined();
    expect(plugin.shortcutKey).toBeUndefined();
    // 完整词匹配（第十七轮阻断 1/严重 2）：tokenizerConfig 是合法键（含 token
    // 子串但不构成凭据词），声明即放行；apiKey/accessToken/clientSecret 分词
    // 命中 api/token/secret，声明逐条拒绝，值绝不进包（第十五轮阻断 1）
    expect(plugin.tokenizerConfig).toBe('cl100k-base');
    expect(plugin.apiKey).toBeUndefined();
    expect(plugin.accessToken).toBeUndefined();
    expect(plugin.clientSecret).toBeUndefined();
    const json = JSON.stringify(parsed.project);
    expect(json).not.toContain('sk-leak-1');
    expect(json).not.toContain('tok-leak-2');
    expect(json).not.toContain('client-secret-3');
    expect(json).toContain('cl100k-base');
    expect(json).toContain('kb-intl');
  });
});

describe('每层公开 DTO 契约投影与声明查询加固（第十二轮阻断 1 / 一般 8 / 一般 9）', () => {
  it('嵌套凭据不进包：objects/scenes/tracks/资产元数据中的契约外字段默认导出与 includePrivate 一律排除', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      scenes: project.scenes.map((scene) => ({ ...scene, apiKey: 'scene-secret', internalNote: 'zzz' })),
      objects: project.objects.map((object) => ({
        ...object,
        apiKey: 'object-secret',
        ...(object.transform ? { transform: { ...object.transform, apiKey: 'transform-secret' } } : {}),
      })),
      tracks: project.tracks.map((track) => ({
        ...track,
        apiKey: 'track-secret',
        keyframes: track.keyframes.map((frame) => ({ ...frame, apiKey: 'keyframe-secret' })),
      })),
      assets: project.assets.map((asset) => ({ ...asset, apiKey: 'asset-secret', credentials: 'asset-cred' })),
    } as unknown as Project;
    for (const includePrivate of [false, true]) {
      const packed = buildProjectPackage(rich, { includePrivate });
      const json = JSON.stringify(packed);
      for (const leaked of [
        'scene-secret',
        'object-secret',
        'transform-secret',
        'track-secret',
        'keyframe-secret',
        'asset-secret',
        'asset-cred',
      ]) {
        expect(json, `${leaked}（includePrivate=${includePrivate}）不得进入包`).not.toContain(leaked);
      }
      // 契约字段完整保留：逐层投影与 settings 同一机制，不丢公开数据
      const raw = JSON.parse(json) as { project: { scenes: unknown[]; objects: unknown[]; tracks: unknown[] } };
      expect(raw.project.scenes).toEqual(
        project.scenes.map(({ id, name, rootObjectIds, activeCameraId }) => ({ id, name, rootObjectIds, activeCameraId })),
      );
      expect(raw.project.objects).toEqual(project.objects);
      expect(raw.project.tracks).toEqual(project.tracks);
    }
  });

  it('访问器契约字段拒绝导出：descriptor 预检在读取时拒绝，克隆不物化 getter（第十二轮一般 #8）', async () => {
    const project = await buildFixtureProject();
    const object = project.objects[0]!;
    const poisoned = {
      ...project,
      objects: project.objects.map((o) =>
        o.id === object.id
          ? Object.defineProperty({ ...o }, 'transform', {
              get: () => o.transform,
              enumerable: true,
            })
          : o,
      ),
    } as unknown as Project;
    expect(() => buildProjectPackage(poisoned)).toThrow(/访问器属性/);
    expect(() => buildProjectPackage(poisoned, { includePrivate: true })).toThrow(/访问器属性/);
  });

  it('继承字段视为不存在：不进包（第十二轮一般 #8）', async () => {
    const project = await buildFixtureProject();
    const object = project.objects[0]!;
    const withProto = Object.create({ apiKey: 'inherited-secret' });
    Object.assign(withProto, object);
    const json = JSON.stringify(buildProjectPackage({ ...project, objects: [withProto] } as unknown as Project));
    expect(json).not.toContain('inherited-secret');
  });

  it('非枚举 own 契约字段与 structuredClone 一致：投影视图含该字段，包内容不丢（第十二轮一般 #8）', async () => {
    const project = await buildFixtureProject();
    const object = project.objects[0]!;
    const nonEnumerable = Object.defineProperty({ ...object }, 'name', { value: '非枚举名称', enumerable: false });
    const json = JSON.stringify(buildProjectPackage({ ...project, objects: [nonEnumerable] } as unknown as Project));
    expect(json).toContain('非枚举名称');
  });

  it('__proto__ 命名空间、allowlist 键与原型链注入不进入包（第十二轮一般 #9 + 第十三轮一般 #7）', async () => {
    const project = await buildFixtureProject();
    // 无原型字典携带 __proto__ own 键：Object.hasOwn 判定防原型链命中，未知命名空间排除
    const pluginData = Object.create(null) as Record<string, unknown>;
    pluginData['__proto__'] = { apiKey: 'proto-secret-1' };
    pluginData['com.example'] = { theme: 'dark' };
    const json = JSON.stringify(
      buildProjectPackage({ ...project, pluginData } as unknown as Project, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['theme'] },
      }),
    );
    expect(json).not.toContain('proto-secret-1');
    expect(json).toContain('theme');
    // 声明表以 __proto__ own 键注入 + pluginData 值同拥 own __proto__：
    // '__proto__' 不得被当作合法 allowlist 项放行（原型污染矢量），正常声明不受影响；
    // apiKey 凭据形态声明一并拒绝（第十五轮阻断 1）
    const declarations = Object.create(null) as Record<string, string[]>;
    declarations['__proto__'] = ['apiKey'];
    declarations['com.example'] = ['apiKey', '__proto__', 'theme'];
    const poisonedValue = Object.create(null) as Record<string, unknown>;
    poisonedValue['apiKey'] = 'sk-strip-1';
    poisonedValue['theme'] = 'dark';
    poisonedValue['__proto__'] = { pollute: 'proto-polluted' };
    const rich = { ...project, pluginData: { 'com.example': poisonedValue } } as Project;
    const strippedJson = JSON.stringify(
      buildProjectPackage(rich, { includePrivate: true, publicKeysByPlugin: declarations }),
    );
    expect(strippedJson).toContain('dark');
    expect(strippedJson, '凭据形态键声明拒绝（第十五轮阻断 1）').not.toContain('sk-strip-1');
    expect(strippedJson).not.toContain('proto-polluted');
    expect(strippedJson).not.toContain('"__proto__"');
  });

  it('非数组声明不崩溃：视为无公开字段，该命名空间整段排除（fail-closed，第十三轮一般 #7）', async () => {
    const project = await buildFixtureProject();
    const rich = { ...project, pluginData: { 'com.example': { apiKey: 'sk-nonarray-1', theme: 'dark' } } } as Project;
    const json = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': 'apiKey' as unknown as string[] },
      }),
    );
    expect(json).not.toContain('sk-nonarray-1');
    expect(json).not.toContain('theme');
  });

  it('路径 schema：声明路径导出嵌套公开字段，未声明路径与嵌套凭据排除；凭据形态路径声明整条拒绝（第十四轮阻断 1 + 第十五轮阻断 1）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          theme: 'dark',
          apiKey: 'sk-direct-1',
          profile: {
            username: 'alice',
            email: 'alice@example.com',
            auth: { apiKey: 'sk-nested-2', accessToken: 'tok-nested-3' },
          },
        },
      },
    } as Project;
    const json = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: {
          'com.example': ['theme', ['profile', 'username'], ['profile', 'auth', 'apiKey']],
        },
      }),
    );
    // 顶层键整值导出；路径末端键按路径导出；路径含凭据形态键（auth/apiKey）
    // 的整条声明拒绝 —— sk-nested-2 绝不进包（第十五轮阻断 1）
    for (const kept of ['dark', 'alice']) {
      expect(json, `声明键值 ${kept} 必须进入包`).toContain(kept);
    }
    // 未声明键与嵌套凭据排除
    for (const leaked of ['sk-direct-1', 'alice@example.com', 'sk-nested-2', 'tok-nested-3']) {
      expect(json, `未声明凭据 ${leaked} 不得进入包`).not.toContain(leaked);
    }
    // 投影结果只含声明路径：profile 段只有 username，auth 整段排除
    const parsed = await parseProjectPackage(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, unknown>>)['com.example'];
    expect(plugin).toEqual({
      theme: 'dark',
      profile: { username: 'alice' },
    });
  });

  it('声明顺序无关：冻结项目下祖先与路径声明重叠的两种顺序结果一致且不抛错（第十五轮严重 2）', async () => {
    const project = await buildFixtureProject();
    const frozen = {
      ...project,
      pluginData: Object.freeze({
        'com.example': Object.freeze({
          profile: Object.freeze({ username: 'alice', email: 'alice@example.com' }),
          theme: 'dark',
        }),
      }),
    } as Project;
    // trie 归一：祖先声明（profile）覆盖冗余后代路径声明，与声明顺序无关 ——
    // 旧 merge 实现会原地改写投影中的源引用，冻结项目下先祖先后路径的顺序抛
    // TypeError，反序成功、结果互异；纯函数投影下两种顺序都不抛错且结果一致
    // 两次构建注入同一 exportedAt（第十七轮一般 5）：manifest 导出时刻取当前
    // 毫秒，不注入时两次构建的完整包 JSON 因毫秒差异偶发不相等（聚焦复跑 flaky）
    const fixedExportedAt = '2026-01-01T00:00:00.000Z';
    const order1 = buildProjectPackage(frozen, {
      includePrivate: true,
      exportedAt: fixedExportedAt,
      publicKeysByPlugin: { 'com.example': ['profile', ['profile', 'username']] },
    });
    const order2 = buildProjectPackage(frozen, {
      includePrivate: true,
      exportedAt: fixedExportedAt,
      publicKeysByPlugin: { 'com.example': [['profile', 'username'], 'profile'] },
    });
    expect(order1.project.pluginData).toBeUndefined();
    expect(JSON.stringify(order1)).toBe(JSON.stringify(order2));
  });

  it('pluginData 命名空间与叶值访问器拒绝导出且 getter 不执行（第十五轮一般 6）', async () => {
    const project = await buildFixtureProject();
    // 命名空间层访问器：旧浅展开 {…read.value} 会执行 getter（用户对象代码在
    // 导出管道内运行）；descriptor 语义下读取即拒绝，getter 全程不执行
    let namespaceGetterCalls = 0;
    const namespaceData: Record<string, unknown> = {};
    Object.defineProperty(namespaceData, 'com.example', {
      get: () => {
        namespaceGetterCalls += 1;
        return { theme: 'dark' };
      },
      enumerable: true,
    });
    expect(() =>
      buildProjectPackage({ ...project, pluginData: namespaceData } as unknown as Project, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['theme'] },
      }),
    ).toThrow(/访问器属性/);
    expect(namespaceGetterCalls).toBe(0);

    // 叶值访问器：结构化克隆/投影同样不得物化 getter，拒绝且不执行
    let leafGetterCalls = 0;
    const leafData: Record<string, unknown> = { 'com.example': {} };
    Object.defineProperty(leafData['com.example'], 'theme', {
      get: () => {
        leafGetterCalls += 1;
        return 'dark';
      },
      enumerable: true,
    });
    expect(() =>
      buildProjectPackage({ ...project, pluginData: leafData } as unknown as Project, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['theme'] },
      }),
    ).toThrow(/访问器属性/);
    expect(leafGetterCalls).toBe(0);
  });

  it('路径 schema：中途缺失/中间层非普通对象/路径含原型键时整条路径回滚，不残留部分投影（第十四轮阻断 1）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          theme: 'dark',
          profile: {
            username: 'alice',
            tags: ['a', 'b'],
            auth: { apiKey: 'sk-rollback-1' },
          },
        },
      },
    } as Project;
    const json = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: {
          'com.example': [
            'theme',
            ['profile', 'tags', 'x'], // 中间层是数组（非普通对象）→ 整条失败
            ['profile', 'missing', 'x'], // 中途缺失 → 整条失败
            ['__proto__', 'x'], // 原型键声明 → 忽略
            ['profile', '__proto__'], // 路径含原型键 → 整条失败
          ],
        },
      }),
    );
    expect(json, '失败路径的值不得进入包').not.toContain('sk-rollback-1');
    expect(json).not.toContain('"__proto__"');
    expect(json, '回滚不得残留部分投影').not.toContain('alice');
    const parsed = await parseProjectPackage(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, unknown>>)['com.example'];
    // profile 完全未导出（整条路径回滚），顶层键声明不受失败路径影响
    expect(plugin).toEqual({ theme: 'dark' });
  });

  it('子结构逐层投影：geometry/material/light/camera 与 assets[].parts[] 嵌套契约外字段不进包，契约字段保留（第十三轮阻断 1）', async () => {
    const project = await buildFixtureProject();
    const object = project.objects[0]!;
    const asset = project.assets[0]!;
    const rich = {
      ...project,
      objects: project.objects.map((o) =>
        o.id === object.id
          ? {
              ...o,
              geometry: { kind: 'box', apiKey: 'geo-secret', extra: 1 },
              material: { color: '#ff0000', apiKey: 'mat-secret', shader: 'custom' },
              light: { kind: 'point', color: '#ffffff', intensity: 2, apiKey: 'light-secret' },
              camera: {
                projection: 'perspective',
                focalLength: 50,
                fov: 45,
                sensorWidth: 36,
                sensorHeight: 24,
                near: 0.1,
                far: 1000,
                aspect: 16 / 9,
                apiKey: 'cam-secret',
                credentials: 'cam-cred',
              },
            }
          : o,
      ),
      assets: project.assets.map((a) =>
        a.id === asset.id
          ? {
              ...a,
              parts: [
                { path: 'mesh.bin', mime: 'application/octet-stream', payload: 'AAA=', apiKey: 'part-secret' },
                { path: 'tex.png', mime: 'image/png', payload: 'BBB=', credentials: 'part-cred' },
              ],
            }
          : a,
      ),
    } as unknown as Project;
    for (const includePrivate of [false, true]) {
      const packed = buildProjectPackage(rich, { includePrivate });
      const json = JSON.stringify(packed);
      for (const leaked of ['geo-secret', 'mat-secret', 'light-secret', 'cam-secret', 'cam-cred', 'part-secret', 'part-cred']) {
        expect(json, `${leaked}（includePrivate=${includePrivate}）不得进入包`).not.toContain(leaked);
      }
      // 契约字段完整保留：子结构投影不丢公开数据
      const raw = JSON.parse(json) as {
        project: { objects: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>> };
        assets: Record<string, { parts?: Array<Record<string, string>> }>;
      };
      const packedObject = raw.project.objects.find((o) => o.id === object.id)!;
      expect(packedObject.geometry).toEqual({ kind: 'box' });
      expect(packedObject.material).toEqual({ color: '#ff0000' });
      expect(packedObject.light).toEqual({ kind: 'point', color: '#ffffff', intensity: 2 });
      expect(packedObject.camera).toEqual({
        projection: 'perspective',
        focalLength: 50,
        fov: 45,
        sensorWidth: 36,
        sensorHeight: 24,
        near: 0.1,
        far: 1000,
        aspect: 16 / 9,
      });
      const partsPayload = raw.assets[String(asset.id)] as { parts?: Array<Record<string, string>> };
      expect(partsPayload.parts).toEqual([
        { path: 'mesh.bin', mime: 'application/octet-stream', payload: 'AAA=' },
        { path: 'tex.png', mime: 'image/png', payload: 'BBB=' },
      ]);
      // 资产元数据投影不含 parts（字节在 assets 段）与嵌套未知字段
      const packedAsset = raw.project.assets.find((a) => a.id === asset.id)!;
      expect(packedAsset.parts).toBeUndefined();
      expect(packedAsset.storageRef).toBe('');
    }
  });

  it('资产分件数组非索引 own 键：拒绝导出（JSON 序列化必然静默丢弃，绝不静默丢字段，第十三轮严重 3）', async () => {
    const project = await buildFixtureProject();
    const asset = project.assets[0]!;
    const parts = [
      { path: 'mesh.bin', mime: 'application/octet-stream', payload: 'AAA=' },
    ] as unknown as AssetPartData[];
    (parts as unknown as Record<string, unknown>).extra = '非索引键';
    const rich = {
      ...project,
      assets: project.assets.map((a) => (a.id === asset.id ? { ...a, parts } : a)),
    } as Project;
    expect(() => buildProjectPackage(rich)).toThrow(/非索引属性 extra/);
    expect(() => buildProjectPackage(rich, { includePrivate: true })).toThrow(/非索引属性 extra/);
  });

  it('manifest 与 project 段同图：必需字段缺失 own 数据字段（含继承 getter）→ 拒绝导出，不产生不一致包（第十三轮一般 6）', async () => {
    const project = await buildFixtureProject();
    // uri 挂在原型上的 getter：旧实现 manifest 直接读 project.uri 会触发 getter
    // （manifest 有值、project 段缺该字段的不一致包）；现在必需字段按 own 数据
    // 字段判定 → 视为缺失 → 拒绝导出，getter 副作用不发生
    let getterCalled = 0;
    const withInheritedUri = Object.create({ get uri() { getterCalled += 1; return 'inherited-uri'; } });
    for (const key of Object.keys(project)) {
      if (key !== 'uri') (withInheritedUri as Record<string, unknown>)[key] = project[key as keyof Project];
    }
    expect(() => buildProjectPackage(withInheritedUri as Project)).toThrow(/缺少必需字段 uri/);
    expect(getterCalled).toBe(0);
    // 缺失任意必需字段均拒绝
    for (const field of ['name', 'schemaVersion', 'revision'] as const) {
      const missing = { ...project } as Project & Record<string, unknown>;
      delete missing[field];
      expect(() => buildProjectPackage(missing as Project)).toThrow(new RegExp(`缺少必需字段 ${field}`));
    }
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
