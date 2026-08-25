import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function openStoryboard(page: Page): Promise<void> {
  await page.getByTestId('open-storyboard-workspace').click();
  await expect(page.getByTestId('storyboard-workspace')).toBeVisible();
  await expect(page.getByTestId('storyboard-provider')).toHaveValue('com.lumora.mock.ai');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('generates three validated shots and adopts them with editable metadata in one project update', async ({ page }) => {
  await openStoryboard(page);
  await page.getByTestId('storyboard-concept').fill('A courier crosses a neon market while protecting a mysterious case.');
  await expect(page.getByTestId('storyboard-cost-hint')).toContainText('0.00 USD');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByText('Offline storyboard draft')).toBeVisible();
  await expect(page.getByTestId('storyboard-draft-shot')).toHaveCount(3);
  await page.getByTestId('storyboard-draft-prompt-0').fill('Edited browser acceptance prompt');
  await page.getByTestId('storyboard-accept-all').click();
  await expect(page.getByTestId('lumora-toasts')).toContainText('已采用 3 个分镜');

  await page.getByTestId('storyboard-tab-adopted').click();
  await expect(page.getByTestId('storyboard-adopted-shot')).toHaveCount(6);
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(6);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  expect(exported.shots.slice(-3)).toMatchObject([
    {
      name: 'Shot 1',
      startTime: 4.5,
      endTime: 8.5,
      shotSize: 'wide',
      movement: 'dolly-in',
      prompt: 'Edited browser acceptance prompt',
      aiSource: {
        providerId: 'com.lumora.mock.ai',
        model: 'mock-storyboard-success',
      },
    },
    {
      name: 'Shot 2',
      startTime: 8.5,
      endTime: 12.5,
      shotSize: 'medium',
      movement: 'tracking',
    },
    {
      name: 'Shot 3',
      startTime: 12.5,
      endTime: 16.5,
      shotSize: 'close-up',
      movement: 'static',
    },
  ]);
});

test('rejects an invalid provider payload without changing the project', async ({ page }) => {
  await openStoryboard(page);
  await page.getByTestId('storyboard-concept').fill('A complete concept long enough to pass request validation.');
  await page.getByTestId('storyboard-model').selectOption('mock-storyboard-schema-error');
  await expect(page.getByTestId('storyboard-cost-hint')).toContainText('未知');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByTestId('storyboard-error')).toContainText('schema_invalid');
  await expect(page.getByTestId('storyboard-error')).toContainText('未自动重试');
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('cancels a running generation without adopting shots', async ({ page }) => {
  await openStoryboard(page);
  await page.getByTestId('storyboard-concept').fill('A complete concept long enough to pass request validation.');
  await page.getByTestId('storyboard-model').selectOption('mock-storyboard-slow');
  await page.getByTestId('storyboard-generate').click();
  await expect(page.getByTestId('storyboard-cancel')).toBeEnabled();
  await page.getByTestId('storyboard-cancel').click();

  await expect(page.getByTestId('storyboard-error')).toContainText('cancelled');
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('keeps the generation workflow usable without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openStoryboard(page);

  const workspace = page.getByTestId('storyboard-workspace');
  const dimensions = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByRole('button', { name: '关闭 AI 分镜工作台' })).toBeVisible();
  await expect(page.getByTestId('storyboard-provider')).toBeVisible();

  await page.getByTestId('storyboard-concept').fill('A courier crosses a neon market while protecting a mysterious case.');
  await page.getByTestId('storyboard-generate').click();
  await expect(page.getByText('Offline storyboard draft')).toBeVisible();
  await expect(page.getByTestId('storyboard-draft-shot')).toHaveCount(3);
});

test('collapses the storyboard layout inside a narrow embed on a wide desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const studio = page.getByTestId('lumora-studio');
  await studio.evaluate((element) => {
    element.style.width = '600px';
    element.style.flex = '0 0 600px';
    element.style.maxWidth = '600px';
  });
  await expect.poll(async () => (await studio.boundingBox())?.width).toBe(600);
  await openStoryboard(page);

  const layout = page.locator('.lumora-storyboard__layout');
  const dimensions = await layout.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    display: getComputedStyle(element).display,
  }));
  expect(dimensions.display).toBe('block');
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByTestId('storyboard-provider')).toBeVisible();
  await expect(page.locator('.lumora-storyboard__drafts')).toBeVisible();
});
