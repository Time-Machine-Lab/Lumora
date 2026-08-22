import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  SceneEditor,
  buildProjectPackage,
  compositeContentHash,
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
  };
  project: { objects: Array<{ type: string }>; pluginData?: unknown };
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

  // 5. 已持久化：刷新后可从最近项目重新打开
  await page.reload();
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('recent-project')).toContainText('示例项目');
  await page.locator('[data-testid="recent-project"] .lumora-project-menu__recent-open').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
});

test('AC4 源项目含 pluginData 与凭据：默认导出全剥离，includePrivate 仅放行插件设置', async ({ page }) => {
  // 1. Node 端构造「含 AI 凭据与插件私有设置」的源工程包。buildProjectPackage 会剥离
  //    凭据族字段，故先以 includePrivate 构建出正确的包结构，再把嵌套凭据写回包内
  //    project.pluginData —— 模拟插件把私有设置（含凭据）存入项目本地状态的真实形态
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
  const sourceEditor = new SceneEditor();
  sourceEditor.openProject(createSampleProject());
  const pkg = buildProjectPackage(
    {
      ...sourceEditor.getProject()!,
      uri: 'lumora://project/ac4-source',
      name: 'AC4 源项目',
      pluginData: sourcePluginData,
    },
    { includePrivate: true },
  );
  const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: { pluginData?: Record<string, unknown> } };
  raw.project.pluginData = sourcePluginData;
  const tmpDir = join(HERE, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const sourcePath = join(tmpDir, 'tml53-ac4-source.lumora');
  writeFileSync(sourcePath, JSON.stringify(raw), 'utf8');

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

  // 4. 默认导出：工程包内无插件私有设置、无任何凭据（凭据与敏感键名都不出现）
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

  // 5. includePrivate 显式开启：插件私有设置可包含，凭据仍被剥离
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
  const plugin = (privatePkg.project.pluginData as
    | Record<string, Record<string, unknown>>
    | undefined)?.[pluginId];
  expect(plugin?.theme).toBe('dark');
  expect(plugin?.model).toBe('claude-sonnet-5');
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
