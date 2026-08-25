import { expect, test } from '@playwright/test';
import { MINIMAL_GLB } from './helpers/glb';

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

test('卸载前失败屏障：冲突未解决时 close() 拒绝且保持挂载，解决后可真正卸载（第三十一轮一般 4）', async ({
  context,
}) => {
  // 同一 context 的两个页面共享 IndexedDB：模拟另一标签页已保存较新内容
  const pageA = await context.newPage();
  await pageA.goto('/');
  await pageA.getByTestId('open-sample-project').click();
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  await pageA.getByTestId('add-object').click();
  await pageA.getByTestId('add-摄像机').click();
  await expect(pageA.locator('.lumora-tree-row__type--camera')).toHaveCount(3);
  await expect(pageA.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });

  // B 打开同 uri 示例项目：对账冲突锁存，保存失败
  const pageB = await context.newPage();
  await pageB.goto('/');
  await pageB.getByTestId('open-sample-project').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText(/保存失败/, { timeout: 6000 });

  // 卸载屏障被拒绝：close() 返回 {ok:false}，Studio 保持挂载（未落盘内容仍可恢复），
  // 占位符不出现，事件日志记录拒绝原因 —— 绝不「假装已卸载」丢弃内容
  await pageB.getByTestId('studio-mount-toggle').click();
  await expect(pageB.getByTestId('lumora-studio')).toBeVisible();
  await expect(pageB.getByTestId('studio-placeholder')).not.toBeVisible();
  await expect(pageB.getByTestId('event-log')).toContainText('卸载被拒绝');

  // 显式解决冲突（加载较新版本）后重试卸载：屏障放行，真正卸载并释放
  await pageB.getByTestId('save-reload').click();
  await expect(pageB.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  await pageB.getByTestId('studio-mount-toggle').click();
  await expect(pageB.getByTestId('lumora-studio')).not.toBeVisible();
  await expect(pageB.getByTestId('studio-placeholder')).toBeVisible();
  await expect(pageB.getByTestId('event-log')).toContainText('运行时已释放');
});

test('导入模型后立即卸载：dispose 清理已加载内容，重新挂载后一切可用（P4）', async ({ page }) => {
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-group')).toBeVisible();
  await page.getByTestId('toolbar-model-file-input').setInputFiles({
    name: 'dispose-me.glb',
    mimeType: 'model/gltf-binary',
    buffer: MINIMAL_GLB,
  });
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');

  // 内容已加载后立即卸载运行时：dispose 原子清理，无报错、无残留
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('lumora-studio')).not.toBeVisible();
  await expect(page.getByTestId('studio-placeholder')).toBeVisible();
  await expect(page.getByTestId('event-log')).toContainText('运行时已释放');

  // 重新挂载：再次打开项目一切可用
  await page.getByTestId('studio-mount-toggle').click();
  await expect(page.getByTestId('lumora-studio')).toBeVisible();
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-group')).toBeVisible();
  await page.getByTestId('toolbar-model-file-input').setInputFiles({
    name: 'dispose-me.glb',
    mimeType: 'model/gltf-binary',
    buffer: MINIMAL_GLB,
  });
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
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
