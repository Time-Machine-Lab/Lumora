import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const OUTPUT_DIR = resolve('docs/evidence/tml-563/after');

async function clickToolbarItem(page: Page, testId: string) {
  const item = page.getByTestId(testId);
  if (!(await item.isVisible())) {
    const more = page.getByTestId('toolbar-more');
    await expect(more).toBeVisible();
    await more.click();
    await expect(item).toBeVisible();
  }
  await item.click();
}

async function prepareEditor(
  page: Page,
  viewport: { width: number; height: number },
  selected: boolean,
) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await clickToolbarItem(page, 'open-sample-project');
  await expect(page.getByTestId('open-export-workspace')).toBeEnabled();

  if (selected) {
    const cube = page.getByTestId('tree-row-sample-cube');
    if (!(await cube.isVisible())) await page.getByTestId('editor-panel-objects').click();
    await cube.click();
    if (!(await page.getByTestId('lumora-viewport').isVisible())) {
      await page.getByTestId('editor-panel-scene').click();
    }
  }

  await expect(page.getByTestId('lumora-viewport')).toBeVisible();
  await page.waitForTimeout(250);
}

async function capture(page: Page, filename: string) {
  await page.screenshot({
    path: resolve(OUTPUT_DIR, filename),
    fullPage: true,
    animations: 'disabled',
  });
}

async function captureScenario(
  browser: Browser,
  viewport: { width: number; height: number },
  selected: boolean,
  filename: string,
  arrange?: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await prepareEditor(page, viewport, selected);
    await arrange?.(page);
    await capture(page, filename);
  } finally {
    await context.close();
  }
}

test('captures the TML-563 before/after review matrix', async ({ browser }) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  await captureScenario(browser, { width: 1440, height: 900 }, true, '01-desktop-editor-1440x900.png');
  await captureScenario(browser, { width: 1024, height: 768 }, true, '01a-desktop-editor-1024x768.png');
  await captureScenario(browser, { width: 1440, height: 900 }, true, '02-desktop-plugin-manager-1440x900.png', async (page) => {
    await clickToolbarItem(page, 'open-plugin-manager');
    await expect(page.getByRole('dialog', { name: '插件管理' })).toBeVisible();
  });
  await captureScenario(browser, { width: 1440, height: 900 }, true, '03-desktop-command-palette-1440x900.png', async (page) => {
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
  });
  await captureScenario(browser, { width: 1440, height: 900 }, true, '04-desktop-storyboard-1440x900.png', async (page) => {
    await page.getByTestId('open-storyboard-workspace').click();
    await expect(page.getByTestId('storyboard-workspace')).toBeVisible();
  });
  await captureScenario(browser, { width: 1440, height: 900 }, true, '05-desktop-export-1440x900.png', async (page) => {
    await page.getByTestId('open-export-workspace').click();
    await expect(page.getByTestId('export-workspace')).toBeVisible();
  });
  await captureScenario(browser, { width: 375, height: 667 }, false, '06a-mobile-editor-before-selection-375x667.png');
  await captureScenario(browser, { width: 375, height: 667 }, true, '06-mobile-editor-375x667.png');
  await captureScenario(browser, { width: 375, height: 667 }, false, '07-mobile-plugin-manager-375x667.png', async (page) => {
    await clickToolbarItem(page, 'open-plugin-manager');
    await expect(page.getByRole('dialog', { name: '插件管理' })).toBeVisible();
  });
  await captureScenario(browser, { width: 375, height: 667 }, false, '08-mobile-storyboard-375x667.png', async (page) => {
    await page.getByTestId('open-storyboard-workspace').click();
    await expect(page.getByTestId('storyboard-workspace')).toBeVisible();
  });
  await captureScenario(browser, { width: 667, height: 375 }, true, '09-mobile-landscape-editor-667x375.png');
  await captureScenario(browser, { width: 667, height: 375 }, true, '10-mobile-landscape-export-667x375.png', async (page) => {
    await page.getByTestId('open-export-workspace').click();
    await expect(page.getByTestId('export-workspace')).toBeVisible();
  });
});
