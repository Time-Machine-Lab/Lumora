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
  test.setTimeout(120_000);
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

  await captureScenario(browser, { width: 1440, height: 900 }, false, '11-portal-host-isolation-1440x900.png', async (page) => {
    await clickToolbarItem(page, 'open-plugin-manager');
    const dialog = page.getByRole('dialog', { name: '插件管理' });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="studio-mount-toggle"]')!.focus());
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  });
  await captureScenario(browser, { width: 1440, height: 900 }, false, '12-shadow-root-focus-restore-1440x900.png', async (page) => {
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'evidence-shadow-host';
      Object.assign(host.style, {
        position: 'fixed',
        left: '16px',
        bottom: '16px',
        zIndex: '100',
      });
      const shadow = host.attachShadow({ mode: 'open' });
      const button = document.createElement('button');
      button.id = 'evidence-shadow-opener';
      button.textContent = 'ShadowRoot opener';
      button.style.cssText = 'padding:8px 12px;border:2px solid #4dabf7;background:#232834;color:#fff';
      shadow.append(button);
      document.body.append(host);
      button.focus();
      document.querySelector<HTMLButtonElement>('[data-testid="open-command-palette"]')!.click();
    });
    await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() =>
      document.querySelector<HTMLElement>('#evidence-shadow-host')?.shadowRoot?.activeElement?.id,
    )).toBe('evidence-shadow-opener');
  });
  await captureScenario(browser, { width: 1240, height: 768 }, true, '13-responsive-boundary-1240x768.png');
  await captureScenario(browser, { width: 1241, height: 768 }, true, '13-responsive-boundary-1241x768.png');
  await captureScenario(browser, { width: 1440, height: 768 }, true, '13-responsive-boundary-1440x768.png');
  await captureScenario(browser, { width: 1441, height: 768 }, true, '13-responsive-boundary-1441x768.png');
  await captureScenario(browser, { width: 667, height: 375 }, true, '14-mobile-landscape-log-open-667x375.png', async (page) => {
    await page.getByTestId('host-log-toggle').click();
    await expect(page.getByTestId('host-event-log')).toBeVisible();
  });
  await captureScenario(browser, { width: 375, height: 667 }, false, '15-mobile-fit-shot-controls-375x667.png', async (page) => {
    await page.getByTestId('open-storyboard-workspace').click();
    await page.getByTestId('storyboard-tab-adopted').click();
    const shortestValidShot = page.getByTestId('storyboard-adopted-shot').first();
    await shortestValidShot.locator('input[type="number"]').fill('0.1');
    await shortestValidShot.locator('input[type="number"]').press('Tab');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('storyboard-workspace')).toBeHidden();
    await page.getByRole('button', { name: '适配' }).click();
    await page.getByTestId('timeline-body').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  });
  await captureScenario(browser, { width: 375, height: 667 }, false, '16-mobile-keyframe-overlap-375x667.png', async (page) => {
    await page.getByRole('button', { name: '适配' }).click();
    await page.locator('.lumora-timeline__keyframe').first().focus();
  });
  await captureScenario(browser, { width: 375, height: 667 }, false, '17-mobile-storyboard-controls-375x667.png', async (page) => {
    await page.getByTestId('open-storyboard-workspace').click();
    await page.getByTestId('storyboard-tab-adopted').click();
  });
  await captureScenario(browser, { width: 1440, height: 900 }, false, '18-plugin-transition-focus-1440x900.png', async (page) => {
    await clickToolbarItem(page, 'open-plugin-manager');
    const toggle = page.getByTestId('plugin-toggle-com.lumora.mock');
    await toggle.click();
    await expect(page.getByTestId('plugin-state-com.lumora.mock')).toHaveText('已禁用');
    await expect(toggle).toBeFocused();
  });

  const dualContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dualPage = await dualContext.newPage();
  try {
    await dualPage.goto('/?fixture=dual-studio');
    const openers = dualPage.getByTestId('open-plugin-manager');
    await expect(openers).toHaveCount(2);
    await openers.first().click();
    await openers.nth(1).evaluate((button) => button.click());
    await expect(dualPage.getByRole('dialog', { name: '插件管理' })).toHaveCount(2);
    await dualPage.keyboard.press('Escape');
    await expect(dualPage.getByRole('dialog', { name: '插件管理' })).toHaveCount(1);
    await capture(dualPage, '19-multiple-modal-stack-1440x900.png');
  } finally {
    await dualContext.close();
  }
});
