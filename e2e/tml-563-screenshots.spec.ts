import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const OUTPUT_DIR = resolve('docs/evidence/tml-563/round3-after');
const CURRENT_OUTPUT_DIR = resolve('docs/evidence/tml-563/after');

async function clickToolbarItem(page: Page, testId: string) {
  const item = page.getByTestId(testId);
  if (!(await item.isVisible())) {
    await page.getByTestId('toolbar-more').click();
    await expect(item).toBeVisible();
  }
  await item.click();
}

async function openSampleProject(page: Page) {
  await clickToolbarItem(page, 'open-sample-project');
  await expect(page.getByTestId('open-export-workspace')).toBeEnabled();
}

async function prepareShortShot(page: Page) {
  await openSampleProject(page);
  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-tab-adopted').click();
  const shortestShot = page.getByTestId('storyboard-adopted-shot').first();
  await shortestShot.locator('input[type="number"]').fill('0.1');
  await shortestShot.locator('input[type="number"]').press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('storyboard-workspace')).toBeHidden();
  await page.getByTitle('适配时长').click();
}

async function prepareAdjacentShortShots(page: Page) {
  await openSampleProject(page);
  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-tab-adopted').click();
  const shots = page.getByTestId('storyboard-adopted-shot');
  for (let index = 0; index < 2; index += 1) {
    const duration = shots.nth(index).locator('input[type="number"]');
    await duration.fill('0.1');
    await duration.press('Tab');
  }
  await page.keyboard.press('Escape');
  const targets = page.locator('[data-testid^="shot-block-"]');
  await targets.nth(1).click();
  await page.locator('[data-testid^="shot-move-left-"]:not([disabled])').click();
  await page.getByTitle('适配时长').click();
}

async function prepareOverwrite(page: Page) {
  await openSampleProject(page);
  await page.getByTestId('editor-panel-objects').click();
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('editor-panel-scene').click();
  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
}

async function capture(page: Page, filename: string, outputDir = OUTPUT_DIR) {
  await page.screenshot({
    path: resolve(outputDir, filename),
    animations: 'disabled',
  });
}

async function captureScenario(
  browser: Browser,
  viewport: { width: number; height: number },
  filename: string,
  arrange: (page: Page) => Promise<void>,
  url = '/',
  outputDir = OUTPUT_DIR,
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await arrange(page);
    await page.waitForTimeout(300);
    await capture(page, filename, outputDir);
  } finally {
    await context.close();
  }
}

async function expectSingleRowToolbar(page: Page) {
  const geometry = await page.getByTestId('lumora-toolbar').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const visibleButtons = Array.from(element.querySelectorAll<HTMLElement>('button')).filter(
      (button) => button.getClientRects().length > 0,
    );
    return {
      height: rect.height,
      contained: visibleButtons.every((button) => {
        const buttonRect = button.getBoundingClientRect();
        return buttonRect.top >= rect.top && buttonRect.bottom <= rect.bottom && buttonRect.right <= rect.right;
      }),
      singleLine: visibleButtons.every((button) => getComputedStyle(button).whiteSpace === 'nowrap'),
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(52);
  expect(geometry.contained).toBe(true);
  expect(geometry.singleLine).toBe(true);
}

test('captures the TML-563 round 3 before/after matrix', async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  await captureScenario(
    browser,
    { width: 1440, height: 900 },
    'hold-dual-ctrlk-scope.png',
    async (page) => {
      const studios = page.locator('#root [data-testid="lumora-studio"]');
      await expect(studios).toHaveCount(2);
      await studios.first().dispatchEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        composed: true,
      });
      await expect(page.getByTestId('command-palette')).toHaveCount(1);
      await studios.nth(1).dispatchEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        composed: true,
      });
      await expect(page.getByTestId('command-palette')).toHaveCount(1);
    },
    '/?fixture=dual-studio',
  );

  await captureScenario(
    browser,
    { width: 1440, height: 900 },
    'hold-dual-palette-ids.png',
    async (page) => {
      const openers = page.locator('#root [data-testid="open-command-palette"]');
      await expect(openers).toHaveCount(2);
      await openers.first().evaluate((button: HTMLButtonElement) => button.click());
      await openers.nth(1).evaluate((button: HTMLButtonElement) => button.click());
      const inputs = page.getByTestId('command-palette-input');
      await expect(inputs).toHaveCount(2);
      const labels = await inputs.evaluateAll((elements: HTMLInputElement[]) => elements.map((input) => ({
        id: input.id,
        labelCount: input.labels?.length ?? 0,
        accessibleLabel: input.labels?.[0]?.textContent?.trim(),
      })));
      expect(new Set(labels.map(({ id }) => id)).size).toBe(2);
      expect(labels.every(({ labelCount, accessibleLabel }) => labelCount === 1 && accessibleLabel === '搜索命令')).toBe(true);
    },
    '/?fixture=dual-studio',
  );

  await captureScenario(
    browser,
    { width: 375, height: 667 },
    'hold-fit-overview-loss-375x667.png',
    async (page) => {
      await prepareShortShot(page);
      const geometry = await page.getByTestId('timeline-body').evaluate((body) => ({
        viewportWidth: body.clientWidth,
        canvasWidth: body.querySelector<HTMLElement>('.lumora-timeline__canvas')!.getBoundingClientRect().width,
      }));
      expect(geometry.canvasWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      await page.getByTestId('timeline-body').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    },
  );

  await captureScenario(
    browser,
    { width: 375, height: 667 },
    'hold-shot-actions-clipped-375x667.png',
    async (page) => {
      await prepareShortShot(page);
      await page.getByTitle('缩小').click();
      await page.locator('[data-testid^="shot-block-"]').first().click();
      const actions = page.getByTestId('selected-shot-actions');
      await expect(actions).toBeVisible();
      const hitTargets = await actions.locator('button').evaluateAll((buttons) => buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
      expect(hitTargets).toHaveLength(3);
      expect(hitTargets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
    },
  );

  await captureScenario(
    browser,
    { width: 375, height: 667 },
    'tml-563-keyframes-60fps-overlap-375x667.png',
    async (page) => {
      const lane = page.locator('[data-track-id="review-60fps"]');
      await expect(lane).toBeVisible();
      await page.getByTitle('适配时长').click();
      const keys = lane.locator('.lumora-timeline__keyframe');
      await expect(keys).toHaveCount(2);
      const geometry = await keys.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          ownsCenter: document.elementFromPoint(center.x, center.y)?.closest('.lumora-timeline__keyframe') === element,
        };
      }));
      const [first, second] = geometry;
      const overlapWidth = Math.max(0, Math.min(first!.right, second!.right) - Math.max(first!.left, second!.left));
      const overlapHeight = Math.max(0, Math.min(first!.bottom, second!.bottom) - Math.max(first!.top, second!.top));
      expect(overlapWidth * overlapHeight).toBe(0);
      expect(geometry.every(({ ownsCenter }) => ownsCenter)).toBe(true);
      await keys.first().focus();
    },
    '/?fixture=tml-563-round3',
  );

  await captureScenario(
    browser,
    { width: 1440, height: 900 },
    'hold-overwrite-host-focus.png',
    async (page) => {
      await prepareOverwrite(page);
      const focusState = await page.evaluate(() => {
        const hostButton = document.querySelector<HTMLElement>('[data-testid="studio-mount-toggle"]')!;
        const dialog = document.querySelector<HTMLElement>('[data-testid="overwrite-confirm"]')!;
        hostButton.focus();
        return {
          rootInert: document.querySelector<HTMLElement>('#root')!.inert,
          hostFocused: document.activeElement === hostButton,
          dialogFocused: dialog.contains(document.activeElement),
        };
      });
      expect(focusState).toEqual({ rootInert: true, hostFocused: false, dialogFocused: true });
    },
  );

  await captureScenario(
    browser,
    { width: 1440, height: 900 },
    'hold-mixed-modal-escape-order.png',
    async (page) => {
      await prepareOverwrite(page);
      await page.getByTestId('open-command-palette').evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);
      await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
    },
  );

  for (const { width, filename } of [
    { width: 1420, filename: 'toolbar-studio-1080-host-1420x768.png' },
    { width: 1421, filename: 'toolbar-studio-1081-host-1421x768.png' },
    { width: 1580, filename: 'toolbar-studio-1240-host-1580x768.png' },
    { width: 1581, filename: 'toolbar-studio-1241-host-1581x768.png' },
  ]) {
    await captureScenario(browser, { width, height: 768 }, filename, async (page) => {
      await openSampleProject(page);
      await expectSingleRowToolbar(page);
    });
  }

  await captureScenario(
    browser,
    { width: 375, height: 667 },
    'portrait-log-open-375x667.png',
    async (page) => {
      await openSampleProject(page);
      await page.getByTestId('host-log-toggle').click();
      await expect(page.getByTestId('host-event-log')).toBeVisible();
      await page.getByTestId('timeline-body').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const contained = await page.evaluate(() => {
        const studio = document.querySelector<HTMLElement>('[data-testid="lumora-studio"]')!.getBoundingClientRect();
        const timeline = document.querySelector<HTMLElement>('[data-testid="lumora-timeline"]')!.getBoundingClientRect();
        const shots = document.querySelector<HTMLElement>('[data-testid="timeline-shots"]')!.getBoundingClientRect();
        return timeline.bottom <= studio.bottom + 1 && shots.bottom <= timeline.bottom + 1;
      });
      expect(contained).toBe(true);
    },
  );
});

test('captures refreshed TML-563 states 14 and 15', async ({ browser }) => {
  mkdirSync(CURRENT_OUTPUT_DIR, { recursive: true });

  await captureScenario(
    browser,
    { width: 667, height: 375 },
    '14-mobile-landscape-log-open-667x375.png',
    async (page) => {
      await openSampleProject(page);
      await page.getByTestId('host-log-toggle').click();
      await expect(page.getByTestId('host-log-close')).toBeFocused();
    },
    '/',
    CURRENT_OUTPUT_DIR,
  );

  await captureScenario(
    browser,
    { width: 375, height: 667 },
    '15-mobile-fit-shot-controls-375x667.png',
    async (page) => {
      await prepareAdjacentShortShots(page);
      await expect.poll(() => page.getByTestId('timeline-body').evaluate((body) => body.scrollLeft)).toBe(0);
      await page.getByTestId('timeline-body').evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
    },
    '/',
    CURRENT_OUTPUT_DIR,
  );
});
