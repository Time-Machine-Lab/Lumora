import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * TML-53 范围项（OPFS 适配器）：浏览器级验证 OPFS 后端与 IndexedDB 行为一致。
 *
 * 存储后端通过 ?storage=opfs 切换（嵌入式宿主透传），数据落 OPFS（真实 Chromium
 * 实现）：AC1 式「导出 → 清空 OPFS → 导入 → 刷新后最近项目恢复」全链路 + 直接
 * 断言数据位于 OPFS 目录（而非 IndexedDB），以及 AC2 式跨标签页冲突在
 * Web Locks 临界区下同样按 CAS 拒绝并显式解决。
 */

const OPFS_ROOT = 'lumora-studio';

async function clearOpfs(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (rootName) => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(rootName, { recursive: true });
    } catch {
      // 目录不存在（首次运行）：视为已清空
    }
  }, OPFS_ROOT);
}

/** 直接读取 OPFS 中项目文件列表：证明数据真的落 OPFS 而非 IndexedDB */
async function opfsProjectFiles(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async (rootName) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(rootName);
    const projects = await dir.getDirectoryHandle('projects');
    const names: string[] = [];
    for await (const [name] of (projects as unknown as { entries(): AsyncIterableIterator<[string, unknown]> }).entries()) {
      if (!name.startsWith('.')) names.push(name);
    }
    return names;
  }, OPFS_ROOT);
}

test('OPFS 后端 AC1：导出→清空→导入完整恢复，数据落 OPFS 且刷新后可重开', async ({ page }) => {
  await page.goto('/?storage=opfs');
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();

  // 1. 打开示例项目并追加两台摄像机（共 4 台镜头）
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('add-object').click();
    await page.getByTestId('add-摄像机').click();
  }
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(4);
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // 数据已写入 OPFS 目录（真实文件系统校验，而非 IndexedDB）
  expect(await opfsProjectFiles(page)).toHaveLength(1);

  // 2. 导出工程包并校验内容（含四镜头）
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('示例项目.lumora');
  const tmpDir = join(HERE, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const exportPath = join(tmpDir, 'tml90-opfs-export.lumora');
  await download.saveAs(exportPath);
  const pkg = JSON.parse(readFileSync(exportPath, 'utf8')) as {
    project: { objects: Array<{ type: string }> };
  };
  expect(pkg.project.objects.filter((o) => o.type === 'camera')).toHaveLength(4);

  // 3. 清空本地数据：卸载 Studio → 删除 OPFS 根目录 → 重新挂载
  await page.getByTestId('project-menu').click(); // 收起菜单
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('studio-placeholder')).toBeVisible();
  await clearOpfs(page);
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('open-sample-project')).toBeVisible();
  await page.getByTestId('project-menu').click();
  await expect(page.getByText('暂无本地项目')).toBeVisible();

  // 4. 导入工程包：数据与引用完整恢复
  await page.setInputFiles('[data-testid="project-import-input"]', exportPath);
  await expect(page.getByTestId('studio-empty-hint')).not.toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(4);
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  expect(await opfsProjectFiles(page)).toHaveLength(1);

  // 5. 已持久化（OPFS）：刷新后可从最近项目重新打开
  await page.reload();
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('recent-project')).toContainText('示例项目');
  await page.locator('[data-testid="recent-project"] .lumora-project-menu__recent-open').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(4);
});

test('OPFS 后端 AC2：跨标签页冲突按 CAS 拒绝，显式「加载较新版本」解决', async ({ context }) => {
  // 同一 context 的两个页面共享 OPFS 与 Web Locks：模拟两个标签页编辑同一项目
  const pageA = await context.newPage();
  await pageA.goto('/?storage=opfs');
  await pageA.getByTestId('open-sample-project').click();
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // A 新增一台摄像机并等待落盘（rev1）
  await pageA.getByTestId('add-object').click();
  await pageA.getByTestId('add-摄像机').click();
  await expect(pageA.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // B 打开同 uri 示例项目：对账发现本地已存 rev1 ≠ 打开 rev0 → 立即冲突
  const pageB = await context.newPage();
  await pageB.goto('/?storage=opfs');
  await pageB.getByTestId('open-sample-project').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText(/保存失败/, { timeout: 6000 });

  // B 继续编辑使本地计数追平（rev1）：仍冲突，绝不覆盖 A 的较新内容
  await pageB.getByTestId('add-object').click();
  await pageB.getByTestId('add-摄像机').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText(/保存失败/, { timeout: 6000 });
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存');
  await expect(pageA.locator('.lumora-tree-row__type--camera')).toHaveCount(3);

  // B 显式解决「加载较新版本」：内容切换为 A 的已存内容，冲突解除
  await pageB.getByTestId('save-reload').click();
  await expect(pageB.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
  await expect(pageB.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // 解决后 B 可正常保存（基于已存内容追加，rev2）
  await pageB.getByTestId('add-object').click();
  await pageB.getByTestId('add-摄像机').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  await expect(pageB.locator('.lumora-tree-row__type--camera')).toHaveCount(4);
  await expect(pageA.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
});
