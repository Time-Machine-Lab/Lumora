import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { decodePng, pngPixel } from './helpers/png';

async function sampledColorCount(page: import('@playwright/test').Page) {
  const image = decodePng(await page.locator('.lumora-viewport canvas').screenshot());
  const colors = new Set<string>();
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 80));
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      colors.add(pngPixel(image, x, y).slice(0, 3).join(','));
    }
  }
  return { colors: colors.size, width: image.width, height: image.height };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
});

test('1024 desktop uses the Studio container width and preserves the scene workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId('editor-panel-objects').click();
  await page.getByTestId('tree-row-sample-cube').click();
  await page.getByTestId('editor-panel-scene').click();
  const studio = page.getByTestId('lumora-studio');
  const measurements = await page.evaluate(() => {
    const studioRect = document.querySelector<HTMLElement>('[data-testid="lumora-studio"]')!.getBoundingClientRect();
    const viewportRect = document.querySelector<HTMLElement>('[data-testid="lumora-viewport"]')!.getBoundingClientRect();
    return { studioWidth: studioRect.width, viewportWidth: viewportRect.width, viewportHeight: viewportRect.height };
  });
  expect(measurements.studioWidth).toBeLessThan(760);
  expect(measurements.viewportWidth).toBeGreaterThanOrEqual(480);
  expect(measurements.viewportHeight).toBeGreaterThanOrEqual(280);
  await expect(studio.getByRole('tab', { name: '场景' })).toHaveAttribute('aria-selected', 'true');
});

test('mobile defaults to a usable scene and keeps the host log collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByTestId('host-event-log')).toBeHidden();
  await expect(page.getByTestId('host-log-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('lumora-toolbar')).toHaveCSS('flex-wrap', 'nowrap');

  const viewport = page.getByTestId('lumora-viewport');
  const box = await viewport.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(220);
  await page.getByTestId('editor-panel-objects').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await page.getByTestId('editor-panel-scene').click();
  await expect(viewport).toBeVisible();
});

test('mobile editor tabs support roving keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const sceneTab = page.getByTestId('editor-panel-scene');
  const objectsTab = page.getByTestId('editor-panel-objects');
  const propertiesTab = page.getByTestId('editor-panel-properties');

  await sceneTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(objectsTab).toBeFocused();
  await expect(objectsTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(propertiesTab).toBeFocused();
  await expect(propertiesTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(sceneTab).toBeFocused();
  await expect(sceneTab).toHaveAttribute('aria-selected', 'true');
});

test('mobile overflow menu supports menu keys and visible modal focus restoration', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const moreButton = page.getByTestId('toolbar-more');
  await moreButton.click();
  const firstItem = page.getByTestId('open-sample-project');
  const secondItem = page.getByTestId('close-project');
  await expect(firstItem).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(secondItem).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('open-plugin-manager')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(firstItem).toBeFocused();

  const pluginOpener = page.getByTestId('open-plugin-manager');
  await pluginOpener.click();
  await page.getByTestId('close-plugin-manager').click();
  await expect(pluginOpener).toBeVisible();
  await expect(pluginOpener).toBeFocused();

  const paletteOpener = page.getByTestId('open-command-palette');
  await paletteOpener.click();
  await page.locator('.lumora-modal-backdrop').click({ position: { x: 1, y: 1 } });
  await expect(paletteOpener).toBeVisible();
  await expect(paletteOpener).toBeFocused();
});

test('mobile Ctrl+K restores the visible pre-shortcut focus target', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const moreButton = page.getByTestId('toolbar-more');
  await moreButton.focus();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(moreButton).toBeFocused();
});

test('desktop and mobile canvases render nonblank scene pixels at stable dimensions', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  let pixels = await sampledColorCount(page);
  expect(pixels.width).toBeGreaterThanOrEqual(480);
  expect(pixels.height).toBeGreaterThanOrEqual(280);
  expect(pixels.colors).toBeGreaterThan(20);

  await page.setViewportSize({ width: 375, height: 667 });
  pixels = await sampledColorCount(page);
  expect(pixels.width).toBeGreaterThanOrEqual(350);
  expect(pixels.height).toBeGreaterThanOrEqual(220);
  expect(pixels.colors).toBeGreaterThan(20);
});

test('plugin manager and command palette contain focus and restore their openers', async ({ page }) => {
  const pluginOpener = page.getByTestId('open-plugin-manager');
  await pluginOpener.click();
  const pluginDialog = page.getByRole('dialog', { name: '插件管理' });
  await expect(pluginDialog).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Shift+Tab');
  await expect(pluginDialog).toContainText('插件管理');
  expect(await pluginDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(pluginOpener).toBeFocused();

  const paletteOpener = page.getByTestId('open-command-palette');
  await paletteOpener.click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(page.getByTestId('command-palette-input')).toHaveAccessibleName('搜索命令');
  await page.keyboard.press('Shift+Tab');
  expect(await palette.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(paletteOpener).toBeFocused();
});

test('main editor and dialogs have no WCAG A/AA axe violations', async ({ page }) => {
  await page.getByTestId('tree-row-sample-cube').click();
  let results = await new AxeBuilder({ page })
    .include('[data-testid="lumora-studio"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  await page.getByTestId('open-plugin-manager').click();
  results = await new AxeBuilder({ page })
    .include('[data-testid="plugin-manager"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('Mock plugin controls inherit Studio surface, border, text, focus, and disabled tokens', async ({ page }) => {
  await page.getByTestId('panel-tab-com.lumora.mock.panel.ai').click();
  const panel = page.getByTestId('mock-ai-panel');
  const input = page.getByTestId('mock-ai-input');
  const send = page.getByTestId('mock-ai-send');
  await input.focus();

  const styles = await panel.evaluate((element) => {
    const studio = element.closest<HTMLElement>('.lumora-studio')!;
    const inputElement = element.querySelector<HTMLInputElement>('[data-testid="mock-ai-input"]')!;
    const resolveColor = (variable: string) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${variable})`;
      studio.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      panelBackground: getComputedStyle(element).backgroundColor,
      surface: resolveColor('--lumora-surface'),
      inputBackground: getComputedStyle(inputElement).backgroundColor,
      background: resolveColor('--lumora-bg'),
      inputBorder: getComputedStyle(inputElement).borderColor,
      border: resolveColor('--lumora-border'),
      inputText: getComputedStyle(inputElement).color,
      text: resolveColor('--lumora-text'),
      inputOutline: getComputedStyle(inputElement).outlineColor,
      accent: resolveColor('--lumora-accent'),
    };
  });
  expect(styles.panelBackground).toBe(styles.surface);
  expect(styles.inputBackground).toBe(styles.background);
  expect(styles.inputBorder).toBe(styles.border);
  expect(styles.inputText).toBe(styles.text);
  expect(styles.inputOutline).toBe(styles.accent);

  await input.fill('token check');
  await send.click();
  await expect(send).toBeDisabled();
  const disabledColor = await send.evaluate((button) => getComputedStyle(button).color);
  const disabledToken = await panel.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--lumora-text-disabled)';
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(disabledColor).toBe(disabledToken);
});
