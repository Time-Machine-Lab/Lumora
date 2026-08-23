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

  it('未知顶层字段不进入工程包（公开字段白名单）；tracks 属公开数据随包携带', async () => {
    const project = await buildFixtureProject();
    const rich = { ...project, runtimeCache: { x: 1 }, internalNote: 'zzz' } as Project & Record<string, unknown>;
    const json = JSON.stringify(buildProjectPackage(rich));
    expect(json).not.toContain('runtimeCache');
    expect(json).not.toContain('internalNote');
    expect(JSON.parse(json)).toMatchObject({ project: { tracks: project.tracks } });
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

  it('凭据后缀词（privateKey/accessKey/providerKey/cookie/accessToken）清除；token 族配置与 keyframes 保留（第四轮 #5）', async () => {
    const project = await buildFixtureProject();
    const rich = {
      ...project,
      pluginData: {
        'com.example': {
          privateKey: 'sk-private-1',
          accessKey: 'ak-2',
          providerKey: 'pk-3',
          cookie: 'session-cookie-4',
          accessToken: 'at-6',
          apiKey: 'sk-7',
          password: 'pw-8',
          maxTokens: 2048,
          tokenizer: 'cl100k',
          tokenBudget: { max: 999 },
          keyframes: [1, 2, 3],
        },
      },
    } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    // 凭据（含此前漏网的 privateKey/accessKey/providerKey/cookie）不得进入包
    for (const leaked of ['sk-private-1', 'ak-2', 'pk-3', 'session-cookie-4', 'at-6', 'sk-7', 'pw-8']) {
      expect(json).not.toContain(leaked);
    }
    // 非凭据配置必须保留：token 族计数/分词配置（不得因「token」误杀）与关键帧数据
    expect(json).toContain('maxTokens');
    expect(json).toContain('tokenizer');
    expect(json).toContain('tokenBudget');
    expect(json).toContain('"keyframes":[1,2,3]');
    expect(json).toContain('2048');
    expect(json).toContain('cl100k');
  });

  it('凭据键名大小写/命名风格矩阵：分隔符/驼峰/首字母大写/全大写/紧凑别名全部清除（第五轮 #2）', async () => {
    const project = await buildFixtureProject();
    const stripped: Record<string, string> = {};
    const preserved: Record<string, string> = {};
    // 凭据族各命名风格：snake/kebab/小驼峰/大驼峰/全大写/全小写紧凑/全大写紧凑
    for (const key of [
      'api_key', 'api-key', 'apiKey', 'ApiKey', 'APIKey', 'API_KEY', 'apikey', 'APIKEY',
      'access_token', 'access-token', 'accessToken', 'AccessToken', 'ACCESS_TOKEN',
      'accesstoken', 'ACCESSTOKEN', 'access_keys', 'accessKeys', 'ACCESS_KEYS',
      'secret_key', 'secretKey', 'SecretKey', 'SECRET_KEY', 'secretkey', 'SECRETKEY',
      'client_secret', 'clientSecret', 'ClientSecret', 'CLIENT_SECRET',
      'clientsecret', 'CLIENTSECRET',
      'private_key', 'privateKey', 'PrivateKey', 'PRIVATE_KEY', 'PRIVATEKEY',
      'provider_key', 'providerKey', 'PROVIDER_KEY',
      'auth_cookie', 'authCookie', 'AUTH_COOKIE', 'session_cookie',
      'session_token', 'sessionToken', 'SESSION_TOKEN', 'token', 'TOKEN',
      'password', 'PASSWORD', 'Password',
      'credential', 'CREDENTIAL', 'Credentials', 'credentials',
      'authorization', 'AUTHORIZATION', 'Authorization',
      'secret', 'SECRET', 'Secret', 'secrets', 'SECRETS',
      'api_keys', 'API_KEYS', 'apikeys', 'APIKEYS',
    ]) {
      stripped[key] = `sensitive-${key}`;
    }
    // 非凭据配置：token 族计数/分词、key 前缀的词、普通配置（含全大写形态）
    for (const key of [
      'maxTokens', 'MAXTOKENS', 'max_tokens', 'max-tokens', 'MaxTokens',
      'tokenizer', 'TOKENIZER', 'tokenBudget', 'token_budget', 'tokenCount',
      'tokensPerSec', 'token_limit',
      'keyframes', 'KEYFRAMES', 'keyframeRate',
      '2048', 'cl100k', 'sampleRate', 'SAMPLE_RATE', 'apiUrl', 'API_URL', 'APIURL',
      'endpoint', 'url', 'URL',
    ]) {
      preserved[key] = `safe-${key}`;
    }
    const rich = { ...project, pluginData: { 'com.example': { ...stripped, ...preserved } } } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    for (const key of Object.keys(stripped)) {
      expect(json, `凭据键 ${key} 必须被清除`).not.toContain(`sensitive-${key}`);
    }
    for (const key of Object.keys(preserved)) {
      expect(json, `非凭据键 ${key} 必须保留`).toContain(`safe-${key}`);
    }
  });

  it('provider/token 组合矩阵（第七轮 #3）：任意 provider 限定的 token 族键默认敏感清除，不依赖有限前缀枚举；白名单普通配置保留', async () => {
    const project = await buildFixtureProject();
    const stripped: Record<string, string> = {};
    // provider/协议限定词 + token 的组合不可枚举（refreshToken/githubToken/
    // bearerToken/jwtToken/idToken/refresh_token 等）：核心词任意位置出现即默认敏感
    for (const key of [
      'refreshToken', 'refresh_token', 'refresh-token', 'RefreshToken', 'REFRESH_TOKEN',
      'githubToken', 'gitHubToken', 'GITHUB_TOKEN',
      'bearerToken', 'bearer_token', 'BEARER_TOKEN',
      'jwtToken', 'jwt_token', 'JWT_TOKEN',
      'idToken', 'id_token', 'ID_TOKEN',
      'anthropicApiKey', 'openaiApiKey', 'claudeToken', 'geminiToken', 'groqToken', 'xaiToken',
      'awsAccessKey', 'firebaseToken', 'stripeToken', 'slackToken', 'discordToken', 'oauthToken',
      'sessionToken', 'SESSION_TOKEN',
    ]) {
      stripped[key] = `secret-${key}`;
    }
    // 白名单窄例外：经确认的普通配置（快捷键/计数/关键帧）不受「核心词默认敏感」误杀
    const preserved: Record<string, string> = {};
    for (const key of ['shortcutKey', 'keyboardKey', 'primaryKey', 'cacheKey', 'maxToken', 'maxTokens', 'tokenBudget', 'tokenizer', 'keyframes']) {
      preserved[key] = `safe-${key}`;
    }
    const rich = { ...project, pluginData: { 'com.example': { ...stripped, ...preserved } } } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    for (const key of Object.keys(stripped)) {
      expect(json, `凭据键 ${key} 必须被清除`).not.toContain(`secret-${key}`);
    }
    for (const key of Object.keys(preserved)) {
      expect(json, `普通键 ${key} 必须保留`).toContain(`safe-${key}`);
    }
  });

  it('组合式规则（第六轮 #3）：provider 前缀 + value/pem 后缀的凭据键清除；普通 key/token 词保留', async () => {
    const project = await buildFixtureProject();
    const stripped: Record<string, string> = {};
    // 前缀限定词（api/access/ssh/private/provider）+ 后缀（Value/Pem）组合的凭据键：
    // 任意位置的 key/token 核心词在前词为敏感限定词时同样清除
    for (const key of [
      'OPENAIAPIKEY', 'openaiApiKey', 'apiKeyValue', 'apiKeyPem',
      'accessTokenValue', 'accessKeyId', 'sshPrivateKeyPem', 'providerKeyValue',
    ]) {
      stripped[key] = `secret-${key}`;
    }
    // 普通设置：非限定词的 key/token 末词（快捷键/主键/缓存键/计数）必须保留
    const preserved: Record<string, string> = {};
    for (const key of ['shortcutKey', 'keyboardKey', 'primaryKey', 'cacheKey', 'maxToken', 'tokenBudget', 'tokenizer']) {
      preserved[key] = `safe-${key}`;
    }
    const rich = { ...project, pluginData: { 'com.example': { ...stripped, ...preserved } } } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    for (const key of Object.keys(stripped)) {
      expect(json, `凭据键 ${key} 必须被清除`).not.toContain(`secret-${key}`);
    }
    for (const key of Object.keys(preserved)) {
      expect(json, `普通键 ${key} 必须保留`).toContain(`safe-${key}`);
    }
  });

  it('紧凑拼接形态：OPENAIAPIKEYVALUE/REFRESHTOKENVALUE 清除（核心词子串覆盖，第八轮 #3）；常见非凭据键保留', async () => {
    const project = await buildFixtureProject();
    // 无分隔符连续段拆不出词边界：OPENAIAPIKEYVALUE 是单一词，单词相等/后缀枚举
    // 都漏 —— 核心词（key/token）词内子串匹配必须兜住
    const stripped: Record<string, string> = {};
    for (const key of ['OPENAIAPIKEYVALUE', 'REFRESHTOKENVALUE', 'openaiapikeyvalue', 'refreshtokenvalue']) {
      stripped[key] = `secret-${key}`;
    }
    // 含核心词子串但属常见非凭据配置：规范化名精确命中白名单必须保留
    const preserved: Record<string, string> = {};
    for (const key of ['maxOutputTokens', 'tokenBudgetPerScene', 'keyBinding', 'maxTokens', 'tokenizer', 'keyframes']) {
      preserved[key] = `safe-${key}`;
    }
    const rich = { ...project, pluginData: { 'com.example': { ...stripped, ...preserved } } } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    for (const key of Object.keys(stripped)) {
      expect(json, `凭据键 ${key} 必须被清除`).not.toContain(`secret-${key}`);
    }
    for (const key of Object.keys(preserved)) {
      expect(json, `普通键 ${key} 必须保留`).toContain(`safe-${key}`);
    }
  });

  it('secret 族组合词矩阵（第九轮 #3）：全部敏感族（secret/password/credential/authorization）按同一组合词策略清除，含大小写与 provider 前后缀', async () => {
    const project = await buildFixtureProject();
    const stripped: Record<string, string> = {
      // 无分隔符连续串：单一词，必须由核心词子串覆盖（不再依赖有限枚举）
      SUPERSECRETVALUE: 'supersecret-1',
      DBPASSWORDVALUE: 'dbpassword-2',
      servicecredentialvalue: 'svc-cred-3',
      OAUTHCLIENTSECRETVALUE: 'oauth-secret-4',
      // 大小写变体
      SuperSecretValue: 'supersecret-5',
      dbPasswordValue: 'dbpassword-6',
      serviceCredential: 'svc-cred-7',
      authorizationToken: 'auth-tok-8',
      // provider 前缀/后缀
      openaiClientSecret: 'openai-secret-9',
      clientSecretForAnthropic: 'anthropic-secret-10',
      databasePassword: 'db-pwd-11',
      bearerAuthorization: 'bearer-auth-12',
      xAuthSecret: 'x-auth-13',
      authPassword: 'auth-pwd-14',
      credentialsJson: 'creds-15',
    };
    const rich = {
      ...project,
      pluginData: { 'com.example': { ...stripped, nested: { ...stripped } } },
    } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    for (const value of Object.values(stripped)) {
      expect(json, `凭据族值 ${value} 不得进入包`).not.toContain(value);
    }
  });

  it('普通插件设置组合词保留（第九轮 #4）：keyboardLayout/tokenizerConfig/monkeyPatch/hotkeyMap 及大小写/分隔符变体不被凭据启发式误删', async () => {
    const project = await buildFixtureProject();
    const preserved: Record<string, string> = {
      keyboardLayout: 'layout-1',
      tokenizerConfig: 'tokenizer-1',
      monkeyPatch: 'monkey-1',
      hotkeyMap: 'hotkey-1',
      // 大小写/分隔符变体（规范化后同入白名单）
      KeyboardLayout: 'layout-2',
      KEYBOARD_LAYOUT: 'layout-3',
      keyboard_layout: 'layout-4',
      tokenizer_config: 'tokenizer-2',
      TOKENIZER_CONFIG: 'tokenizer-3',
      MonkeyPatch: 'monkey-2',
      monkey_patch: 'monkey-3',
      HotkeyMap: 'hotkey-2',
      HOTKEY_MAP: 'hotkey-3',
      hotkey_map: 'hotkey-4',
    };
    const rich = { ...project, pluginData: { 'com.example': preserved } } as Project;
    const json = JSON.stringify(buildProjectPackage(rich, { includePrivate: true }));
    for (const value of Object.values(preserved)) {
      expect(json, `普通设置值 ${value} 必须保留`).toContain(value);
    }
  });

  it('导出导入往返回归（第九轮 #4）：benign 组合词随包往返保留，敏感族不进入包', async () => {
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
    const pkg = buildProjectPackage(rich, { includePrivate: true });
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
