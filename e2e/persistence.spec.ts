import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  PackageBuildError,
  SceneEditor,
  buildProjectPackage,
  compositeContentHash,
  createCameraObject,
  createSampleProject,
  genId,
  hashBytes,
  serializeProjectPackage,
} from '@lumora/core';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * TML-53 AC1 浏览器级回归：导出 → 清空本地数据 → 导入，支持的数据与引用完整恢复。
 *
 * 用宿主自身的「卸载 Studio」先释放 IndexedDB 连接（deleteDatabase 在连接存在时
 * 会一直 pending 并阻塞后续 open），再删除数据库，等价于「清空浏览器本地数据」；
 * 重新挂载后从空存储导入工程包，校验 3 台摄像机、模型与层级引用全部恢复，
 * 且项目已持久化（刷新后仍可从最近项目重新打开）。
 *
 * AC4 隐私剥离（NFR-008）：向 e2e 源项目注入插件私有设置（pluginData，含嵌套
 * 凭据），在真实浏览器链路验证默认导出与 includePrivate 导出均不携带任何凭据。
 */

interface LumoraPackage {
  manifest: {
    format: string;
    formatVersion: number;
    project: { uri: string; name: string; revision: number };
    includePrivate: boolean;
    assetCount: number;
  };
  assets?: Record<string, { payload?: string }>;
  project: {
    objects: Array<{ type: string; id: string }>;
    pluginData?: unknown;
    tracks?: Array<{ id: string; name: string; objectId: string; targetPath: string; keyframes: unknown[] }>;
  };
}

test('AC1 导出→清空→导入：模型、三镜头完整恢复且已持久化', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();

  // 1. 打开示例项目并追加两台摄像机（共 3 台镜头；模型 = 立方体/球体/圆锥）
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('add-object').click();
    await page.getByTestId('add-摄像机').click();
  }
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
  await expect(page.locator('.lumora-tree-row__type--primitive')).toHaveCount(4);

  // 2. 导出工程包，捕获下载并校验包内容（含三镜头；默认不含私有数据，NFR-008）
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('示例项目.lumora');
  const tmpDir = join(HERE, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const exportPath = join(tmpDir, 'tml53-export.lumora');
  await download.saveAs(exportPath);

  const pkg = JSON.parse(readFileSync(exportPath, 'utf8')) as LumoraPackage;
  expect(pkg.manifest.format).toBe('lumora.project');
  expect(pkg.manifest.includePrivate).toBe(false);
  expect(pkg.project.objects.filter((o) => o.type === 'camera')).toHaveLength(3);
  expect(pkg.project.pluginData).toBeUndefined();
  // 轨道（TML-88）：示例项目轨道随包导出，objectId 引用指向包内对象
  expect(pkg.project.tracks!.length).toBeGreaterThan(0);
  for (const track of pkg.project.tracks!) {
    expect(pkg.project.objects.some((o) => o.id === track.objectId)).toBe(true);
  }

  // 3. 清空本地数据：卸载 Studio（释放连接）→ 删除 IndexedDB → 重新挂载
  await page.getByTestId('project-menu').click(); // 收起菜单
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('studio-placeholder')).toBeVisible();
  await page.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const dbs = await indexedDB.databases();
      if (dbs.length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('lumora-studio');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('open-sample-project')).toBeVisible();
  await page.getByTestId('project-menu').click();
  await expect(page.getByText('暂无本地项目')).toBeVisible();

  // 4. 导入工程包：数据与引用完整恢复
  await page.setInputFiles('[data-testid="project-import-input"]', exportPath);
  await expect(page.getByTestId('studio-empty-hint')).not.toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
  await expect(page.locator('.lumora-tree-row__type--primitive')).toHaveCount(4);
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('项目已打开: 示例项目');
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存');

  // 4b. 轨道与引用完整恢复（TML-88）：清空数据导入后再导出，轨道数据逐项一致，
  // 且每条轨道的 objectId 仍指向包内对象（引用未断裂）
  const reexportPromise = page.waitForEvent('download');
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-export').click();
  const reexport = await reexportPromise;
  const reexportPath = join(tmpDir, 'tml53-import-reexport.lumora');
  await reexport.saveAs(reexportPath);
  const reexported = JSON.parse(readFileSync(reexportPath, 'utf8')) as LumoraPackage;
  expect(reexported.project.tracks).toEqual(pkg.project.tracks);
  for (const track of reexported.project.tracks!) {
    expect(reexported.project.objects.some((o) => o.id === track.objectId)).toBe(true);
  }

  // 5. 已持久化：刷新后可从最近项目重新打开
  await page.reload();
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('recent-project')).toContainText('示例项目');
  await page.locator('[data-testid="recent-project"] .lumora-project-menu__recent-open').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
});

test('AC1b 真实 GLB 模型资产：导入渲染 + 载荷引用往返（TML-53 第四轮 #9）', async ({ page }) => {
  // 1. Node 端构建含真实小型 GLB 网格（nested-mesh.glb，17KB 真模型）、三镜头与轨道的工程包
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  // 追加两台摄像机（共 3 台镜头，与 AC1 一致：镜头都在活动场景，浏览器树可见）
  editor.addObject(createCameraObject('机位二'));
  editor.addObject(createCameraObject('机位三'));
  const glbBytes = readFileSync(join(HERE, '..', 'packages', 'studio', 'test', 'fixtures', 'nested-mesh.glb'));
  const payload = glbBytes.toString('base64');
  const assetId = 'real-model-asset';
  editor.registerAsset({
    id: assetId,
    kind: 'gltf',
    name: '真实模型.glb',
    format: 'glb',
    mime: 'model/gltf-binary',
    hash: await hashBytes(glbBytes),
    size: glbBytes.length,
    source: 'file',
    storageRef: 'blob:runtime-only',
    payload,
    createdAt: new Date().toISOString(),
  });
  const modelId = 'real-model-obj';
  editor.addObject({
    id: modelId,
    type: 'model',
    name: '真实模型',
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetId,
  });
  const project = editor.getProject()!;
  const tracks = [
    {
      id: genId('track'),
      name: '模型位移动画',
      objectId: modelId,
      targetPath: 'position' as const,
      keyframes: [
        { time: 0, value: [0, 0, 0] as [number, number, number] },
        { time: 2, value: [0, 2, 0] as [number, number, number] },
      ],
    },
  ];
  const tmpDir = join(HERE, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const glbPath = join(tmpDir, 'tml53-ac1b-source.lumora');
  writeFileSync(
    glbPath,
    serializeProjectPackage(buildProjectPackage({ ...project, tracks: [...project.tracks, ...tracks] })),
    'utf8',
  );

  // 2. 浏览器导入：真实 GLB 模型行可见、三镜头齐全、项目已持久化
  await page.goto('/');
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();
  await page.getByTestId('project-menu').click();
  await page.setInputFiles('[data-testid="project-import-input"]', glbPath);
  await expect(page.getByTestId('studio-empty-hint')).not.toBeVisible();
  await expect(page.getByTestId('tree-row-real-model-obj')).toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
  await expect(page.getByTestId('event-log')).toContainText('项目已打开');
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 10_000 });

  // 3. 再导出：GLB 载荷逐字节往返、tracks 完整、模型与三镜头引用未断裂
  const reexportPromise = page.waitForEvent('download');
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-export').click();
  const reexport = await reexportPromise;
  const reexportPath = join(tmpDir, 'tml53-ac1b-reexport.lumora');
  await reexport.saveAs(reexportPath);
  const reexported = JSON.parse(readFileSync(reexportPath, 'utf8')) as LumoraPackage;
  expect(reexported.manifest.assetCount).toBeGreaterThanOrEqual(1);
  expect(reexported.assets?.[assetId]?.payload).toBe(payload);
  expect(reexported.project.objects.filter((o) => o.type === 'camera')).toHaveLength(3);
  expect(reexported.project.objects.some((o) => o.type === 'model' && o.id === modelId)).toBe(true);
  expect(reexported.project.tracks).toEqual([...project.tracks, ...tracks]);
  for (const track of reexported.project.tracks!) {
    expect(reexported.project.objects.some((o) => o.id === track.objectId)).toBe(true);
  }
});

test('AC4 源项目含 pluginData 与凭据：默认导出结构性隔离，includePrivate 显式公开契约制（第十二轮阻断 2 + 第十三轮反转 + 第十四轮阻断 1/2 + 第十五轮阻断 1）', async ({ page }) => {
  // 1. Node 端构造「含 AI 凭据与插件私有设置」的源工程包。显式公开契约制
  //    （第十四轮阻断 1/2）：publicKeysByPlugin 是「显式可导出字段声明」，
  //    第十五轮阻断 1 加固后声明只放行叶值（null/字符串/数字/布尔），整对象
  //    声明一律剥离、凭据形态键名（apikey/password/token/secret/…）一律拒绝
  //    —— 嵌套凭据结构没有任何声明通道。因此源包在 Node 侧直接注入完整
  //    pluginData（含嵌套凭据），模拟插件把私有设置（含凭据）写入项目本地
  //    状态的真实形态：本地存储完整、导出剥离由浏览器链路验证；空/漏声明 =
  //    无公开字段 = 整段排除（已注册但空/漏声明绝不整段放行，凭据无从经
  //    声明缺口进入包）
  const pluginId = 'com.example.ai-assistant';
  const secrets = {
    apiKey: 'sk-lumora-ac4-1f7a9c3d',
    accessToken: 'tok-lumora-ac4-9c2b4d6e',
    authorization: 'Bearer lumora-ac4-3d8e5f7a',
    password: 'pwd-lumora-ac4-5a1b6c8d',
    providerKey: 'key-lumora-ac4-7f4d8e2b',
  };
  const sourcePluginData: Record<string, unknown> = {
    [pluginId]: {
      theme: 'dark',
      model: 'claude-sonnet-5',
      auth: { apiKey: secrets.apiKey, accessToken: secrets.accessToken },
      api: { authorization: secrets.authorization },
      users: [{ name: 'u1' }, { name: 'u2', password: secrets.password }],
      credentials: { provider: secrets.providerKey },
    },
  };
  const tmpDir = join(HERE, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const sourcePath = join(tmpDir, 'tml53-ac4-source.lumora');
  const sourceEditor = new SceneEditor();
  sourceEditor.openProject(createSampleProject());
  const sourcePkg = buildProjectPackage(
    {
      ...sourceEditor.getProject()!,
      uri: 'lumora://project/ac4-source',
      name: 'AC4 源项目',
    },
    { includePrivate: true },
  );
  sourcePkg.project.pluginData = sourcePluginData;
  writeFileSync(sourcePath, serializeProjectPackage(sourcePkg), 'utf8');

  // 1b. 已注册但空/漏声明（第十三轮阻断 2 反转）：同一源数据以空声明或
  //     缺失映射构建 → pluginData 整段排除，凭据形态值绝不进包
  const sourceBase = {
    ...sourceEditor.getProject()!,
    pluginData: sourcePluginData,
  } as Parameters<typeof buildProjectPackage>[0];
  const emptyDecl = buildProjectPackage(
    { ...sourceBase, uri: 'lumora://project/ac4-empty', name: 'AC4 空声明' },
    { includePrivate: true, publicKeysByPlugin: { [pluginId]: [] } },
  ) as { project: Record<string, unknown> };
  expect(emptyDecl.project.pluginData).toBeUndefined();
  const noDecl = buildProjectPackage(
    { ...sourceBase, uri: 'lumora://project/ac4-nodecl', name: 'AC4 漏声明' },
    { includePrivate: true },
  ) as { project: Record<string, unknown> };
  expect(noDecl.project.pluginData).toBeUndefined();
  for (const secret of Object.values(secrets)) {
    expect(JSON.stringify(emptyDecl)).not.toContain(secret);
    expect(JSON.stringify(noDecl)).not.toContain(secret);
  }

  // 1c. 已注册插件仅声明公开键（theme/model）：直接及嵌套凭据一律排除
  //     （第十四轮阻断 1 核心回归）—— 声明只放行显式列出的字段，auth/api/
  //     users/credentials 整段与其中凭据绝无声明缺口可循
  const declaredOnly = buildProjectPackage(
    { ...sourceBase, uri: 'lumora://project/ac4-declared', name: 'AC4 仅声明公开键' },
    { includePrivate: true, publicKeysByPlugin: { [pluginId]: ['theme', 'model'] } },
  );
  const declaredJson = JSON.stringify(declaredOnly);
  expect(declaredJson).toContain('"theme":"dark"');
  expect(declaredJson).toContain('"model":"claude-sonnet-5"');
  for (const secret of Object.values(secrets)) expect(declaredJson).not.toContain(secret);
  for (const key of ['auth', 'credentials', 'users', 'api']) {
    expect(declaredJson).not.toContain(`"${key}"`);
  }

  // 1d. 整对象声明剥离 + 凭据形态键名声明命中（第十五轮阻断 1 + 第二十五轮
  //     指令 3 + 第二十六轮回归）：声明 ['users']（整对象/数组）被叶值校验剥离
  //     —— 显式登记也无法携带嵌套值；声明 ['apiKey','clientSecret','apikeyv2',
  //     'tokenv2']（凭据形态键名，含无边界复合 + 字母数字版本后缀）命中 →
  //     构建校验失败（不再静默丢弃），凭据绝无声明通道，即使插件显式点名导出
  const credentialShape: Record<string, unknown> = {
    [pluginId]: {
      theme: 'dark',
      apiKey: secrets.apiKey,
      clientSecret: secrets.accessToken,
      apikeyv2: secrets.apiKey,
      tokenv2: secrets.accessToken,
      users: [{ name: 'u1' }, { name: 'u2', password: secrets.password }],
    },
  };
  const wholeObjectDecl = buildProjectPackage(
    { ...sourceBase, uri: 'lumora://project/ac4-whole', name: 'AC4 整对象声明', pluginData: credentialShape },
    { includePrivate: true, publicKeysByPlugin: { [pluginId]: ['users', 'theme'] } },
  );
  const wholeJson = JSON.stringify(wholeObjectDecl);
  expect(wholeJson).toContain('"theme":"dark"');
  expect(wholeJson).not.toContain('"users"');
  for (const secret of Object.values(secrets)) expect(wholeJson).not.toContain(secret);
  let credentialError: unknown = null;
  try {
    buildProjectPackage(
      { ...sourceBase, uri: 'lumora://project/ac4-cred', name: 'AC4 凭据形态键声明', pluginData: credentialShape },
      { includePrivate: true, publicKeysByPlugin: { [pluginId]: ['apiKey', 'clientSecret', 'apikeyv2', 'tokenv2', 'theme'] } },
    );
  } catch (caught) {
    credentialError = caught;
  }
  expect(credentialError).toBeInstanceOf(PackageBuildError);
  const credentialBuildError = credentialError as PackageBuildError;
  expect(credentialBuildError.code).toBe('credential-declaration-rejected');
  expect(credentialBuildError.declarations).toHaveLength(4);
  expect(credentialBuildError.declarations).toContainEqual({ plugin: pluginId, path: '"apiKey"' });
  expect(credentialBuildError.declarations).toContainEqual({ plugin: pluginId, path: '"clientSecret"' });
  expect(credentialBuildError.declarations).toContainEqual({ plugin: pluginId, path: '"apikeyv2"' });
  expect(credentialBuildError.declarations).toContainEqual({ plugin: pluginId, path: '"tokenv2"' });
  expect(credentialBuildError.message).toContain('凭据永不导出');

  // 2. 浏览器导入源项目：插件私有设置（含嵌套凭据）成为编辑器与本地持久化状态
  await page.goto('/');
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();
  await page.getByTestId('project-menu').click();
  await page.setInputFiles('[data-testid="project-import-input"]', sourcePath);
  await expect(page.getByTestId('studio-empty-hint')).not.toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('项目已打开: AC4 源项目');
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 10_000 });

  // 3. 源项目在浏览器本地存储中真实携带凭据（默认导出断言的前提，避免空转）
  const storedPlugin = await page.evaluate(
    ({ uri, id }: { uri: string; id: string }) =>
      new Promise<{ theme?: string; auth?: Record<string, string> } | undefined>((resolve) => {
        const openReq = indexedDB.open('lumora-studio');
        openReq.onerror = () => resolve(undefined);
        openReq.onsuccess = () => {
          const db = openReq.result;
          const tx = db.transaction('projects', 'readonly');
          const getReq = tx.objectStore('projects').get(uri);
          getReq.onerror = () => {
            db.close();
            resolve(undefined);
          };
          getReq.onsuccess = () => {
            const record = getReq.result as
              | {
                  project?: { pluginData?: Record<string, { theme?: string; auth?: Record<string, string> }> };
                }
              | undefined;
            db.close();
            resolve(record?.project?.pluginData?.[id]);
          };
        };
      }),
    { uri: 'lumora://project/ac4-source', id: pluginId },
  );
  expect(storedPlugin?.theme).toBe('dark');
  expect(storedPlugin?.auth).toEqual({ apiKey: secrets.apiKey, accessToken: secrets.accessToken });

  // 4. 默认导出：工程包内无插件私有设置、无任何凭据（结构性隔离 —— pluginData
  //    整体不进包，凭据随其隔离）
  await page.getByTestId('project-menu').click();
  const downloadDefault = page.waitForEvent('download');
  await page.getByTestId('project-export').click();
  const defaultDownload = await downloadDefault;
  const defaultPath = join(tmpDir, 'tml53-ac4-export.lumora');
  await defaultDownload.saveAs(defaultPath);
  const defaultText = readFileSync(defaultPath, 'utf8');
  const defaultPkg = JSON.parse(defaultText) as LumoraPackage;
  expect(defaultPkg.manifest.includePrivate).toBe(false);
  expect(defaultPkg.project.pluginData).toBeUndefined();
  for (const secret of Object.values(secrets)) expect(defaultText).not.toContain(secret);
  expect(defaultText).not.toContain('pluginData');
  for (const key of ['apiKey', 'accessToken', 'authorization', 'password', 'credentials']) {
    expect(defaultText).not.toContain(key);
  }

  // 5. includePrivate 显式开启：浏览器未注册任何插件 —— includePrivate 无插件
  //    声明映射时命名空间 fail-closed 排除（第十二轮阻断 2）：pluginData 不进包、
  //    凭据不出现，与 UI「凭据永不导出」一致 —— 没有 manifest 声明的来源数据
  //    没有进入包的依据，隔离绝不 fail-open
  await page.getByTestId('project-export-include-private').check();
  await expect(page.getByTestId('project-export-include-private')).toBeChecked();
  const downloadPrivate = page.waitForEvent('download');
  await page.getByTestId('project-export').click();
  const privateDownload = await downloadPrivate;
  const privatePath = join(tmpDir, 'tml53-ac4-export-private.lumora');
  await privateDownload.saveAs(privatePath);
  const privateText = readFileSync(privatePath, 'utf8');
  const privatePkg = JSON.parse(privateText) as LumoraPackage;
  expect(privatePkg.manifest.includePrivate).toBe(true);
  // 未知命名空间（未注册插件）被整体排除：pluginData 不存在、凭据不出现
  expect(privatePkg.project.pluginData).toBeUndefined();
  expect(privateText).not.toContain('pluginData');
  for (const secret of Object.values(secrets)) expect(privateText).not.toContain(secret);
  for (const key of ['apiKey', 'accessToken', 'authorization', 'password', 'credentials']) {
    expect(privateText).not.toContain(key);
  }
});

test('AC2 跨标签页冲突：本地计数追平不覆盖较新保存，须显式「加载较新版本」解决', async ({ context }) => {
  // 同一 context 的两个页面共享 IndexedDB：模拟两个标签页编辑同一项目
  const pageA = await context.newPage();
  await pageA.goto('/');
  await pageA.getByTestId('open-sample-project').click();
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // A 新增一台摄像机并等待落盘（rev1）
  await pageA.getByTestId('add-object').click();
  await pageA.getByTestId('add-摄像机').click();
  await expect(pageA.locator('.lumora-tree-row__type--camera')).toHaveCount(2);
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // B 打开同 uri 示例项目：对账发现本地已存 rev1 ≠ 打开 rev0 → 立即冲突，不预设已保存
  const pageB = await context.newPage();
  await pageB.goto('/');
  await pageB.getByTestId('open-sample-project').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText(/保存失败/, { timeout: 6000 });

  // B 继续编辑使本地计数追平（rev1）：仍冲突，绝不覆盖 A 的较新内容
  await pageB.getByTestId('add-object').click();
  await pageB.getByTestId('add-摄像机').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText(/保存失败/, { timeout: 6000 });
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存');
  await expect(pageA.locator('.lumora-tree-row__type--camera')).toHaveCount(2);

  // B 显式解决「加载较新版本」：内容切换为 A 的已存内容，冲突解除
  await pageB.getByTestId('save-reload').click();
  await expect(pageB.locator('.lumora-tree-row__type--camera')).toHaveCount(2);
  await expect(pageB.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // 解决后 B 可正常保存（基于已存内容追加，rev2）
  await pageB.getByTestId('add-object').click();
  await pageB.getByTestId('add-摄像机').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  await expect(pageB.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
});

test('窄屏（375px）：菜单与对话框不超出视口，Escape 关闭且不误清背景选择', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  // 打开示例项目并选中一个树行：对话框/下拉的 Escape 不得冒泡到全局键处理误清选择
  await page.getByTestId('open-sample-project').click();
  const treeRow = page.getByTestId('tree-row-sample-cube');
  await expect(treeRow).toBeVisible();
  await treeRow.click();
  await expect(treeRow).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('project-menu').click();
  const dropdown = page.getByTestId('project-menu-dropdown');
  await expect(dropdown).toBeVisible();
  const box = (await dropdown.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);

  // 新建项目对话框：以真实对话框盒（.lumora-project-dialog__box）断言不超出视口，
  // 而非外层遮罩（此前用 data-testid=project-dialog 断言的是遮罩 div）
  await page.getByTestId('project-new').click();
  const dialogBox = page.locator('.lumora-project-dialog__box');
  await expect(dialogBox).toBeVisible();
  const dbox = (await dialogBox.boundingBox())!;
  expect(dbox.x).toBeGreaterThanOrEqual(0);
  expect(dbox.x + dbox.width).toBeLessThanOrEqual(375);

  // 对话框内 Escape：自行消化关闭对话框（stopPropagation），焦点回到打开前元素，
  // 背景树选择保持（未被全局 Escape 清除）
  await page.keyboard.press('Escape');
  await expect(dialogBox).not.toBeVisible();
  await expect(page.getByTestId('project-new')).toBeFocused();
  await expect(treeRow).toHaveAttribute('aria-selected', 'true');

  // 下拉内 Escape：关闭下拉，焦点回到「项目」按钮，选择仍保持
  await page.keyboard.press('Escape');
  await expect(dropdown).not.toBeVisible();
  await expect(page.getByTestId('project-menu')).toBeFocused();
  await expect(treeRow).toHaveAttribute('aria-selected', 'true');

  // 全程无水平溢出
  const noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(noHorizontalOverflow).toBe(true);
});

test('Escape 关闭菜单：焦点在 trigger（点击后未移入面板）时同样生效（TML-53 第三轮 #11）', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('project-menu-dropdown')).toBeVisible();
  // 刚点击「项目」：焦点仍在 trigger 上，keydown 事件不经过 dropdown，由菜单根容器接住
  await expect(page.getByTestId('project-menu')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-menu-dropdown')).not.toBeVisible();
  await expect(page.getByTestId('project-menu')).toBeFocused();
});

test('删除项目后焦点回到常驻「项目」按钮，不落 BODY（TML-53 第三轮 #12）', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-new').click();
  await page.getByTestId('project-name-input').fill('待删除项目');
  await page.getByTestId('project-name-confirm').click();
  // 新建后面板已收起：重新展开菜单，等首次落盘（autosaver 防抖 2 秒）后最近行出现
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('recent-project').first()).toContainText('待删除项目', {
    timeout: 10_000,
  });
  await page.getByTestId('recent-delete').click();
  await page.getByTestId('confirm-delete').click();
  await expect(page.getByTestId('recent-project')).toHaveCount(0);
  // 被删行的删除按钮已随列表移除：焦点必须回到常驻「项目」按钮，不得落 BODY
  await expect(page.getByTestId('project-menu')).toBeFocused();
});

test('parts-only 被引用模型：导入拒绝（缺主载荷），parse→cache→viewport 链路未进入（TML-53 第三轮 #6）', async ({
  page,
}) => {
  // Node 端构建含 glTF 主载荷 + 外部分件的真实工程包，再剥离主载荷 → parts-only 载荷
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  const mainBytes = new TextEncoder().encode('glb-main-content-bytes');
  const partBytes = new TextEncoder().encode('external-part-content-bytes');
  const assetId = genId('asset');
  const partPath = 'ext/part.bin';
  const part: { path: string; mime: string; payload: string; partHash: string } = {
    path: partPath,
    mime: 'application/octet-stream',
    payload: btoa(String.fromCharCode(...partBytes)),
    partHash: await hashBytes(partBytes),
  };
  const hash = await compositeContentHash(await hashBytes(mainBytes), [
    { path: partPath, partHash: part.partHash },
  ]);
  editor.registerAsset({
    id: assetId,
    kind: 'gltf',
    name: '分包模型.glb',
    format: 'glb',
    mime: 'model/gltf-binary',
    hash,
    size: mainBytes.length + partBytes.length,
    source: 'file',
    storageRef: 'blob:runtime-only',
    payload: btoa(String.fromCharCode(...mainBytes)),
    parts: [part],
    createdAt: new Date().toISOString(),
  });
  editor.addObject({
    id: genId('obj'),
    type: 'model',
    name: '分包模型',
    parentId: null,
    transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetId,
  });
  const raw = JSON.parse(serializeProjectPackage(buildProjectPackage(editor.getProject()!))) as {
    assets: Record<string, { payload?: string }>;
  };
  delete raw.assets[assetId]!.payload; // 主载荷缺失，仅剩外部分件
  const tmpDir = join(HERE, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const partsOnlyPath = join(tmpDir, 'tml53-parts-only.lumora');
  writeFileSync(partsOnlyPath, JSON.stringify(raw), 'utf8');

  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  const logBefore = await page.getByTestId('event-log').innerText();

  await page.getByTestId('project-menu').click();
  await page.setInputFiles('[data-testid="project-import-input"]', partsOnlyPath);
  // 解析端拒绝：明确提示缺主载荷（被引用模型不得判为导入成功）
  await expect(page.getByTestId('lumora-toasts')).toContainText(/导入失败.*主载荷/);
  // 失败回滚（AC3）：当前项目原样打开，缓存/视口链路未被触碰（无新的项目打开事件）
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.getByTestId('studio-empty-hint')).not.toBeVisible();
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存');
  expect(await page.getByTestId('event-log').innerText()).toBe(logBefore);
});
