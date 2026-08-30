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

async function clickToolbarItem(page: import('@playwright/test').Page, testId: string) {
  const item = page.getByTestId(testId);
  if (!(await item.isVisible())) await page.getByTestId('toolbar-more').click();
  await item.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clickToolbarItem(page, 'open-sample-project');
  await expect(page.getByTestId('open-export-workspace')).toBeEnabled();
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

test('900/901 editor boundary preserves a usable Scene instead of collapsing on growth', async ({ page }) => {
  const sceneWidths: number[] = [];
  for (const width of [1240, 1241]) {
    await page.setViewportSize({ width, height: 768 });
    const measurements = await page.evaluate(() => {
      const studio = document.querySelector<HTMLElement>('[data-testid="lumora-studio"]')!;
      const scene = document.querySelector<HTMLElement>('.lumora-studio__viewport')!;
      const more = document.querySelector<HTMLElement>('[data-testid="toolbar-more"]')!;
      return {
        studio: studio.getBoundingClientRect().width,
        scene: scene.getBoundingClientRect().width,
        moreVisible: getComputedStyle(more).display !== 'none',
      };
    });
    expect(measurements.studio).toBeCloseTo(width - 340, 0);
    expect(measurements.scene).toBeGreaterThanOrEqual(480);
    expect(measurements.moreVisible).toBe(true);
    sceneWidths.push(measurements.scene);
  }
  expect(Math.abs(sceneWidths[1]! - sceneWidths[0]!)).toBeLessThan(80);
});

test('1100/1101 toolbar boundary remains a compact single row', async ({ page }) => {
  const heights: number[] = [];
  for (const width of [1440, 1441]) {
    await page.setViewportSize({ width, height: 768 });
    const height = await page.getByTestId('lumora-toolbar').evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeLessThan(60);
    heights.push(height);
  }
  expect(Math.abs(heights[1]! - heights[0]!)).toBeLessThan(4);
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

test('375 fit zoom preserves every shot action and non-overlapping keyframe lane', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-tab-adopted').click();
  const shortestValidShot = page.getByTestId('storyboard-adopted-shot').first();
  await shortestValidShot.locator('input[type="number"]').fill('0.1');
  await shortestValidShot.locator('input[type="number"]').press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('storyboard-workspace')).toBeHidden();
  await page.getByRole('button', { name: '适配' }).click();

  const shots = page.locator('[data-testid^="shot-block-"]');
  await expect(shots).toHaveCount(3);
  for (let index = 0; index < await shots.count(); index += 1) {
    const shot = shots.nth(index);
    const shotBox = await shot.boundingBox();
    const actionBoxes = await shot.locator('button').evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().width),
    );
    expect(shotBox?.width ?? 0).toBeGreaterThanOrEqual(148);
    expect(actionBoxes).toHaveLength(3);
    expect(Math.min(...actionBoxes)).toBeGreaterThanOrEqual(44);
  }

  const laneGeometry = await page.locator('.lumora-timeline__lane').evaluateAll((lanes) =>
    lanes.map((lane) => {
      const laneRect = lane.getBoundingClientRect();
      const keyframes = Array.from(lane.querySelectorAll<HTMLElement>('.lumora-timeline__keyframe'));
      return {
        height: laneRect.height,
        containsTargets: keyframes.every((keyframe) => {
          const rect = keyframe.getBoundingClientRect();
          return rect.top >= laneRect.top && rect.bottom <= laneRect.bottom;
        }),
      };
    }),
  );
  expect(laneGeometry.length).toBeGreaterThan(1);
  expect(
    laneGeometry.every(({ height, containsTargets }) => height >= 44 && containsTargets),
    JSON.stringify(laneGeometry),
  ).toBe(true);
});

test('375 storyboard close and delete controls use 44px icon targets', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-tab-adopted').click();

  const controls = page.getByRole('button', { name: /关闭 AI 分镜工作台|删除分镜/ });
  expect(await controls.count()).toBeGreaterThan(1);
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const deletes = page.getByRole('button', { name: /删除分镜/ });
  await expect(deletes.first().locator('svg.lucide-trash-2')).toBeVisible();
});

test('667x375 expanded host log keeps both Scene and Timeline inside Studio', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.getByTestId('host-log-toggle').click();
  await expect(page.getByTestId('host-event-log')).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const studio = rect('[data-testid="lumora-studio"]');
    const scene = rect('[data-testid="lumora-viewport"]');
    const timeline = rect('[data-testid="lumora-timeline"]');
    return {
      studio: { top: studio.top, bottom: studio.bottom },
      scene: { top: scene.top, bottom: scene.bottom, height: scene.height },
      timeline: { top: timeline.top, bottom: timeline.bottom, height: timeline.height },
    };
  });
  expect(geometry.scene.height).toBeGreaterThanOrEqual(100);
  expect(geometry.timeline.height).toBeGreaterThanOrEqual(48);
  expect(geometry.scene.top).toBeGreaterThanOrEqual(geometry.studio.top);
  expect(geometry.timeline.bottom).toBeLessThanOrEqual(geometry.studio.bottom + 1);
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
  await clickToolbarItem(page, 'open-plugin-manager');
  const pluginDialog = page.getByRole('dialog', { name: '插件管理' });
  await expect(pluginDialog).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Shift+Tab');
  await expect(pluginDialog).toContainText('插件管理');
  expect(await pluginDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(pluginOpener).toBeFocused();

  const paletteOpener = page.getByTestId('open-command-palette');
  await clickToolbarItem(page, 'open-command-palette');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(page.getByTestId('command-palette-input')).toHaveAccessibleName('搜索命令');
  await page.keyboard.press('Shift+Tab');
  expect(await palette.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(paletteOpener).toBeFocused();
});

test('portal modal inerts the host root and restores a deep ShadowRoot opener', async ({ page }) => {
  await clickToolbarItem(page, 'open-plugin-manager');
  const pluginDialog = page.getByRole('dialog', { name: '插件管理' });
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  const escaped = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[data-testid="studio-mount-toggle"]')!;
    target.focus();
    return document.activeElement === target;
  });
  expect(escaped).toBe(false);
  expect(await pluginDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'shadow-focus-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.id = 'shadow-focus-opener';
    button.textContent = 'Shadow opener';
    shadow.append(button);
    document.body.append(host);
    button.focus();
  });
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="open-command-palette"]')!.click();
  });
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() =>
    document.querySelector<HTMLElement>('#shadow-focus-host')?.shadowRoot?.activeElement?.id,
  )).toBe('shadow-focus-opener');
});

test('plugin toggles keep browser focus through active, disabled, and failed transitions', async ({ page }) => {
  await clickToolbarItem(page, 'open-plugin-manager');
  const activeToggle = page.getByTestId('plugin-toggle-com.lumora.mock');
  await activeToggle.click();
  await expect(page.getByTestId('plugin-state-com.lumora.mock')).toHaveText('已禁用');
  await expect(activeToggle).toBeFocused();
  await activeToggle.click();
  await expect(page.getByTestId('plugin-state-com.lumora.mock')).toHaveText('运行中');
  await expect(activeToggle).toBeFocused();

  const failedToggle = page.getByTestId('plugin-toggle-com.example.brokenmanifest');
  await failedToggle.click();
  await expect(page.getByTestId('plugin-state-com.example.brokenmanifest')).toHaveText('已停用');
  await expect(failedToggle).toBeFocused();
});

test('two Studio instances route Escape to the top portal only', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?fixture=dual-studio');
  const openers = page.getByTestId('open-plugin-manager');
  await expect(openers).toHaveCount(2);
  await openers.first().click();
  const lowerDialog = page.getByRole('dialog', { name: '插件管理' }).first();
  await openers.nth(1).evaluate((button) => button.click());
  await expect(page.getByRole('dialog', { name: '插件管理' })).toHaveCount(2);

  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog', { name: '插件管理' })).toHaveCount(1);
  await expect(lowerDialog).toBeVisible();
});

test('main editor and dialogs have no WCAG A/AA axe violations', async ({ page }) => {
  await page.getByTestId('editor-panel-objects').click();
  await page.getByTestId('tree-row-sample-cube').click();
  await page.getByTestId('editor-panel-scene').click();
  let results = await new AxeBuilder({ page })
    .include('[data-testid="lumora-studio"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  await clickToolbarItem(page, 'open-plugin-manager');
  results = await new AxeBuilder({ page })
    .include('[data-testid="plugin-manager"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('Mock plugin controls inherit Studio surface, border, text, focus, and disabled tokens', async ({ page }) => {
  await page.getByTestId('editor-panel-objects').click();
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
