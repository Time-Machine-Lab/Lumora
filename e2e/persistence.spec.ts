import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * TML-53 AC1 浏览器级回归：导出 → 清空本地数据 → 导入，支持的数据与引用完整恢复。
 *
 * 用宿主自身的「卸载 Studio」先释放 IndexedDB 连接（deleteDatabase 在连接存在时
 * 会一直 pending 并阻塞后续 open），再删除数据库，等价于「清空浏览器本地数据」；
 * 重新挂载后从空存储导入工程包，校验 3 台摄像机、模型与层级引用全部恢复，
 * 且项目已持久化（刷新后仍可从最近项目重新打开）。
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
