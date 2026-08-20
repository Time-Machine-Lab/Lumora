import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('禁用插件：面板与工具栏贡献项全部移除，壳层仍可用，可重新启用', async ({ page }) => {
  await page.getByTestId('open-plugin-manager').click();
  await page.getByTestId('plugin-toggle-com.lumora.mock').click();
  await expect(page.getByTestId('plugin-state-com.lumora.mock')).toHaveText('已禁用');
  await expect(page.getByTestId('panel-tab-com.lumora.mock.panel.console')).not.toBeVisible();
  await expect(page.getByTestId('toolbar-com.lumora.mock.toolbar.export')).not.toBeVisible();
  // 关闭插件管理器，验证壳层依然可用（管理器遮罩会挡住页面操作）
  await page.getByTestId('close-plugin-manager').click();
  await expect(page.getByTestId('open-sample-project')).toBeVisible();
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('mock-console-panel')).not.toBeVisible();

  // 重新启用后贡献项恢复
  await page.getByTestId('open-plugin-manager').click();
  await page.getByTestId('plugin-toggle-com.lumora.mock').click();
  await expect(page.getByTestId('plugin-state-com.lumora.mock')).toHaveText('运行中');
  await expect(page.getByTestId('panel-tab-com.lumora.mock.panel.console')).toBeVisible();
  await expect(page.getByTestId('toolbar-com.lumora.mock.toolbar.export')).toBeVisible();
});

test('卸载组件释放运行时，重新挂载后一切恢复可用', async ({ page }) => {
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('event-log')).toContainText('项目已打开');

  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('lumora-studio')).not.toBeVisible();
  await expect(page.getByTestId('studio-placeholder')).toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('运行时已释放');

  // 重新挂载：插件重新激活、事件可再次监听
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('lumora-studio')).toBeVisible();
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('event-log')).toContainText('项目已打开: 示例项目');
});

test('面板渲染抛错由错误边界隔离，壳层不受影响且可经边界禁用插件', async ({ page }) => {
  // 由宿主注入的爆炸面板（com.example.exploding，仅本页存在）
  await page.getByTestId('open-sample-project').click();
  // 打开爆炸插件面板标签（tab 的 testid 用面板 id，而非插件 id）
  await page.getByTestId('panel-tab-com.example.exploding.panel').click();
  await expect(page.getByTestId('panel-error-fallback')).toBeVisible();
  // 壳层仍可用
  await expect(page.getByTestId('open-sample-project')).toBeVisible();
  // 经错误边界禁用插件
  await page.getByTestId('disable-plugin-from-panel').click();
  await expect(page.getByTestId('panel-error-fallback')).not.toBeVisible();
});
