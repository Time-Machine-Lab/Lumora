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
  PackageBuildError,
  buildProjectPackage,
  parseProjectPackage,
  serializeProjectPackage,
} from '../src/project/package';
import { CURRENT_PROJECT_SCHEMA_VERSION, PACKAGE_FORMAT_VERSION, PROJECT_PACKAGE_FORMAT } from '../src/project/schema';
import { validateProjectSchema } from '../src/scene/validate';
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

/** 第二十五轮：凭据形态公开声明命中 → 构建校验失败（错误码 + 被拒声明）——
 *  不再静默丢弃；返回错误便于继续断言被拒声明列表 */
function expectCredentialDeclarationRejected(build: () => unknown): PackageBuildError {
  let error: unknown = null;
  try {
    build();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PackageBuildError);
  const buildError = error as PackageBuildError;
  expect(buildError.code).toBe('credential-declaration-rejected');
  return buildError;
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

  it('分镜与轨道 disabled 随工程包往返（TML-52 包契约：shots 与 track disabled 进 PUBLIC 白名单）', async () => {
    const project = await buildFixtureProject();
    const disabledTrackId = genId('track');
    const withTimeline = {
      ...project,
      tracks: [
        ...project.tracks,
        {
          id: disabledTrackId,
          name: '禁用轨道',
          // rotation 通道：sample-camera 的 position/focalLength 已被示例轨道占用，
          // 复合键唯一约束（TML-52 审查第 6 项）不允许再建同键轨道
          objectId: 'sample-camera',
          targetPath: 'rotation' as const,
          disabled: true,
          keyframes: [
            { time: 0, value: [0, 0, 0] as [number, number, number] },
            { time: 1, value: [0, 0, 1] as [number, number, number] },
          ],
        },
      ],
      shots: [
        {
          id: genId('shot'),
          name: '开场',
          cameraObjectId: 'sample-camera',
          startTime: 0,
          endTime: 1.5,
          shotSize: 'wide' as const,
          movement: 'dolly-in' as const,
          prompt: 'A wide establishing shot.',
          aiSource: {
            providerId: 'com.example.storyboard',
            model: 'storyboard-1',
            draftId: 'draft-1',
          },
        },
        { id: genId('shot'), name: '特写', cameraObjectId: null, startTime: 1.5, endTime: 3 },
      ],
    };
    const pkg = buildProjectPackage(withTimeline, { exportedAt: '2026-08-24T00:00:00.000Z' });
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roundTrip = result.project as Project;
    expect(roundTrip.shots).toEqual(withTimeline.shots);
    const disabledTrack = roundTrip.tracks.find((t) => t.id === disabledTrackId);
    expect(disabledTrack).toBeDefined();
    expect(disabledTrack!.disabled).toBe(true);
    expect(disabledTrack!.keyframes).toEqual(withTimeline.tracks[withTimeline.tracks.length - 1]!.keyframes);
  });

  it('projects AI provenance through its exact public DTO without credential-shaped extras', async () => {
    const project = await buildFixtureProject();
    const source = {
      providerId: 'com.example.storyboard',
      model: 'storyboard-1',
      draftId: 'draft-1',
      apiKey: 'sk-should-never-persist',
    };
    const enriched = {
      ...project,
      shots: [{
        id: genId('shot'),
        name: 'AI shot',
        cameraObjectId: null,
        startTime: 0,
        endTime: 2,
        shotSize: 'medium' as const,
        movement: 'static' as const,
        prompt: 'A clean product close-up.',
        aiSource: source,
      }],
    } as Project;

    const serialized = serializeProjectPackage(buildProjectPackage(enriched));
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('sk-should-never-persist');
    const result = await parseProjectPackage(serialized);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.shots[0]?.aiSource).toEqual({
      providerId: 'com.example.storyboard',
      model: 'storyboard-1',
      draftId: 'draft-1',
    });
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
    // 等形态子串）→ 整条声明命中 → 构建校验失败（第二十五轮指令 3，第十五轮
    // 阻断 1 语义保留）：即使显式 allowlist 声明，值也不得进包
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: {
          'com.example': ['apiKey', 'clientSecret', 'accessToken', 'auth', ['auth', 'apiKey']],
        },
      }),
    );
    expect(error.declarations).toHaveLength(5);
    expect(error.declarations).toContainEqual({ plugin: 'com.example', path: '"apiKey"' });
    expect(error.declarations).toContainEqual({ plugin: 'com.example', path: '["auth","apiKey"]' });
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
    // com.b 显式声明凭据形态键（apiKey）：构建校验失败并列出被拒声明
    // （第二十五轮：不再静默丢弃）
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.a': ['theme'], 'com.b': ['apiKey'] },
      }),
    );
    expect(error.declarations).toContainEqual({ plugin: 'com.b', path: '"apiKey"' });
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
    // 显式 allowlist（宿主核验过的合法键）：非凭据键逐键无损往返，值不被改动；
    // 凭据形态键（pass_word/passwd/authHeader 含 pass/passwd/auth 分词）声明
    // 命中 → 构建校验失败（第二十五轮：不再静默丢弃，allowlist 放行不豁免凭据
    // 形态，第十五轮阻断 1 语义保留）；完整词匹配下 tokenizer*/keyboard* 等
    // 合法键（旧子串检测误剥）正常往返（第十七轮阻断 1/严重 2）
    const legalDeclarations = Object.keys(pluginData['com.example']).filter(
      (key) => !['pass_word', 'passwd', 'authHeader'].includes(key),
    );
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': legalDeclarations },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const expected = { ...pluginData['com.example'] };
    for (const credentialKey of ['pass_word', 'passwd', 'authHeader'] as const) {
      delete expected[credentialKey];
    }
    expect(parsed.project.pluginData).toEqual({ 'com.example': expected });
    expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['pass_word', 'passwd', 'authHeader'] },
      }),
    );
  });

  it('凭据形态判定为默认拒绝敏感形态 + 正向豁免：分隔符/camelCase/全大写/全角/复数/数字后缀/连写/无边界连写/多语（繁体/日文/西语）敏感键顶层与嵌套路径一律拒绝，tokenBudget/authMode/主题/caféMode/passwordless/apiKeyboardLayout 等合法键放行（第十七轮 + 第十八轮 + 第十九轮 + 第二十一轮 + 第二十三轮回归）', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, Record<string, string>> = {
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
        credentials: 'leak-10',
        accessToken: 'leak-11',
        clientSecret: 'leak-12',
        authHeader: 'leak-13',
        auth: 'leak-14',
        // privateSettings/privateKeys 显式拒绝语义保留（private+setting/private+key 序列）
        privateSettings: 'leak-15',
        privateKeys: 'leak-25',
        // 第十八轮阻断 1：全大写/缩写形态（连续大写缩写保留为一个 token）、
        // 复数复合词、全角（NFKC 规范化）一律拒绝
        API_KEY: 'leak-16',
        APIKey: 'leak-17',
        PASSWORD: 'leak-18',
        ACCESS_TOKEN: 'leak-19',
        PRIVATE_KEY: 'leak-20',
        'ＡＰＩ＿ＫＥＹ': 'leak-21',
        accessTokens: 'leak-22',
        clientSecrets: 'leak-23',
        storedPasswords: 'leak-24',
        // 第十九轮阻断 1：多 token 键任意位置命中高置信凭据词即拒绝（不再只在
        // 整键单 token 时检查、不再依赖 9 组固定相邻词对）
        databasePassword: 'leak-26',
        passwordHash: 'leak-27',
        password1: 'leak-28',
        bearerToken: 'leak-29',
        sessionToken: 'leak-30',
        oauthToken: 'leak-31',
        jwtSecret: 'leak-32',
        webhookSecret: 'leak-33',
        secretValue: 'leak-34',
        userCredentials: 'leak-35',
        token1: 'leak-36',
        // 非 ASCII 键：CJK 敏感词显式拒绝（第二十一轮严重 5 细粒度规则，非 blanket）
        密码: 'leak-37',
        访问令牌: 'leak-38',
        密钥: 'leak-39',
        // 第二十一轮阻断 1：无边界复合形态（全小写/全大写连写解析成单 token，
        // exact 集不含、pair 规则无法运行）—— 由复合对/敏感组合派生的候选做
        // 包含匹配，顶层与嵌套一律拒绝
        clientsecret: 'leak-42',
        CLIENTSECRET: 'leak-43',
        accesstoken: 'leak-44',
        ACCESSTOKEN: 'leak-45',
        refreshtoken: 'leak-46',
        REFRESHTOKEN: 'leak-47',
        authheader: 'leak-48',
        AUTHHEADER: 'leak-49',
        privatesetting: 'leak-50',
        PRIVATESETTING: 'leak-51',
        storedpassword: 'leak-52',
        STOREDPASSWORD: 'leak-53',
        bearertoken: 'leak-54',
        BEARERTOKEN: 'leak-55',
        databasepassword: 'leak-56',
        DATABASEPASSWORD: 'leak-57',
        jwtsecret: 'leak-58',
        JWTSECRET: 'leak-59',
        usercredentials: 'leak-60',
        USERCREDENTIALS: 'leak-61',
        // 全角无分隔（NFKC 后收敛到同一无边界形态）
        'ＣＬＩＥＮＴＳＥＣＲＥＴ': 'leak-62',
        'ＡＣＣＥＳＳＴＯＫＥＮ': 'leak-63',
        'ＡＵＴＨＨＥＡＤＥＲ': 'leak-64',
        'ＳＴＯＲＥＤＰＡＳＳＷＯＲＤ': 'leak-65',
        // 第二十三轮阻断 2：范式反转后常见凭据名不再重入包 —— kind-suffix
        // 闭合（限定词+token）、X+key 复合对（secret+key）、凭据根词
        // （passphrase）、多语凭据词（繁体/日文/西语经 NFKD 去变音归一）
        apiToken: 'leak-66',
        authToken: 'leak-67',
        csrfToken: 'leak-68',
        idToken: 'leak-69',
        privateToken: 'leak-70',
        secretkey: 'leak-71',
        passphrase: 'leak-72',
        密碼: 'leak-73',
        秘钥: 'leak-74',
        パスワード: 'leak-75',
        contraseña: 'leak-76',
        // 放行组：完整词包含 tokenizer/author/api 的合法键（旧子串匹配误剥）；
        // 第十八轮严重 2：仅含 pass/api 子串且不在任何凭据序列中的复合词放行；
        // 第二十一轮严重 4：token/auth 歧义词分轨，tokenBudget/authMode 恢复放行；
        // 第二十一轮严重 5：合法非 ASCII 键（主题/caféMode）放行
        tokenizerConfig: 'keep-1',
        tokenizerModel: 'keep-2',
        authorName: 'keep-3',
        authorizationMode: 'keep-4',
        tokenizerConfigModel: 'keep-5',
        keyboardLayout: 'keep-6',
        MONKEYPATCH: 'keep-7',
        HOTKEYMAP: 'keep-8',
        api: 'keep-9',
        apiVersion: 'keep-10',
        tokenBudget: 'keep-11',
        renderPass: 'keep-12',
        passCount: 'keep-13',
        authMode: 'keep-14',
        主题: 'keep-15',
        caféMode: 'keep-16',
        // 第二十三轮严重 5：无边界复合改有边界判定（整词精确/词边界后缀）后，
        // 以凭据词开头的合法复合键与「非 kind 后缀」连写全部往返（旧 includes
        // 匹配误删）
        passwordless: 'keep-17',
        apiKeyboardLayout: 'keep-18',
        accessTokenizerConfig: 'keep-19',
        privateKeyboardShortcuts: 'keep-20',
        compassWordWrap: 'keep-21',
      },
    };
    // 凭据形态键整表声明命中 → 构建校验失败（第二十五轮指令 3：不再静默丢弃，
    // 逐条上报插件名与声明路径；allowlist 放行不豁免凭据形态）
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': Object.keys(pluginData['com.example']) },
      }),
    );
    const leakKeys = Object.entries(pluginData['com.example'])
      .filter(([, value]) => value.startsWith('leak-'))
      .map(([key]) => key);
    expect(error.declarations).toHaveLength(leakKeys.length);
    for (const key of leakKeys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.message).toContain('凭据永不导出');
    // 仅声明合法键：逐键无损往返，值不被改动
    const keepKeys = Object.entries(pluginData['com.example'])
      .filter(([, value]) => value.startsWith('keep-'))
      .map(([key]) => key);
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': keepKeys },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    for (const key of keepKeys) {
      expect(plugin[key]).toBe(pluginData['com.example'][key]);
    }
    const json = JSON.stringify(parsed.project);
    for (let i = 1; i <= 76; i += 1) {
      if (i === 9) continue; // 裸 api 不再拒绝（第十八轮严重 2 修正）
      expect(json).not.toContain(`leak-${i}`);
    }
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) {
      expect(json).toContain(`keep-${i}`);
    }
    // 嵌套路径声明同判据：路径任意层命中完整凭据序列整条声明拒绝；合法组合词路径放行
    const profileData: Record<string, string> = {
      username: 'alice',
      api_key: 'n-1',
      pass_word: 'n-2',
      'api.key': 'n-3',
      'pass-word': 'n-4',
      private_key: 'n-5',
      apiKey: 'n-6',
      API_KEY: 'n-7',
      APIKey: 'n-8',
      PASSWORD: 'n-9',
      ACCESS_TOKEN: 'n-10',
      PRIVATE_KEY: 'n-11',
      'ＡＰＩ＿ＫＥＹ': 'n-12',
      accessTokens: 'n-13',
      clientSecrets: 'n-14',
      storedPasswords: 'n-15',
      privateKeys: 'n-16',
      // 第十九轮阻断 1：多 token 键任意位置高置信词、数字后缀、非 ASCII
      databasePassword: 'n-17',
      passwordHash: 'n-18',
      password1: 'n-19',
      bearerToken: 'n-20',
      sessionToken: 'n-21',
      oauthToken: 'n-22',
      jwtSecret: 'n-23',
      webhookSecret: 'n-24',
      secretValue: 'n-25',
      userCredentials: 'n-26',
      token1: 'n-27',
      密码: 'n-28',
      访问令牌: 'n-29',
      密钥: 'n-30',
      // 第二十一轮阻断 1：无边界复合形态嵌套路径（全小写 + 全角连写）
      clientsecret: 'n-33',
      accesstoken: 'n-34',
      refreshtoken: 'n-35',
      authheader: 'n-36',
      privatesetting: 'n-37',
      storedpassword: 'n-38',
      bearertoken: 'n-39',
      databasepassword: 'n-40',
      jwtsecret: 'n-41',
      usercredentials: 'n-42',
      webhooksecret: 'n-43',
      secretvalue: 'n-44',
      'ＣＬＩＥＮＴＳＥＣＲＥＴ': 'n-45',
      'ＡＣＣＥＳＳＴＯＫＥＮ': 'n-46',
      'ＡＵＴＨＨＥＡＤＥＲ': 'n-47',
      'ＳＴＯＲＥＤＰＡＳＳＷＯＲＤ': 'n-48',
      // 第二十三轮阻断 2：常见凭据名嵌套路径回归（kind-suffix 闭合/
      // 复合对/凭据根词/多语凭据词）
      apiToken: 'n-49',
      authToken: 'n-50',
      csrfToken: 'n-51',
      idToken: 'n-52',
      privateToken: 'n-53',
      secretkey: 'n-54',
      passphrase: 'n-55',
      密碼: 'n-56',
      秘钥: 'n-57',
      パスワード: 'n-58',
      contraseña: 'n-59',
      // 第二十一轮严重 4/5：tokenBudget/authMode 恢复放行；合法非 ASCII
      // 键（主题/caféMode）放行
      tokenBudget: 'n-ok-5',
      authMode: 'n-ok-8',
      tokenizerConfig: 'n-ok-1',
      authorName: 'n-ok-2',
      authorizationMode: 'n-ok-3',
      apiVersion: 'n-ok-4',
      renderPass: 'n-ok-6',
      passCount: 'n-ok-7',
      主题: 'n-ok-9',
      caféMode: 'n-ok-10',
      // 第二十三轮严重 5：5 个合法复合键嵌套路径往返
      passwordless: 'n-ok-11',
      apiKeyboardLayout: 'n-ok-12',
      accessTokenizerConfig: 'n-ok-13',
      privateKeyboardShortcuts: 'n-ok-14',
      compassWordWrap: 'n-ok-15',
    };
    const nestedLeakPaths = Object.entries(profileData)
      .filter(([, value]) => /^n-\d+$/.test(value))
      .map(([key]) => ['profile', key]);
    const nestedKeepPaths = Object.entries(profileData)
      .filter(([, value]) => value.startsWith('n-ok-'))
      .map(([key]) => ['profile', key]);
    nestedKeepPaths.unshift(['profile', 'username']);
    const nestedError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.example': { profile: profileData } } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': nestedLeakPaths } },
      ),
    );
    expect(nestedError.declarations).toHaveLength(nestedLeakPaths.length);
    expect(nestedError.declarations).toContainEqual({ plugin: 'com.example', path: '["profile","apiToken"]' });
    const nestedPkg = buildProjectPackage(
      { ...project, pluginData: { 'com.example': { profile: profileData } } },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': nestedKeepPaths } },
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
        apiVersion: 'n-ok-4',
        tokenBudget: 'n-ok-5',
        renderPass: 'n-ok-6',
        passCount: 'n-ok-7',
        authMode: 'n-ok-8',
        主题: 'n-ok-9',
        caféMode: 'n-ok-10',
        passwordless: 'n-ok-11',
        apiKeyboardLayout: 'n-ok-12',
        accessTokenizerConfig: 'n-ok-13',
        privateKeyboardShortcuts: 'n-ok-14',
        compassWordWrap: 'n-ok-15',
      },
    });
  });

  it('凭据形态判定跨路径 segment：路径数组声明统一 token 化后拒绝相邻凭据序列与无边界复合形态，不再被表示法绕过（第十九轮阻断 2 + 第二十一轮阻断 1）', async () => {
    const project = await buildFixtureProject();
    // ['api','key'] ≡ api_key：逐段判定均非凭据词（api/key 不在高置信集合），
    // 但完整路径 token 化后相邻序列 api+key 命中 —— 修复前整组放行；
    // 第二十一轮阻断 1：['client','secret'] ≡ clientsecret 的无边界形态同样命中；
    // 第二十五轮：命中声明不再静默丢弃，构建校验失败并逐条上报
    const nestedData: Record<string, unknown> = {
      pass: { word: 'p-2' },
      client: { secret: 'p-5' },
      refresh: { token: 'p-7' },
      auth: { header: 'p-8' },
      stored: { password: 'p-9' },
      bearer: { token: 'p-10' },
      database: { password: 'p-11' },
      jwt: { secret: 'p-12' },
      webhook: { secret: 'p-13' },
      user: { credentials: 'p-14' },
      secret: { value: 'p-15' },
      session: { token: 'p-16' },
      // 第二十三轮阻断 3：嵌套裸 token/auth segment（['profile','token']/
      // ['profile','auth']）—— 逐 segment 上下文判定拒绝，不再被「整条
      // 路径 token 总数」稀释
      profile: {
        token: 'p-17',
        auth: 'p-18',
        api: { version: 'p-ok-1' },
      },
      render: { pass: 'p-ok-2' },
      // 第二十三轮严重 5：5 个合法复合键路径数组往返（passwordless/
      // apiKeyboardLayout/accessTokenizerConfig/privateKeyboardShortcuts/
      // compassWordWrap 跨 segment 与单 segment 形态）
      passwordless: 'p-ok-3',
      access: { token: 'p-6', tokenizer: { config: 'p-ok-4' } },
      private: { key: 'p-3', setting: 'p-4', keyboard: { shortcuts: 'p-ok-5' } },
      compass: { word: { wrap: 'p-ok-6' } },
      api: { key: 'p-1', keyboard: { layout: 'p-ok-7' } },
    };
    const leakPaths: Array<Array<string>> = [
      ['api', 'key'],
      ['pass', 'word'],
      ['private', 'key'],
      ['private', 'setting'],
      ['client', 'secret'],
      ['access', 'token'],
      ['refresh', 'token'],
      ['auth', 'header'],
      ['stored', 'password'],
      ['bearer', 'token'],
      ['database', 'password'],
      ['jwt', 'secret'],
      ['webhook', 'secret'],
      ['user', 'credentials'],
      ['secret', 'value'],
      ['session', 'token'],
      ['profile', 'token'],
      ['profile', 'auth'],
    ];
    const keepPaths: Array<Array<string>> = [
      ['profile', 'api', 'version'],
      ['render', 'pass'],
      ['passwordless'],
      ['access', 'tokenizer', 'config'],
      ['private', 'keyboard', 'shortcuts'],
      ['compass', 'word', 'wrap'],
      ['api', 'keyboard', 'layout'],
    ];
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.example': nestedData } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': [...leakPaths, ...keepPaths] } },
      ),
    );
    expect(error.declarations).toHaveLength(leakPaths.length);
    const pkg = buildProjectPackage(
      { ...project, pluginData: { 'com.example': nestedData } },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': keepPaths } },
    );
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, unknown>)['com.example'];
    // 十八组路径数组声明全部拒绝：{api:{key}}/{pass:{word}}/{private:{key,setting}}/
    // {client:{secret}}/{access:{token}}/{profile:{token,auth}} 等不进包
    const json = JSON.stringify(parsed.project);
    for (let i = 1; i <= 18; i += 1) expect(json).not.toContain(`p-${i}`);
    // 合法跨 segment 组合（api+version、render+pass）与 5 个合法复合键的
    // 路径数组形态（单 segment 与跨 segment）全部往返
    expect(plugin).toEqual({
      passwordless: 'p-ok-3',
      access: { tokenizer: { config: 'p-ok-4' } },
      private: { keyboard: { shortcuts: 'p-ok-5' } },
      compass: { word: { wrap: 'p-ok-6' } },
      api: { keyboard: { layout: 'p-ok-7' } },
      profile: { api: { version: 'p-ok-1' } },
      render: { pass: 'p-ok-2' },
    });
  });

  it('第二十五轮：kind 词任意位置精确匹配 + 复合对/后缀变体判定闭合残余绕过；凭据形态声明命中返回带错误码的校验失败（apiTokenV2/tokenValue/tokenHash/apikey2/authkey2/accesstoken2 拒绝，apiVersion3 放行）', async () => {
    const project = await buildFixtureProject();
    const pluginData = {
      'com.example': {
        apiTokenV2: 'r-1',
        tokenValue: 'r-2',
        tokenHash: 'r-3',
        apikey2: 'r-4',
        authkey2: 'r-5',
        accesstoken2: 'r-6',
        apiVersion3: 'r-keep-1',
      },
    };
    const leakKeys = ['apiTokenV2', 'tokenValue', 'tokenHash', 'apikey2', 'authkey2', 'accesstoken2'];
    // 整表声明：6 个残余绕过键逐一命中，错误码/插件名/声明路径逐条上报
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': Object.keys(pluginData['com.example']) },
      }),
    );
    expect(error.declarations).toHaveLength(leakKeys.length);
    for (const key of leakKeys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.message).toContain('apiTokenV2');
    // 单键声明同样拒绝
    for (const key of leakKeys) {
      expectCredentialDeclarationRejected(() =>
        buildProjectPackage({ ...project, pluginData }, {
          includePrivate: true,
          publicKeysByPlugin: { 'com.example': [key] },
        }),
      );
    }
    // apiVersion3 合法：仅声明它时正常往返（api+version 组合、数字后缀版本号）
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['apiVersion3'] },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    expect(plugin.apiVersion3).toBe('r-keep-1');
    // 嵌套声明同样命中：['profile','tokenValue'] 整条声明拒绝
    expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.example': { profile: { tokenValue: 'r-7' } } } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': [['profile', 'tokenValue']] } },
      ),
    );
  });

  it('第二十六轮 + 第二十八轮：有界后缀剥离闭合「无边界复合 + 字母数字后缀」系统性绕过（18 键 + api2key/apikeyv3 + pass2/session/cookies 拒绝；apiVersion3/layout2/version2/renderPass2/wordWrap2 放行往返）', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': {
        apikeyv2: 'r26-1',
        accesstokenv2: 'r26-2',
        clientsecretv2: 'r26-3',
        secretv2: 'r26-4',
        passwordv2: 'r26-5',
        tokenv2: 'r26-6',
        authheaderv2: 'r26-7',
        passphrasev2: 'r26-8',
        secretkeyv2: 'r26-9',
        oauthtokenv2: 'r26-10',
        refreshtokenv2: 'r26-11',
        bearertokenv2: 'r26-12',
        sessiontokenv2: 'r26-13',
        jwtsecretv2: 'r26-14',
        secretvaluev2: 'r26-15',
        authkeyv2: 'r26-16',
        passkeyv2: 'r26-17',
        privatekeyv2: 'r26-18',
        api2key: 'r26-19',
        apikeyv3: 'r26-20',
        apiVersion3: 'r26-keep-1',
        layout2: 'r26-keep-2',
        version2: 'r26-keep-3',
        renderPass2: 'r26-keep-4',
        wordWrap2: 'r26-keep-5',
        pass2: 'r26-21',
        session: 'r26-22',
        cookies: 'r26-23',
      },
    };
    const leakKeys = [
      'apikeyv2',
      'accesstokenv2',
      'clientsecretv2',
      'secretv2',
      'passwordv2',
      'tokenv2',
      'authheaderv2',
      'passphrasev2',
      'secretkeyv2',
      'oauthtokenv2',
      'refreshtokenv2',
      'bearertokenv2',
      'sessiontokenv2',
      'jwtsecretv2',
      'secretvaluev2',
      'authkeyv2',
      'passkeyv2',
      'privatekeyv2',
      'api2key',
      'apikeyv3',
      'pass2',
      'session',
      'cookies',
    ];
    const keepKeys = ['apiVersion3', 'layout2', 'version2', 'renderPass2', 'wordWrap2'];
    // 整表声明：23 个「无边界复合 + 字母数字后缀」变体逐一命中（含复合表形态与
    // 「根词 + 后缀」形态 secretv2/passwordv2/tokenv2/passphrasev2 —— standalone
    // 根词不在复合表内，经 kind 词/拉丁根词校验闭合）。第二十八轮严重 7：
    // pass2 版本后缀剥尽后余量恰为 'pass' 默认拒绝；session/cookies 为 kind 词
    // 直接命中。错误码/插件名/声明路径逐条上报
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': Object.keys(pluginData['com.example']) },
      }),
    );
    expect(error.declarations).toHaveLength(leakKeys.length);
    for (const key of leakKeys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.message).toContain('apikeyv2');
    // 单键声明同样拒绝
    for (const key of leakKeys) {
      expectCredentialDeclarationRejected(() =>
        buildProjectPackage({ ...project, pluginData }, {
          includePrivate: true,
          publicKeysByPlugin: { 'com.example': [key] },
        }),
      );
    }
    // 合法版本键：仅声明时正常往返（版本后缀剥离后余量不在任何候选集；旧
    // [a-z]*[0-9]+$ 分支在修复前对这些键同样放行，修复后行为保持）
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': keepKeys },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    for (const key of keepKeys) {
      expect(plugin[key]).toBe(pluginData['com.example'][key]);
    }
    // 嵌套声明同判据：['profile','apikeyv2']/['profile','session'] 整条拒绝
    // （逐 segment standalone 判定命中，session 为 kind 词）；豁免叶键
    // ['profile','cookieConsent']（BENIGN 白名单）与 ['profile','layout2'] 放行
    const nestedError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.example': { profile: { apikeyv2: 'r26-n-1', session: 'r26-n-2', cookieConsent: 'r26-n-ok-1', layout2: 'r26-n-ok-2' } } } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': [['profile', 'apikeyv2'], ['profile', 'session'], ['profile', 'cookieConsent'], ['profile', 'layout2']] } },
      ),
    );
    expect(nestedError.declarations).toHaveLength(2);
    expect(nestedError.declarations).toContainEqual({ plugin: 'com.example', path: '["profile","apikeyv2"]' });
    expect(nestedError.declarations).toContainEqual({ plugin: 'com.example', path: '["profile","session"]' });
    const nestedPkg = buildProjectPackage(
      { ...project, pluginData: { 'com.example': { profile: { cookieConsent: 'r26-n-ok-1', layout2: 'r26-n-ok-2' } } } },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': [['profile', 'cookieConsent'], ['profile', 'layout2']] } },
    );
    const nestedParsed = await parseProjectPackage(serializeProjectPackage(nestedPkg));
    expect(nestedParsed.ok).toBe(true);
    if (!nestedParsed.ok) return;
    const nested = (nestedParsed.project.pluginData as Record<string, { profile: Record<string, string> }>)['com.example'];
    expect(nested).toEqual({ profile: { cookieConsent: 'r26-n-ok-1', layout2: 'r26-n-ok-2' } });
  });

  it('第二十八轮阻断 1：版本后缀剥离后余量重新 tokenize + 全小写无边界复合对 + CJK 扩展闭合 13 项实测泄漏（B1 矩阵）', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': {
        // 剥离 v2 后余量 apitoken/authtoken/databasepassword/usercredential 经
        // kind-suffix 扩展拆出 kind 词命中（旧实现剥离后不重新 tokenize、漏报）
        apitokenv2: 'r28-1',
        authtokenv2: 'r28-2',
        databasepasswordv2: 'r28-3',
        usercredentialv2: 'r28-4',
        // 全小写单 token 无 camelCase 边界：新复合对派生的无边界形态精确相等
        tokenvalue: 'r28-5',
        passwordhash: 'r28-6',
        // 环境后缀白名单逐层剥离：prod 一层、v2+beta 两层
        apikeyprod: 'r28-7',
        apikeyv2beta: 'r28-8',
        // CJK 扩展表：繁体/日文/韩文根词
        私鑰: 'r28-9',
        秘密鍵: 'r28-10',
        認証トークン: 'r28-11',
        비밀번호: 'r28-12',
      },
    };
    const leakKeys = [
      'apitokenv2',
      'authtokenv2',
      'databasepasswordv2',
      'usercredentialv2',
      'tokenvalue',
      'passwordhash',
      'apikeyprod',
      'apikeyv2beta',
      '私鑰',
      '秘密鍵',
      '認証トークン',
      '비밀번호',
    ];
    // 整表声明 + 嵌套声明 ['profile','apitokenv2']（逐 segment standalone 判定，
    // 段内 apitokenv2 经后缀剥离重新 tokenize 命中）：13 条全部拒绝
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': [...leakKeys, ['profile', 'apitokenv2']] },
      }),
    );
    expect(error.declarations).toHaveLength(13);
    for (const key of leakKeys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.declarations).toContainEqual({ plugin: 'com.example', path: '["profile","apitokenv2"]' });
    // 单键声明逐一拒绝
    for (const key of leakKeys) {
      expectCredentialDeclarationRejected(() =>
        buildProjectPackage({ ...project, pluginData }, {
          includePrivate: true,
          publicKeysByPlugin: { 'com.example': [key] },
        }),
      );
    }
    // 无泄漏的常规键不受新规则影响：passCount 不因「余量 === pass」误伤
    // （'pass' 不是 kind 词、不进复合表；passCount token 化为 pass|count）、
    // compassWordWrap/apiVersion3 不命中环境后缀白名单
    const keepPkg = buildProjectPackage(
      { ...project, pluginData: { 'com.example': { passCount: 'r28-ok-1', compassWordWrap: 'r28-ok-2', apiVersion3: 'r28-ok-3' } } },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': ['passCount', 'compassWordWrap', 'apiVersion3'] } },
    );
    const keepParsed = await parseProjectPackage(serializeProjectPackage(keepPkg));
    expect(keepParsed.ok).toBe(true);
    if (!keepParsed.ok) return;
    const keepPlugin = (keepParsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    expect(keepPlugin).toEqual({ passCount: 'r28-ok-1', compassWordWrap: 'r28-ok-2', apiVersion3: 'r28-ok-3' });
  });

  it('第二十八轮严重 7：session/cookie 系列默认拒绝（S7 8 项矩阵），良性歧义键走 BENIGN 白名单显式放行', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': {
        session: 'r28s-1',
        sessionId: 'r28s-2',
        sessionKey: 'r28s-3',
        cookie: 'r28s-4',
        cookies: 'r28s-5',
        cookieHeader: 'r28s-6',
        setCookie: 'r28s-7',
        pass2: 'r28s-8',
        cookieConsent: 'r28s-ok-1',
        cookieSettings: 'r28s-ok-2',
        sessionMode: 'r28s-ok-3',
      },
    };
    // session/cookie 为 kind 词：任意 token 位置精确匹配（cookies 单复数归一、
    // cookieHeader/setCookie camelCase 分词、sessionId/sessionKey 前缀 token）
    // 全部命中；pass2 版本后缀剥尽后余量恰为 'pass' 拒绝
    const leakKeys = ['session', 'sessionId', 'sessionKey', 'cookie', 'cookies', 'cookieHeader', 'setCookie', 'pass2'];
    const keepKeys = ['cookieConsent', 'cookieSettings', 'sessionMode'];
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': Object.keys(pluginData['com.example']) },
      }),
    );
    expect(error.declarations).toHaveLength(leakKeys.length);
    for (const key of leakKeys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    // 产品确认的良性歧义键（BENIGN_CREDENTIAL_KEYS）：声明与数据正常往返
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': keepKeys },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    for (const key of keepKeys) {
      expect(plugin[key]).toBe(pluginData['com.example'][key]);
    }
  });

  it('第二十八轮阻断 8：manifest 级声明校验 —— 声明凭据键但 pluginData 无对应命名空间时构建同样失败', async () => {
    const project = await buildFixtureProject();
    // pluginData 只有 'com.other' 命名空间，'com.example' 声明了凭据键：
    // 声明即契约，构建期校验独立于现有数据命名空间（旧实现只遍历 pluginData
    // 现有命名空间，此场景静默构建成功）
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.other': { theme: 'dark' } } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': ['apiKey', 'tokenBudget'] } },
      ),
    );
    expect(error.declarations).toHaveLength(1);
    expect(error.declarations).toContainEqual({ plugin: 'com.example', path: '"apiKey"' });
    // 合法声明 + 无对应数据命名空间：构建成功（无数据即无导出，命名空间整体排除）
    const pkg = buildProjectPackage(
      { ...project, pluginData: { 'com.other': { theme: 'dark' } } },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': ['theme'] } },
    );
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outPluginData = parsed.project.pluginData as Record<string, unknown> | undefined;
    expect(outPluginData?.['com.example']).toBeUndefined();
    expect(outPluginData?.['com.other']).toBeUndefined();
  });

  it('未知顶层字段不进入工程包（公开字段白名单）；tracks 属公开数据随包携带', async () => {
    const project = await buildFixtureProject();
    const rich = { ...project, runtimeCache: { x: 1 }, internalNote: 'zzz' } as Project & Record<string, unknown>;
    const json = JSON.stringify(buildProjectPackage(rich));
    expect(json).not.toContain('runtimeCache');
    expect(json).not.toContain('internalNote');
    expect(JSON.parse(json)).toMatchObject({ project: { tracks: project.tracks } });
  });

  it('导出导入往返 + 键级 allowlist：显式声明的键随包往返保留，未声明键（benign 组合词）排除；凭据形态键声明命中构建校验失败（第九轮 #4 契约化 + 第十三轮阻断 2 + 第十五轮阻断 1 + 第二十五轮指令 3）', async () => {
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
    // 完整词匹配（第十七轮阻断 1/严重 2）：tokenizerConfig 是合法键（含 token
    // 子串但不构成凭据词），声明即放行；apiKey/accessToken/clientSecret 分词
    // 命中 api/token/secret，声明命中 → 构建校验失败（第二十五轮指令 3，
    // 第十五轮阻断 1 语义保留），值绝不进包
    expectCredentialDeclarationRejected(() =>
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['apiKey', 'accessToken', 'clientSecret'] },
      }),
    );
    const pkg = buildProjectPackage(rich, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['keyboardLayout', 'monkeyPatch', 'tokenizerConfig'] },
    });
    const text = serializeProjectPackage(pkg);
    const parsed = await parseProjectPackage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    // 声明的非凭据键随包往返保留；未声明键（benign 组合词）与凭据键一律排除
    expect(plugin.keyboardLayout).toBe('kb-intl');
    expect(plugin.monkeyPatch).toBe('off');
    expect(plugin.hotkeyMap).toBeUndefined();
    expect(plugin.shortcutKey).toBeUndefined();
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

describe('工程包构建：全小写复合凭据键字典分词兜底 + manifest 声明校验无条件化（第二十九轮阻断 1/2）', () => {
  // 阻断 1：camelCase 分词无边界的全小写复合凭据键 —— 无边界形态候选表枚举
  // 不可闭合（session|id/api|key|value/password|digest 等不在派生候选表），
  // 字典分词任一分词命中 kind 词/根词/相邻复合对即拒绝
  const LOWER_COMPOUND_LEAKS = [
    'sessionid',
    'sessionkey',
    'cookieheader',
    'apikeyvalue',
    'apikeybackup',
    'passworddigest',
    'tokenpayload',
    'clientsecretbackup',
    'authheaderbackup',
  ];

  it('阻断 1：9 个全小写复合凭据键顶层声明一律拒绝，跨插件聚合上报', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': Object.fromEntries(LOWER_COMPOUND_LEAKS.map((key) => [key, `leak-${key}`])),
    };
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': LOWER_COMPOUND_LEAKS },
      }),
    );
    expect(error.declarations).toHaveLength(LOWER_COMPOUND_LEAKS.length);
    for (const key of LOWER_COMPOUND_LEAKS) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.message).toContain('凭据永不导出');
  });

  it('阻断 1：9 键嵌套路径声明（["profile", key]）一律拒绝（逐 segment 独立判定闭合）', async () => {
    const project = await buildFixtureProject();
    const pluginData = {
      'com.example': { profile: Object.fromEntries(LOWER_COMPOUND_LEAKS.map((key) => [key, `n-${key}`])) },
    };
    const declarations: Array<readonly string[]> = LOWER_COMPOUND_LEAKS.map((key) => ['profile', key]);
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': declarations },
      }),
    );
    expect(error.declarations).toHaveLength(LOWER_COMPOUND_LEAKS.length);
    for (const key of LOWER_COMPOUND_LEAKS) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(['profile', key]) });
    }
  });

  it('阻断 1：大小写/数字/环境后缀变体同样拒绝（SESSIONID/全角/SessionId/sessionid2/sessionidv2/sessionidprod），无边界归一收敛到同一判定', async () => {
    const project = await buildFixtureProject();
    const variants = [
      'SESSIONID',
      'SESSIONKEY',
      'COOKIEHEADER',
      'APIKEYVALUE',
      'APIKEYBACKUP',
      'PASSWORDDIGEST',
      'TOKENPAYLOAD',
      'CLIENTSECRETBACKUP',
      'AUTHHEADERBACKUP',
      'SessionId',
      'ApiKeyValue',
      'PasswordDigest',
      'sessionid2',
      'sessionidv2',
      'sessionidprod',
      'apikeyvalue2',
      'apikeyvaluebeta',
      'passworddigestv3',
      'tokenpayload2',
      'clientsecretbackupprod',
      'authheaderbackup2',
      'cookieheaderstage',
      'ＡＰＩＫＥＹＶＡＬＵＥ', // 全角：NFKC 归一后同一无边界形态
      'session_id',
      'api.key.value',
      'api-key-backup',
    ];
    const pluginData = { 'com.example': Object.fromEntries(variants.map((key) => [key, `v-${key}`])) };
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': variants },
      }),
    );
    expect(error.declarations).toHaveLength(variants.length);
    for (const key of variants) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('阻断 1：合法键与良性歧义键不受字典分词影响 —— 全量放行键（含 pass/render/passwordless/apiKeyboardLayout/tokenBudget 等）声明与数据无损往返', async () => {
    const project = await buildFixtureProject();
    const keepKeys = [
      'passwordless',
      'apiKeyboardLayout',
      'accessTokenizerConfig',
      'privateKeyboardShortcuts',
      'compassWordWrap',
      'tokenizerConfig',
      'authorName',
      'authorizationMode',
      'apiVersion',
      'apiVersion3',
      'MONKEYPATCH',
      'HOTKEYMAP',
      'keyboardLayout',
      'shortcutKey',
      'shortcutKeys',
      'renderPass',
      'renderPass2',
      'passCount',
      'layout2',
      'version2',
      'wordWrap2',
      'tokenBudget',
      'authMode',
      'cookieConsent',
      'cookieSettings',
      'sessionMode',
      'pass',
      'key',
      'value',
      'header',
      'id',
      'payload',
      'digest',
      'backup',
      'profile',
      'username',
      'theme',
      'model',
    ];
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': Object.fromEntries(keepKeys.map((key, i) => [key, `r29-keep-${i}`])),
    };
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': keepKeys },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    for (const [key, value] of Object.entries(pluginData['com.example'])) {
      expect(plugin[key]).toBe(value);
    }
    const json = JSON.stringify(parsed.project);
    for (let i = 0; i < keepKeys.length; i += 1) {
      expect(json).toContain(`r29-keep-${i}`);
    }
    // 含凭据子串的合法键不因分词误伤：passwordless 内 password|less 中 less 不在
    // 字典、renderPass 中 pass 单段非凭据形态、apiKeyboardLayout 中 board 不在字典
    expect(json).toContain('"passwordless"');
    expect(json).toContain('"renderPass"');
    expect(json).toContain('"apiKeyboardLayout"');
    expect(json).toContain('"tokenBudget"');
  });

  it('阻断 2：pluginData 缺失/undefined/非普通对象时 manifest 声明校验仍无条件执行 —— 凭据键声明一律拒绝，合法声明构建成功且 pluginData 不进包', async () => {
    const project = await buildFixtureProject();
    const credentialDeclarations = { 'com.example': ['apiKey', 'tokenBudget'] };
    // 缺失：project 无 pluginData 字段（声明凭据键 → 仍须失败，修复前静默成功；
    // tokenBudget 为 BENIGN 白名单键，豁免不受影响）
    const missingError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project }, { includePrivate: true, publicKeysByPlugin: credentialDeclarations }),
    );
    expect(missingError.declarations).toHaveLength(1);
    expect(missingError.declarations).toContainEqual({ plugin: 'com.example', path: '"apiKey"' });
    // undefined：pluginData 显式为 undefined
    const undefinedError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData: undefined as unknown as Project['pluginData'] }, {
        includePrivate: true,
        publicKeysByPlugin: credentialDeclarations,
      }),
    );
    expect(undefinedError.declarations).toHaveLength(1);
    // 非普通对象：pluginData 为数组（非 record 投影源）
    const arrayError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData: ['not-a-record'] as unknown as Project['pluginData'] }, {
        includePrivate: true,
        publicKeysByPlugin: credentialDeclarations,
      }),
    );
    expect(arrayError.declarations).toHaveLength(1);
    // 合法声明 + pluginData 缺失：构建成功（无数据即无导出），pluginData 不进包
    const pkg = buildProjectPackage(
      { ...project },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': ['theme'] } },
    );
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.project as { pluginData?: unknown }).pluginData).toBeUndefined();
  });
});

describe('工程包构建：任意偏移凭据分段兜底 + fail-closed 长度上限（第三十轮阻断 1）', () => {
  // 阻断 1：未知业务限定词（stripe/custom/vendor/legacy/payment）阻断旧「整键
  // 完整分词」判定 → fail-open 泄漏；任意偏移 ≥2 段连续字典词序列（含凭据词段
  // 或相邻复合对）即拒绝（审查员 06:58 六组探针）
  const UNKNOWN_QUALIFIER_LEAKS = [
    'stripeapikey',
    'customprivatekey',
    'vendorauthheader',
    'legacysecretkey',
    'paymentsessionid',
    'custompassworddigest',
  ];

  it('阻断 1：未知业务限定词包裹的凭据序列顶层声明一律拒绝（任意偏移兜底闭合）', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': Object.fromEntries(UNKNOWN_QUALIFIER_LEAKS.map((key) => [key, `leak-${key}`])),
    };
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': UNKNOWN_QUALIFIER_LEAKS },
      }),
    );
    expect(error.declarations).toHaveLength(UNKNOWN_QUALIFIER_LEAKS.length);
    for (const key of UNKNOWN_QUALIFIER_LEAKS) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.message).toContain('凭据永不导出');
  });

  it('阻断 1：六组探针嵌套路径声明（["profile", key]）同样拒绝（逐 segment 独立判定闭合）', async () => {
    const project = await buildFixtureProject();
    const pluginData = {
      'com.example': { profile: Object.fromEntries(UNKNOWN_QUALIFIER_LEAKS.map((key) => [key, `n-${key}`])) },
    };
    const declarations: Array<readonly string[]> = UNKNOWN_QUALIFIER_LEAKS.map((key) => ['profile', key]);
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': declarations },
      }),
    );
    expect(error.declarations).toHaveLength(UNKNOWN_QUALIFIER_LEAKS.length);
    for (const key of UNKNOWN_QUALIFIER_LEAKS) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(['profile', key]) });
    }
  });

  it('阻断 1：81 字符超限键与五层 prod 后缀键同样拒绝（长度上限 fail-closed + 任意偏移兜底）', async () => {
    const project = await buildFixtureProject();
    // 81 字符：旧实现 collapsed.length > 80 直接放行（fail-open，81 字符
    // ...sessionid 泄漏）；fail-closed 后一律按凭据形态拒绝
    const overlongSessionId = `${'a'.repeat(72)}sessionid`;
    expect(overlongSessionId.length).toBe(81);
    // 五层 prod 后缀：后缀剥除上限 4 层后余量 sessionidprod，任意偏移兜底
    // 检测 session|id 连续词段（旧实现完整分词被 prod 阻断而泄漏）
    const fiveLayerProd = 'sessionidprodprodprodprodprod';
    const keys = [overlongSessionId, fiveLayerProd];
    const pluginData = { 'com.example': Object.fromEntries(keys.map((key) => [key, `v-${key}`])) };
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': keys },
      }),
    );
    expect(error.declarations).toHaveLength(keys.length);
    for (const key of keys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('阻断 1：任意偏移兜底不误伤合法键 —— 良性歧义键（新登记 apiKeyboardLayout 等）与单段词键声明数据无损往返', async () => {
    const project = await buildFixtureProject();
    const keepKeys = [
      // 第三十轮新登记 BENIGN 键（≥2 段序列但产品确认良性，逐项可审计）
      'apiKeyboardLayout',
      'compassWordWrap',
      'privateKeyboardShortcuts',
      'accessTokenizerConfig',
      // 单段词键：任意偏移检测的 ≥2 段阈值不误伤
      'tokenizerConfig',
      'authorizationMode',
      'passwordless',
      'renderPass',
      'keyboard',
      'hotkey',
      'passCount',
      'wordWrap',
    ];
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': Object.fromEntries(keepKeys.map((key, i) => [key, `r30-keep-${i}`])),
    };
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': keepKeys },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    for (const [key, value] of Object.entries(pluginData['com.example'])) {
      expect(plugin[key]).toBe(value);
    }
    const json = JSON.stringify(parsed.project);
    for (let i = 0; i < keepKeys.length; i += 1) {
      expect(json).toContain(`r30-keep-${i}`);
    }
  });
});

describe('工程包构建：单一高置信段默认拒绝 + 单调后缀剥除 fail-closed（第三十一轮阻断 1）', () => {
  // 阻断 1：旧「≥2 段连续词序列」阈值被非字典尾词阻断而 fail-open ——
  // passwordblob/tokendata/secretconfig/sessionhandle/cookiejar/
  // custompasswordblob 等「单一高置信 kind/root 段 + 未知业务词」形态泄漏
  // （审查员第三十一轮阻断 1）；第三十一轮改「单一高置信命中即默认拒绝」，
  // 合法完整键经 BENIGN_CREDENTIAL_KEYS 整键精确豁免
  const SINGLE_HIT_LEAKS = [
    'passwordblob',
    'tokendata',
    'secretconfig',
    'sessionhandle',
    'cookiejar',
    'custompasswordblob',
  ];
  // camelCase/全小写等价：两种表示法统一 token 化，同一单命中判据拒绝
  const SINGLE_HIT_CAMEL = [
    'passwordBlob',
    'tokenData',
    'secretConfig',
    'sessionHandle',
    'cookieJar',
    'customPasswordBlob',
  ];

  it('阻断 1：单高置信段 + 未知词（passwordblob/tokendata/secretconfig/sessionhandle/cookiejar/custompasswordblob）顶层声明一律拒绝（含 camelCase 等价形态）', async () => {
    const project = await buildFixtureProject();
    const keys = [...SINGLE_HIT_LEAKS, ...SINGLE_HIT_CAMEL];
    const pluginData = { 'com.example': Object.fromEntries(keys.map((key) => [key, `r31-${key}`])) };
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': keys },
      }),
    );
    expect(error.declarations).toHaveLength(keys.length);
    for (const key of keys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
    expect(error.message).toContain('凭据永不导出');
  });

  it('阻断 1：六组探针嵌套路径声明（["profile", key]）同样拒绝（逐 segment 独立判定闭合）', async () => {
    const project = await buildFixtureProject();
    const keys = [...SINGLE_HIT_LEAKS, ...SINGLE_HIT_CAMEL];
    const pluginData = {
      'com.example': { profile: Object.fromEntries(keys.map((key) => [key, `n-${key}`])) },
    };
    const declarations: Array<readonly string[]> = keys.map((key) => ['profile', key]);
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': declarations },
      }),
    );
    expect(error.declarations).toHaveLength(keys.length);
    for (const key of keys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(['profile', key]) });
    }
  });

  it('阻断 1：5+ 层后缀单调剥除闭合（passprod×5 剥至 pass 拒绝）+ 防御上限 fail-closed（15 层病态链拒绝）', async () => {
    const project = await buildFixtureProject();
    // 5 层 prod：旧固定 4 层上限剥后剩 passprod（'pass' 单段非凭据、核心判定
    // 不命中）fail-open；单调剥除逐层剥至余量恰为 'pass' 才闭合
    const fiveLayerPass = 'passprodprodprodprodprod';
    // secret/password 根词段在核心判定即命中（任意偏移兜底），后缀剥除不参与
    const fiveLayerSecret = 'secretprodprodprodprodprod';
    const fiveLayerPassword = 'passwordprodprodprodprodprod';
    // 15 层（> 12 层防御上限）：单调剥除不收敛即 fail-closed 拒绝，
    // 绝不因「剥不干净」放行
    const capExceedPass = `pass${'prod'.repeat(15)}`;
    const keys = [fiveLayerPass, fiveLayerSecret, fiveLayerPassword, capExceedPass];
    const pluginData = { 'com.example': Object.fromEntries(keys.map((key) => [key, `s-${key}`])) };
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': keys },
      }),
    );
    expect(error.declarations).toHaveLength(keys.length);
    for (const key of keys) {
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('一般 5：后缀剥除预算边界 —— 11/12 层剥到稳定安全基键放行，13 层超预算 fail-closed', async () => {
    const project = await buildFixtureProject();
    // 安全基键 theme（非凭据段）+ prod×N：单调剥除到 'theme' 即稳定。
    // 第 12 次剥除恰好到达基键时 stable 标志未及置位 —— 修复前 off-by-one
    // 把 theme+prod×12 误拒（theme+prod×11 因第 12 次迭代探测到无可剥后缀
    // 置位 stable 而放行，×12 却在循环耗尽时按 stable=false 拒绝）
    const theme11 = `theme${'prod'.repeat(11)}`;
    const theme12 = `theme${'prod'.repeat(12)}`;
    const pluginData = {
      'com.example': { [theme11]: 'r32-keep-11', [theme12]: 'r32-keep-12' },
    };
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': [theme11, theme12] },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    expect(plugin[theme11]).toBe('r32-keep-11');
    expect(plugin[theme12]).toBe('r32-keep-12');

    // 13 层：12 层预算内剥不完（余量 themeprod 仍可剥）→ fail-closed 整包拒绝
    const theme13 = `theme${'prod'.repeat(13)}`;
    const error = expectCredentialDeclarationRejected(() =>
      buildProjectPackage({ ...project, pluginData: { 'com.example': { [theme13]: 'r32-reject-13' } } }, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': [theme13] },
      }),
    );
    expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(theme13) });
  });

  it('阻断 1：良性单命中豁免往返 —— 单段 token/auth/password 命中的合法键（tokenizer 系/authorName/authorizationMode/passwordless）与既有 BENIGN 键全量放行，路径数组形态与字符串声明等价', async () => {
    const project = await buildFixtureProject();
    const benignKeys = [
      'tokenBudget',
      'authMode',
      'cookieConsent',
      'cookieSettings',
      'sessionMode',
      'apiKeyboardLayout',
      'compassWordWrap',
      'privateKeyboardShortcuts',
      'accessTokenizerConfig',
      'tokenizerConfig',
      'tokenizerModel',
      'tokenizerConfigModel',
      'authorName',
      'authorizationMode',
      'passwordless',
    ];
    // 路径数组形态 ≡ 字符串声明（BENIGN 整键拼接，['tokenizer','config'] ≡
    // tokenizerConfig 等）；第三十二轮严重 3 起末尾拆分形态经 isBenignCredentialKey
    // 统一判定（['cookie','consent'] ≡ 'cookieConsent'、嵌套拆分
    // ['profile','tokenizer','config'] ≡ ['profile','tokenizerConfig']，大小写
    // 不敏感），裸 kind 段（['profile','token'] 等）依旧拒绝（第二十三轮阻断 3）
    const benignPaths: Array<readonly string[]> = [
      ['tokenizer', 'config'],
      ['tokenizer', 'model'],
      ['access', 'tokenizer', 'config'],
    ];
    const pluginData: Record<string, Record<string, string>> = {
      'com.example': Object.fromEntries(benignKeys.map((key, i) => [key, `r31-keep-${i}`])),
    };
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': [...benignKeys, ...benignPaths] },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    for (const [key, value] of Object.entries(pluginData['com.example'])) {
      expect(plugin[key]).toBe(value);
    }
    const json = JSON.stringify(parsed.project);
    for (let i = 0; i < benignKeys.length; i += 1) {
      expect(json).toContain(`r31-keep-${i}`);
    }
  });

  it('严重 3：良性豁免统一规范化 —— 顶层/嵌套叶/整键/嵌套拆分同一键同一判定，真实嵌套数据大小写与字符串/路径变体往返', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, unknown> = {
      'com.example': {
        // 顶层大小写变体（修复前 'TOKENIZERCONFIG' 经 core 未命中碰巧放行，
        // 'SESSIONMODE'/'cookieconsent' 同理 —— 现在经统一 helper 显式豁免）
        TOKENIZERCONFIG: 'r32-1',
        SESSIONMODE: 'r32-2',
        cookieconsent: 'r32-3',
        profile: {
          // 嵌套叶大小写变体（修复前 ['profile','TOKENIZERCONFIG'] 拒绝、
          // ['profile','tokenizerConfig'] 放行 —— 同一键异判）
          TOKENIZERCONFIG: 'r32-4',
          tokenizerConfig: 'r32-5',
          // 嵌套拆分（修复前根 ['tokenizer','config'] 放行、嵌套同路径拒绝；
          // kind 词段 'cookie'/'session' 因处于良性键拆分形态而豁免）
          tokenizer: { config: 'r32-6' },
          cookie: { consent: 'r32-7' },
          session: { mode: 'r32-8' },
          // 叶良性键与拆分形态等价（['profile','token','budget'] ≡
          // ['profile','tokenBudget']）
          tokenBudget: 'r32-9',
          token: { budget: 'r32-10' },
        },
      },
    };
    const declarations: Array<string | readonly string[]> = [
      'TOKENIZERCONFIG',
      'SESSIONMODE',
      'cookieconsent',
      ['profile', 'TOKENIZERCONFIG'],
      ['profile', 'tokenizerConfig'],
      ['profile', 'tokenizer', 'config'],
      ['profile', 'cookie', 'consent'],
      ['profile', 'session', 'mode'],
      ['profile', 'tokenBudget'],
      ['profile', 'token', 'budget'],
    ];
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': declarations },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, unknown>)['com.example'];
    expect(plugin).toEqual({
      TOKENIZERCONFIG: 'r32-1',
      SESSIONMODE: 'r32-2',
      cookieconsent: 'r32-3',
      profile: {
        TOKENIZERCONFIG: 'r32-4',
        tokenizerConfig: 'r32-5',
        tokenizer: { config: 'r32-6' },
        cookie: { consent: 'r32-7' },
        session: { mode: 'r32-8' },
        tokenBudget: 'r32-9',
        token: { budget: 'r32-10' },
      },
    });
    // 统一判据不扩大放行面：带良性后缀的路径其余段仍按前缀判据拒绝
    const prefixError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.example': { profile: { apikey: { tokenizer: { config: 'x' } } } } } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': [['profile', 'apikey', 'tokenizer', 'config']] } },
      ),
    );
    expect(prefixError.declarations).toEqual([{ plugin: 'com.example', path: '["profile","apikey","tokenizer","config"]' }]);
    // 裸 kind 段（非良性键拆分形态）依旧拒绝
    const bareError = expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        { ...project, pluginData: { 'com.example': { profile: { token: 'x', cookie: { value: 'y' } } } } },
        { includePrivate: true, publicKeysByPlugin: { 'com.example': [['profile', 'token'], ['profile', 'cookie', 'value']] } },
      ),
    );
    expect(bareError.declarations).toHaveLength(2);
    expect(bareError.declarations).toContainEqual({ plugin: 'com.example', path: '["profile","token"]' });
    expect(bareError.declarations).toContainEqual({ plugin: 'com.example', path: '["profile","cookie","value"]' });
  });
});

describe('第三十三轮阻断 1：CJK/日/韩凭据根不得经 BENIGN 规范化碰撞放行', () => {
  // 审查员复现集：修复前 collapsedCredentialForm 的 [^a-z0-9] 把 CJK/日/韩凭据根词
  // 一并剥除 —— '密码tokenizerConfig' → 'tokenizerconfig' 命中良性白名单放行且值进包；
  // 控制项 '密码blob' 剥后 'blob' 不命中白名单、走 CJK 根检查被拒 —— 同含凭据根的
  // 两个键仅因 BENIGN 碰撞分化，证明泄漏来自白名单短路
  const cjkTopLevel = [
    '密码tokenizerConfig',
    'tokenizerConfig密码',
    '密碼tokenBudget',
    'パスワードauthMode',
    '비밀번호tokenizerConfig',
    '密码blob', // 控制项：无 BENIGN 碰撞时本来就拒绝
  ];
  const cjkNestedLeaves = [
    ['profile', '密码tokenizerConfig'],
    ['profile', 'tokenizerConfig密码'],
    ['profile', '密碼tokenBudget'],
    ['profile', 'パスワードauthMode'],
    ['profile', '비밀번호tokenizerConfig'],
  ];
  const cjkSplitPaths = [
    ['profile', '密码', 'tokenizer', 'config'],
    ['profile', 'tokenizer', 'config', '密码'],
    ['profile', '密碼', 'token', 'budget'],
    ['profile', 'パスワード', 'auth', 'mode'],
  ];

  it('顶层整键：CJK/日/韩凭据根 + 良性键前缀/后缀拼接全部拒绝，值不进包', async () => {
    const project = await buildFixtureProject();
    for (const key of cjkTopLevel) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { [key]: 'leak-r33' } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [key] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('嵌套叶键：与顶层同一判据，CJK 凭据根落叶键一律拒绝', async () => {
    const project = await buildFixtureProject();
    for (const path of cjkNestedLeaves) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { profile: { [path[1]!]: 'leak-r33' } } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [path] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(path) });
    }
  });

  it('拆分路径：CJK 根落任意段（叶段/中间段/后缀段）均拒绝，良性后缀识别不再吞掉非 ASCII 前缀', async () => {
    const project = await buildFixtureProject();
    for (const path of cjkSplitPaths) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: {} },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [path] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(path) });
    }
  });

  it('BENIGN 反向矩阵：纯 ASCII 良性键（含全角分隔变体）声明与数据无损往返，修复不误伤', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, unknown> = {
      'com.example': {
        tokenizerConfig: 'keep-1',
        'TOKENIZER；CONFIG': 'keep-2', // 全角分号经 NFKC → ASCII 分隔符剥除，仍命中白名单
        tokenBudget: 'keep-3',
        authMode: 'keep-4',
        cookieConsent: 'keep-5',
        profile: {
          tokenizerConfig: 'keep-6',
          tokenizer: { config: 'keep-7' },
          cookie: { consent: 'keep-8' },
          token: { budget: 'keep-9' },
        },
      },
    };
    const declarations: Array<string | readonly string[]> = [
      'tokenizerConfig',
      'TOKENIZER；CONFIG',
      'tokenBudget',
      'authMode',
      'cookieConsent',
      ['profile', 'tokenizerConfig'],
      ['profile', 'tokenizer', 'config'],
      ['profile', 'cookie', 'consent'],
      ['profile', 'token', 'budget'],
    ];
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': declarations },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, unknown>)['com.example'];
    expect(plugin).toEqual({
      tokenizerConfig: 'keep-1',
      'TOKENIZER；CONFIG': 'keep-2',
      tokenBudget: 'keep-3',
      authMode: 'keep-4',
      cookieConsent: 'keep-5',
      profile: {
        tokenizerConfig: 'keep-6',
        tokenizer: { config: 'keep-7' },
        cookie: { consent: 'keep-8' },
        token: { budget: 'keep-9' },
      },
    });
  });

  it('真实嵌套数据往返：含 CJK 凭据根的声明即使混合合法键也整体构建失败（manifest 级校验先于数据投影）', async () => {
    const project = await buildFixtureProject();
    // 合法键 tokenizerConfig 与凭据根键混同声明：凭据根声明拒绝 → 整次构建失败，
    // 不存在「凭据键静默不进包、合法键照常进包」的假成功路径
    expectCredentialDeclarationRejected(() =>
      buildProjectPackage(
        {
          ...project,
          pluginData: {
            'com.example': {
              tokenizerConfig: 'keep',
              profile: { 密码tokenizerConfig: 'leak', tokenizer: { config: { 密码: 'leak' } } },
            },
          },
        },
        {
          includePrivate: true,
          publicKeysByPlugin: {
            'com.example': [
              'tokenizerConfig',
              ['profile', '密码tokenizerConfig'],
              ['profile', 'tokenizer', 'config', '密码'],
            ],
          },
        },
      ),
    );
  });
});

describe('第三十四轮阻断 2：零宽字符（U+200B/U+FE0F）注入不得绕过凭据根与 BENIGN', () => {
  // 修复前：containsCredentialCjkRoot 的 NFKC 包含匹配对 '密'+U+200B+'码'（ZWSP
  // 插入）不命中；hasCredentialSegmentation 内对已折叠值（collapsedCredentialForm
  // 剥掉全部非 ASCII）再做 BENIGN 短路 —— '密'+U+200B+'码tokenizerConfig' 折叠
  // 为 'tokenizerconfig' 命中白名单放行，凭据值进包
  const zwsp = '\u200b';
  const vs16 = '\ufe0f';
  const topLevel = [
    `密${zwsp}码tokenizerConfig`,
    `密${vs16}码tokenizerConfig`,
    `密碼${zwsp}tokenizerConfig`,
    `パスワード${zwsp}authMode`,
    `비밀번호${zwsp}tokenizerConfig`,
  ];
  const nestedLeaves = [
    ['profile', `密${zwsp}码tokenizerConfig`],
    ['profile', `密${vs16}码tokenizerConfig`],
    ['profile', `密碼${zwsp}tokenBudget`],
  ];
  const splitPaths = [
    ['profile', `密${zwsp}码`, 'tokenizer', 'config'],
    ['profile', `密${vs16}码`, 'tokenizer', 'config'],
    ['profile', 'tokenizer', 'config', `密${zwsp}码`],
  ];
  const benignInjections = [`tokenizer${zwsp}Config`, `tokenizer${vs16}Config`];

  it('顶层整键：ZWSP/VS16 注入的 CJK/日/韩凭据根键全部拒绝，值不进包', async () => {
    const project = await buildFixtureProject();
    for (const key of topLevel) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { [key]: 'leak-r34' } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [key] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('嵌套叶键：零宽注入落叶键一律拒绝', async () => {
    const project = await buildFixtureProject();
    for (const path of nestedLeaves) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { profile: { [path[1]!]: 'leak-r34' } } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [path] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(path) });
    }
  });

  it('拆分路径：零宽注入的凭据根落任意段均拒绝（良性后缀识别不再吞掉注入前缀）', async () => {
    const project = await buildFixtureProject();
    for (const path of splitPaths) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: {} },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [path] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(path) });
    }
  });

  it('良性键的零宽变体拒绝（fail-closed）：白名单是精确豁免，零宽写法不入表', async () => {
    const project = await buildFixtureProject();
    for (const key of benignInjections) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { [key]: 'leak-r34' } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [key] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('BENIGN 正向往返不受影响（回归）：纯 ASCII 良性键与嵌套拆分仍无损往返', async () => {
    const project = await buildFixtureProject();
    const pluginData: Record<string, unknown> = {
      'com.example': {
        tokenizerConfig: 'keep-1',
        tokenBudget: 'keep-2',
        authMode: 'keep-3',
        profile: {
          tokenizerConfig: 'keep-4',
          tokenizer: { config: 'keep-5' },
          cookie: { consent: 'keep-6' },
        },
      },
    };
    const declarations: Array<string | readonly string[]> = [
      'tokenizerConfig',
      'tokenBudget',
      'authMode',
      ['profile', 'tokenizerConfig'],
      ['profile', 'tokenizer', 'config'],
      ['profile', 'cookie', 'consent'],
    ];
    const pkg = buildProjectPackage({ ...project, pluginData }, {
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': declarations },
    });
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, unknown>)['com.example'];
    expect(plugin).toEqual({
      tokenizerConfig: 'keep-1',
      tokenBudget: 'keep-2',
      authMode: 'keep-3',
      profile: {
        tokenizerConfig: 'keep-4',
        tokenizer: { config: 'keep-5' },
        cookie: { consent: 'keep-6' },
      },
    });
  });
});

describe('第三十五轮阻断 2：C0/C1/DEL 控制字符（NUL/TAB）不得经 BENIGN 规范化收敛放行', () => {
  // 修复前：collapsed/benign 规范化把全部 ASCII 非字母数字（含 NUL/TAB）当分隔符
  // 剥除 —— 'token<NUL>izerConfig' → 'tokenizerconfig' 命中 BENIGN 精确豁免而放行、
  // 凭据值进包。修复后控制字符保留（含控制字符的形态无法与纯 ASCII 白名单精确
  // 相等），且声明入口对控制字符显式拒绝（带路径明细）
  const nul = '\u0000';
  const tab = '\t';
  const del = '\u007f';
  const topLevel = [`token${nul}izerConfig`, `token${tab}izerConfig`, `password${nul}less`, `config${del}prod`];
  const nestedLeaves = [
    ['profile', `token${nul}izerConfig`],
    ['profile', `password${nul}less`],
    ['profile', `config${tab}prod`],
  ];
  const splitPaths = [
    ['profile', `token${nul}izer`, 'config'],
    ['profile', `token${tab}izer`, 'config'],
    ['profile', `config${nul}prod`],
  ];

  it('顶层整键：NUL/TAB/DEL 注入的敏感键与任意控制字符键一律拒绝', async () => {
    const project = await buildFixtureProject();
    for (const key of topLevel) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { [key]: 'leak-r35' } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [key] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(key) });
    }
  });

  it('嵌套叶键：控制字符注入落叶键一律拒绝，值不进包', async () => {
    const project = await buildFixtureProject();
    for (const path of nestedLeaves) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: { 'com.example': { profile: { [path[1]!]: 'leak-r35' } } } },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [path] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(path) });
    }
  });

  it('拆分路径：控制字符落任意段均拒绝（BENIGN 最长后缀识别不再吞掉控制字符注入）', async () => {
    const project = await buildFixtureProject();
    for (const path of splitPaths) {
      const error = expectCredentialDeclarationRejected(() =>
        buildProjectPackage(
          { ...project, pluginData: {} },
          { includePrivate: true, publicKeysByPlugin: { 'com.example': [path] } },
        ),
      );
      expect(error.declarations).toContainEqual({ plugin: 'com.example', path: JSON.stringify(path) });
    }
  });

  it('序列化值不进包：未声明的控制字符键值不随插件命名空间导出（数据投影兜底）', async () => {
    const project = await buildFixtureProject();
    const pkg = buildProjectPackage(
      {
        ...project,
        pluginData: {
          'com.example': {
            tokenizerConfig: 'keep-1',
            [`token${nul}izerConfig`]: 'leak-r35',
            profile: { [`password${nul}less`]: 'leak-r35-2', authMode: 'keep-2' },
          },
        },
      },
      { includePrivate: true, publicKeysByPlugin: { 'com.example': ['tokenizerConfig', ['profile', 'authMode']] } },
    );
    const parsed = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plugin = (parsed.project.pluginData as Record<string, unknown>)['com.example'];
    expect(plugin).toEqual({ tokenizerConfig: 'keep-1', profile: { authMode: 'keep-2' } });
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
    // apiKey 凭据形态声明命中 → 构建校验失败（第二十五轮指令 3，第十五轮阻断 1 语义保留）
    const declarations = Object.create(null) as Record<string, string[]>;
    declarations['__proto__'] = ['apiKey'];
    declarations['com.example'] = ['apiKey', '__proto__', 'theme'];
    const poisonedValue = Object.create(null) as Record<string, unknown>;
    poisonedValue['apiKey'] = 'sk-strip-1';
    poisonedValue['theme'] = 'dark';
    poisonedValue['__proto__'] = { pollute: 'proto-polluted' };
    const rich = { ...project, pluginData: { 'com.example': poisonedValue } } as Project;
    expectCredentialDeclarationRejected(() =>
      buildProjectPackage(rich, { includePrivate: true, publicKeysByPlugin: declarations }),
    );
    // 剔除凭据声明后：__proto__ 声明注入仍不放行（原型污染矢量），正常声明不受影响
    const legalDeclarations = Object.create(null) as Record<string, string[]>;
    legalDeclarations['__proto__'] = ['theme'];
    legalDeclarations['com.example'] = ['__proto__', 'theme'];
    const strippedJson = JSON.stringify(
      buildProjectPackage(rich, { includePrivate: true, publicKeysByPlugin: legalDeclarations }),
    );
    expect(strippedJson).toContain('dark');
    expect(strippedJson).not.toContain('sk-strip-1');
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

  it('路径 schema：声明路径导出嵌套公开字段，未声明路径与嵌套凭据排除；凭据形态路径声明命中构建校验失败（第十四轮阻断 1 + 第十五轮阻断 1 + 第二十五轮指令 3）', async () => {
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
    // 路径含凭据形态键（auth/apiKey）的整条声明命中 → 构建校验失败
    // （第二十五轮指令 3，第十五轮阻断 1 语义保留）—— sk-nested-2 绝不进包
    expectCredentialDeclarationRejected(() =>
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: {
          'com.example': ['theme', ['profile', 'username'], ['profile', 'auth', 'apiKey']],
        },
      }),
    );
    const json = JSON.stringify(
      buildProjectPackage(rich, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': ['theme', ['profile', 'username']] },
      }),
    );
    // 顶层键整值导出；路径末端键按路径导出
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

describe('parseProjectPackage：timeline 基数预算先于深校验', () => {
  function rawSamplePackage(): { project: Record<string, unknown> } {
    return JSON.parse(
      serializeProjectPackage(buildProjectPackage(createSampleProject())),
    ) as { project: Record<string, unknown> };
  }

  const limits = (overrides: Record<string, number>) => ({
    maxTracksPerProject: 100,
    maxShotsPerProject: 100,
    maxKeyframesPerTrack: 100,
    maxTotalKeyframes: 100,
    ...overrides,
  });

  it('轨道数超限时在非法轨道条目深校验前返回 too-large', async () => {
    const raw = rawSamplePackage();
    raw.project.tracks = [null, null, null];
    const result = await parseProjectPackage(JSON.stringify(raw), limits({ maxTracksPerProject: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('too-large');
      expect(result.error.message).toContain('轨道数超过上限（3 > 2）');
    }
  });

  it('分镜数超限时在非法分镜条目深校验前返回 too-large', async () => {
    const raw = rawSamplePackage();
    raw.project.shots = [null, null, null, null];
    const result = await parseProjectPackage(JSON.stringify(raw), limits({ maxShotsPerProject: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('too-large');
      expect(result.error.message).toContain('分镜数超过上限（4 > 3）');
    }
  });

  it('单轨关键帧超限时在非法关键帧深校验前返回 too-large', async () => {
    const raw = rawSamplePackage();
    raw.project.tracks = [{ keyframes: [null, null, null] }];
    const result = await parseProjectPackage(JSON.stringify(raw), limits({ maxKeyframesPerTrack: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('too-large');
      expect(result.error.message).toContain('单轨关键帧数超过上限（3 > 2）');
    }
  });

  it('累计关键帧超限时在非法轨道深校验前返回 too-large', async () => {
    const raw = rawSamplePackage();
    raw.project.tracks = [
      { keyframes: [null, null] },
      { keyframes: [null, null] },
    ];
    const result = await parseProjectPackage(JSON.stringify(raw), limits({ maxTotalKeyframes: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('too-large');
      expect(result.error.message).toContain('关键帧总数超过上限（4 > 3）');
    }
  });

  it('轨道与分镜引用校验不对 objects 数组执行逐条 find 扫描', () => {
    const sample = createSampleProject();
    const guardedObjects = [...sample.objects];
    Object.defineProperty(guardedObjects, 'find', {
      configurable: true,
      value: () => {
        throw new Error('quadratic object-array find is forbidden');
      },
    });
    let problem: string | null | undefined;

    expect(() => {
      problem = validateProjectSchema({ ...sample, objects: guardedObjects });
    }).not.toThrow();
    expect(problem).toBeNull();
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
    expect(project.schemaVersion).toBe(4);
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
