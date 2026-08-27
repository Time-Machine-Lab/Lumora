import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openSampleExport(page: Page) {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
}

test('host event log is keyboard reachable, named, visibly focused, and scrollable', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();

  const log = page.getByTestId('host-event-log');
  await expect(log).toHaveAccessibleName('宿主事件日志');
  await expect.poll(() => log.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let reachedLog = false;
  for (let index = 0; index < 160; index += 1) {
    await page.keyboard.press('Shift+Tab');
    reachedLog = await log.evaluate((element) => element === document.activeElement);
    if (reachedLog) break;
  }
  expect(reachedLog).toBe(true);
  const outline = await log.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline).toEqual({ color: 'rgb(77, 171, 247)', style: 'solid', width: '2px' });

  const initialScrollTop = await log.evaluate((element) => element.scrollTop);
  await page.keyboard.press('PageDown');
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScrollTop);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 375, height: 667 },
]) {
  test(`${viewport.width}x${viewport.height} full page has no axe violations or incomplete results`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openSampleExport(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    expect(results.incomplete, JSON.stringify(results.incomplete, null, 2)).toEqual([]);
  });
}
