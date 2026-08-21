import { expect, test } from '@playwright/test';

/**
 * R8-1 浏览器回归（TML-57 第八轮复审，修复前必须失败）：
 * 选中树行后关闭项目 —— 旧实现 ObjectTree effect 读 TDZ 中 flatRows，
 * ReferenceError 使整个 Studio 卸载，空态提示永不出现。
 */

test('R8 选中树行后关闭项目：Studio 不崩溃，空态提示可见，可重新打开', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await page.getByTestId('tree-row-sample-cube').click();

  await page.getByTestId('close-project').click();
  // RED：崩溃使 Studio 卸载，空态提示不出现
  await expect(page.getByTestId('studio-empty-hint')).toBeVisible();
  await expect(page.getByTestId('open-sample-project')).toBeVisible();

  // 重新打开项目：树恢复渲染，编辑器可用
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
});
