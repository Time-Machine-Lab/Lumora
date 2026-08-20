import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('壳层渲染：工具栏、场景视图、Mock 插件面板与工具栏贡献项', async ({ page }) => {
  await expect(page.getByTestId('lumora-studio')).toBeVisible();
  await expect(page.getByTestId('lumora-scene')).toBeVisible();
  await expect(page.getByTestId('panel-tab-com.lumora.mock.panel.console')).toBeVisible();
  await expect(page.getByTestId('toolbar-com.lumora.mock.toolbar.export')).toBeVisible();
});

test('打开示例项目：project:opened 事件进入宿主日志，面板展示项目', async ({ page }) => {
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('studio-empty-hint')).not.toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('项目已打开: 示例项目');
  await expect(page.getByTestId('mock-console-panel')).toContainText('示例项目，3 个对象');
  // 关闭项目发出 project:closed
  await page.getByTestId('close-project').click();
  await expect(page.getByTestId('event-log')).toContainText('项目已关闭');
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();
});

test('命令面板（Ctrl+K）可过滤并执行 Mock 插件命令', async ({ page }) => {
  // 等待插件注册完成：Ctrl+K 监听器在挂载 effect 中安装，需确保按键时已就绪
  await expect(page.getByTestId('panel-tab-com.lumora.mock.panel.console')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('palette-command-com.lumora.mock.exportScene')).toBeVisible();
  await page.getByTestId('palette-command-com.lumora.mock.exportScene').click();
  // 执行命令后面板自动关闭
  await expect(page.getByTestId('command-palette')).not.toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('command:executed');
  // Ctrl+K 再次打开并关闭
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).not.toBeVisible();
});

test('Mock AI 面板经 services.ai 流式对话', async ({ page }) => {
  await page.getByTestId('panel-tab-com.lumora.mock.panel.ai').click();
  await expect(page.getByTestId('mock-ai-input')).toBeVisible();
  await page.getByTestId('mock-ai-input').fill('你好 Lumora');
  await page.getByTestId('mock-ai-send').click();
  await expect(page.getByTestId('mock-ai-output')).toContainText('Mock AI（mock-1）', { timeout: 10_000 });
});

test('非法 Manifest 与引擎不兼容插件进入 failed 并显示原因，入口不被加载', async ({ page }) => {
  await page.getByTestId('open-plugin-manager').click();
  await expect(page.getByTestId('plugin-reason-com.example.brokenmanifest')).toContainText('Manifest 非法');
  await expect(page.getByTestId('plugin-state-com.example.brokenmanifest')).toHaveText('失败');
  await expect(page.getByTestId('plugin-reason-com.example.brokenengine')).toContainText('不满足插件引擎要求');
  await expect(page.getByTestId('plugin-state-com.example.brokenengine')).toHaveText('失败');
  // 合法插件保持运行中
  await expect(page.getByTestId('plugin-state-com.lumora.mock')).toHaveText('运行中');
});
