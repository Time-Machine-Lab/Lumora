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

async function clickToolbarItem(
  page: import('@playwright/test').Page,
  testId: string,
  scope: import('@playwright/test').Page | import('@playwright/test').Locator = page,
) {
  const item = scope.getByTestId(testId);
  if (!(await item.isVisible())) await scope.getByTestId('toolbar-more').click();
  await item.click();
}

async function expectFirstTwoShotTargetsToBeDisjoint(page: import('@playwright/test').Page) {
  const shots = page.locator('[data-testid^="shot-block-"]');
  const durations = page.locator('[data-testid^="shot-duration-"]');
  await expect(shots).toHaveCount(3);
  await expect(durations).toHaveCount(3);
  await shots.first().scrollIntoViewIfNeeded();
  const geometry = await shots.evaluateAll((elements) => elements.slice(0, 2).map((element) => {
    const rect = element.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>('[data-testid="timeline-body"]')!.getBoundingClientRect();
    const label = document.querySelector<HTMLElement>('.lumora-timeline__label--shots')!.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const points = [
      { x: rect.left + 1, y: center.y },
      center,
      { x: rect.right - 1, y: center.y },
    ];
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      center,
      points,
      fullyVisible: rect.left >= label.right - 0.5 && rect.right <= body.right + 0.5,
      ownsPoints: points.every((point) =>
        document.elementFromPoint(point.x, point.y)?.closest('[data-testid^="shot-block-"]') === element,
      ),
    };
  }));
  expect(geometry).toHaveLength(2);
  expect(geometry.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  const [first, second] = geometry;
  const overlapWidth = Math.max(0, Math.min(first!.right, second!.right) - Math.max(first!.left, second!.left));
  const overlapHeight = Math.max(0, Math.min(first!.bottom, second!.bottom) - Math.max(first!.top, second!.top));
  expect(overlapWidth * overlapHeight).toBe(0);
  expect(geometry.every(({ fullyVisible, ownsPoints }) => fullyVisible && ownsPoints)).toBe(true);

  const durationGeometry = await durations.evaluateAll((elements) => elements.slice(0, 2).map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  }));
  expect(durationGeometry.every(({ width }) => width >= 3)).toBe(true);
  expect(Math.abs(durationGeometry[0]!.right - durationGeometry[1]!.left)).toBeLessThanOrEqual(1);

  for (const [index, { points }] of geometry.entries()) {
    for (const point of points) {
      await page.mouse.click(point.x, point.y);
      await expect(shots.nth(index)).toHaveAttribute('aria-pressed', 'true');
    }
  }
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

test('Studio 1080/1081 boundary keeps the toolbar on one contained row', async ({ page }) => {
  const heights: number[] = [];
  for (const width of [1420, 1421]) {
    await page.setViewportSize({ width, height: 768 });
    const measurements = await page.evaluate(() => {
      const studio = document.querySelector<HTMLElement>('[data-testid="lumora-studio"]')!;
      const toolbar = document.querySelector<HTMLElement>('[data-testid="lumora-toolbar"]')!;
      const more = document.querySelector<HTMLElement>('[data-testid="toolbar-more"]')!;
      const toolbarRect = toolbar.getBoundingClientRect();
      const visibleButtons = Array.from(toolbar.querySelectorAll<HTMLElement>('button')).filter(
        (button) => button.getClientRects().length > 0,
      );
      return {
        studio: studio.getBoundingClientRect().width,
        height: toolbarRect.height,
        moreVisible: getComputedStyle(more).display !== 'none',
        contained: visibleButtons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.top >= toolbarRect.top && rect.bottom <= toolbarRect.bottom && rect.right <= toolbarRect.right;
        }),
      };
    });
    expect(measurements.studio).toBeCloseTo(width - 340, 0);
    expect(measurements.moreVisible).toBe(true);
    expect(measurements.contained).toBe(true);
    expect(measurements.height).toBeLessThanOrEqual(52);
    heights.push(measurements.height);
  }
  expect(Math.abs(heights[1]! - heights[0]!)).toBeLessThan(1);
});

test('Studio 1240/1241 boundary remains a compact single row', async ({ page }) => {
  const heights: number[] = [];
  for (const width of [1580, 1581]) {
    await page.setViewportSize({ width, height: 768 });
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
      };
    });
    expect(geometry.height).toBeLessThanOrEqual(52);
    expect(geometry.contained).toBe(true);
    heights.push(geometry.height);
  }
  expect(Math.abs(heights[1]! - heights[0]!)).toBeLessThan(1);
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

test('375 fit zoom shows the whole duration and keeps selected-shot actions in the sticky label', async ({ page }) => {
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
  const fitGeometry = await page.getByTestId('timeline-body').evaluate((body) => ({
    clientWidth: body.clientWidth,
    canvasWidth: body.querySelector<HTMLElement>('.lumora-timeline__canvas')!.getBoundingClientRect().width,
  }));
  expect(fitGeometry.canvasWidth).toBeLessThanOrEqual(fitGeometry.clientWidth + 1);

  await shots.first().click();
  const actions = page.getByTestId('selected-shot-actions');
  await expect(actions).toBeVisible();
  const actionGeometry = await actions.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(actionGeometry).toHaveLength(3);
  expect(actionGeometry.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  expect(await actions.evaluate((element) => getComputedStyle(element.parentElement!).position)).toBe('sticky');
});

test('375 adjacent 0.1s shots keep disjoint 44px targets at fit, zoom-out, and minimum zoom', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-tab-adopted').click();
  const adoptedShots = page.getByTestId('storyboard-adopted-shot');
  await expect(adoptedShots).toHaveCount(3);
  for (let index = 0; index < 2; index += 1) {
    const duration = adoptedShots.nth(index).locator('input[type="number"]');
    await duration.fill('0.1');
    await duration.press('Tab');
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('storyboard-workspace')).toBeHidden();

  const shots = page.locator('[data-testid^="shot-block-"]');
  await shots.nth(1).click();
  await page.locator('[data-testid^="shot-move-left-"]:not([disabled])').click();
  await page.getByRole('button', { name: '适配' }).click();
  await expect.poll(() => page.getByTestId('timeline-body').evaluate((body) => body.scrollLeft)).toBe(0);
  await expectFirstTwoShotTargetsToBeDisjoint(page);

  await page.getByTitle('缩小').click();
  await expectFirstTwoShotTargetsToBeDisjoint(page);

  for (let index = 0; index < 12; index += 1) await page.getByTitle('缩小').click();
  await expectFirstTwoShotTargetsToBeDisjoint(page);
});

test('out-of-order imported shots use chronological action boundaries and reorder order', async ({ page }) => {
  await page.goto('/?fixture=tml-563-timeline-edges');
  const shots = page.locator('[data-testid^="shot-block-review-"]');
  await expect(shots).toHaveCount(3);
  await expect.poll(() => shots.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))))
    .toEqual([
      'shot-block-review-short',
      'shot-block-review-long',
      'shot-block-review-late',
    ]);

  await page.getByTestId('shot-block-review-short').click();
  await expect(page.getByTestId('shot-move-left-review-short')).toBeDisabled();
  await expect(page.getByTestId('shot-move-right-review-short')).toBeEnabled();

  await page.getByTestId('shot-block-review-late').click();
  await expect(page.getByTestId('shot-move-left-review-late')).toBeEnabled();
  await expect(page.getByTestId('shot-move-right-review-late')).toBeDisabled();

  await page.getByTestId('shot-block-review-long').click();
  await page.getByTestId('shot-move-left-review-long').click();
  await expect.poll(() => shots.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))))
    .toEqual([
      'shot-block-review-long',
      'shot-block-review-short',
      'shot-block-review-late',
    ]);
  await expect(page.getByTestId('shot-duration-review-long')).toHaveCSS('left', '0px');
  await expect(page.getByTestId('shot-move-left-review-long')).toBeDisabled();
});

test('selected overlapping shot duration remains visibly accented', async ({ page }) => {
  await page.goto('/?fixture=tml-563-timeline-edges');
  await page.getByTestId('shot-block-review-short').click();
  await page.getByTestId('timeline-body').evaluate((body) => {
    body.scrollLeft = 0;
    body.scrollTop = body.scrollHeight;
  });
  const selected = page.getByTestId('shot-duration-review-short');
  const covering = page.getByTestId('shot-duration-review-long');
  const metrics = await selected.evaluate((element, coveringElement) => {
    const rect = element.getBoundingClientRect();
    const coveringRect = (coveringElement as HTMLElement).getBoundingClientRect();
    const labelRect = document.querySelector<HTMLElement>('.lumora-timeline__label--shots')!.getBoundingClientRect();
    const sampleX = Math.min(rect.right - 2, Math.max(rect.left + 2, labelRect.right + 2));
    const color = getComputedStyle(element).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number);
    return {
      x: sampleX,
      y: rect.top + rect.height / 2,
      color,
      overlap: Math.max(0, Math.min(rect.right, coveringRect.right) - Math.max(rect.left, coveringRect.left)),
      sampleInsideSelected: sampleX >= rect.left && sampleX < rect.right,
    };
  }, await covering.elementHandle());
  expect(metrics.overlap).toBeGreaterThan(0);
  expect(metrics.sampleInsideSelected).toBe(true);

  const image = decodePng(await page.screenshot({ animations: 'disabled' }));
  expect(pngPixel(image, Math.floor(metrics.x), Math.floor(metrics.y)).slice(0, 3)).toEqual(metrics.color);
});

test('375 exact 60fps adjacent keyframes have disjoint hitboxes and own both visible centers', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/?fixture=tml-563-round3');
  const lane = page.locator('[data-track-id="review-60fps"]');
  await expect(lane).toBeVisible();
  await page.getByRole('button', { name: '适配' }).click();
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
});

test('375 dense 60fps track stays bounded at default and minimum zoom', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/?fixture=tml-563-round3-dense');
  const lane = page.locator('[data-track-id="review-60fps"]');
  await expect(lane).toBeVisible();

  const measure = () => page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const body = rect('[data-testid="timeline-body"]');
    const row = rect('[data-track-id="review-60fps"]');
    const label = rect('[data-testid="track-lane-review-60fps"]');
    const shots = rect('[data-testid="timeline-shots"]');
    const clusters = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="keyframe-cluster-review-60fps-"]'));
    return {
      rowHeight: row.height,
      labelVisible: label.top >= body.top && label.bottom <= body.bottom,
      shotsVisible: shots.top >= body.top && shots.bottom <= body.bottom,
      clusterCount: clusters.length,
      clusteredFrames: clusters.reduce((sum, cluster) => sum + Number(cluster.dataset.keyframeCount), 0),
    };
  });

  let geometry = await measure();
  expect(geometry.rowHeight).toBeLessThanOrEqual(88);
  expect(geometry.labelVisible).toBe(true);
  expect(geometry.shotsVisible).toBe(true);
  expect(geometry.clusterCount).toBeGreaterThan(1);
  expect(geometry.clusteredFrames).toBe(60);

  for (let index = 0; index < 6; index += 1) await page.getByTitle('缩小').click();

  geometry = await measure();
  expect(geometry.rowHeight).toBeLessThanOrEqual(88);
  expect(geometry.labelVisible).toBe(true);
  expect(geometry.shotsVisible).toBe(true);
  expect(geometry.clusterCount).toBe(1);
  expect(geometry.clusteredFrames).toBe(60);
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

test('667x375 expanded host log keeps a complete keyframe target and shot row inside Timeline', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  const toggle = page.getByTestId('host-log-toggle');
  await toggle.focus();
  await toggle.click();
  const log = page.getByTestId('host-event-log');
  const close = page.getByTestId('host-log-close');
  await expect(log).toBeVisible();
  await expect(log).toHaveAttribute('role', 'dialog');
  await expect(log).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('host-studio-region')).toHaveAttribute('inert', '');
  await expect(close).toBeFocused();
  const closeBox = await close.boundingBox();
  expect(closeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press(index % 2 === 0 ? 'Tab' : 'Shift+Tab');
    expect(await log.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  const obscuredControls = await page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>('[data-testid="host-event-log"]')!.getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-testid="host-studio-region"] button, [data-testid="host-studio-region"] input, [data-testid="host-studio-region"] [tabindex]',
    )).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left < drawer.right && rect.right > drawer.left
        && rect.top < drawer.bottom && rect.bottom > drawer.top;
    });
    return {
      count: controls.length,
      allInert: controls.every((element) => element.closest('[inert]') !== null),
      allCovered: controls.every((element) => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(drawer.left + 1, Math.min(drawer.right - 1, rect.left + rect.width / 2));
        const y = Math.max(drawer.top + 1, Math.min(drawer.bottom - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        return hit?.closest('[data-testid="host-event-log"]') !== null;
      }),
    };
  });
  expect(obscuredControls.count).toBeGreaterThan(0);
  expect(obscuredControls.allInert).toBe(true);
  expect(obscuredControls.allCovered).toBe(true);

  await page.getByTestId('timeline-body').evaluate((element) => {
    element.scrollTop = 0;
  });

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const studio = rect('[data-testid="lumora-studio"]');
    const scene = rect('[data-testid="lumora-viewport"]');
    const timeline = rect('[data-testid="lumora-timeline"]');
    const body = rect('[data-testid="timeline-body"]');
    const ruler = rect('[data-testid="timeline-ruler"]');
    const keyframeElement = document.querySelector<HTMLElement>('.lumora-timeline__keyframe')!;
    const keyframe = keyframeElement.getBoundingClientRect();
    const keyframeCenter = { x: keyframe.left + keyframe.width / 2, y: keyframe.top + keyframe.height / 2 };
    return {
      studio: { top: studio.top, bottom: studio.bottom },
      scene: { top: scene.top, bottom: scene.bottom, height: scene.height },
      timeline: { top: timeline.top, bottom: timeline.bottom, height: timeline.height },
      body: { top: body.top, bottom: body.bottom, height: body.height },
      ruler: { bottom: ruler.bottom },
      keyframe: {
        top: keyframe.top,
        bottom: keyframe.bottom,
        width: keyframe.width,
        height: keyframe.height,
        isInert: keyframeElement.closest('[inert]') !== null,
        ownsCenter: document.elementFromPoint(keyframeCenter.x, keyframeCenter.y)?.closest('.lumora-timeline__keyframe') === keyframeElement,
      },
    };
  });
  expect(geometry.scene.height).toBeGreaterThanOrEqual(100);
  expect(geometry.timeline.height).toBeGreaterThanOrEqual(118);
  expect(geometry.scene.top).toBeGreaterThanOrEqual(geometry.studio.top);
  expect(geometry.timeline.bottom).toBeLessThanOrEqual(geometry.studio.bottom + 1);
  expect(geometry.keyframe.width).toBeGreaterThanOrEqual(44);
  expect(geometry.keyframe.height).toBeGreaterThanOrEqual(44);
  expect(geometry.keyframe.top).toBeGreaterThanOrEqual(geometry.ruler.bottom - 1);
  expect(geometry.keyframe.bottom).toBeLessThanOrEqual(geometry.body.bottom + 1);
  expect(geometry.keyframe.isInert).toBe(true);
  expect(geometry.keyframe.ownsCenter).toBe(false);

  await page.getByTestId('timeline-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const bottomGeometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const body = rect('[data-testid="timeline-body"]');
    const ruler = rect('[data-testid="timeline-ruler"]');
    const shots = rect('[data-testid="timeline-shots"]');
    const shotTargetElement = document.querySelector<HTMLElement>('[data-testid^="shot-block-"]')!;
    const shotTarget = shotTargetElement.getBoundingClientRect();
    const shotCenter = { x: shotTarget.left + shotTarget.width / 2, y: shotTarget.top + shotTarget.height / 2 };
    return {
      bodyBottom: body.bottom,
      rulerBottom: ruler.bottom,
      shots: { top: shots.top, bottom: shots.bottom, height: shots.height },
      shotTarget: {
        top: shotTarget.top,
        bottom: shotTarget.bottom,
        height: shotTarget.height,
        isInert: shotTargetElement.closest('[inert]') !== null,
        ownsCenter: document.elementFromPoint(shotCenter.x, shotCenter.y)?.closest('[data-testid^="shot-block-"]') === shotTargetElement,
      },
    };
  });
  expect(bottomGeometry.shots.height).toBeGreaterThanOrEqual(58);
  expect(bottomGeometry.shots.top).toBeGreaterThanOrEqual(bottomGeometry.rulerBottom - 1);
  expect(bottomGeometry.shots.bottom).toBeLessThanOrEqual(bottomGeometry.bodyBottom + 1);
  expect(bottomGeometry.shotTarget.height).toBeGreaterThanOrEqual(44);
  expect(bottomGeometry.shotTarget.top).toBeGreaterThanOrEqual(bottomGeometry.rulerBottom - 1);
  expect(bottomGeometry.shotTarget.bottom).toBeLessThanOrEqual(bottomGeometry.bodyBottom + 1);
  expect(bottomGeometry.shotTarget.isInert).toBe(true);
  expect(bottomGeometry.shotTarget.ownsCenter).toBe(false);

  await page.keyboard.press('Escape');
  await expect(log).toBeHidden();
  await expect(page.getByTestId('host-studio-region')).not.toHaveAttribute('inert', '');
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => {
    const shot = document.querySelector<HTMLElement>('[data-testid^="shot-block-"]')!;
    const rect = shot.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest('[data-testid^="shot-block-"]') === shot;
  })).toBe(true);
});

test('667x375 host log modal contains all host focus and keeps global Escape available', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  const toggle = page.getByTestId('host-log-toggle');
  const log = page.getByTestId('host-event-log');
  const close = page.getByTestId('host-log-close');
  const header = page.locator('.host__bar');
  const reopen = page.getByTestId('reopen-last-export');
  await toggle.click();
  await expect(close).toBeFocused();
  await expect(header).toHaveAttribute('inert', '');

  const eventCount = await page.getByTestId('event-log').locator('li').count();
  const reopenBox = await reopen.boundingBox();
  await page.mouse.click(
    reopenBox!.x + reopenBox!.width / 2,
    reopenBox!.y + reopenBox!.height / 2,
  );
  await expect(close).toBeFocused();
  await expect(page.getByTestId('event-log').locator('li')).toHaveCount(eventCount);

  await page.locator('body').evaluate((body) => {
    body.tabIndex = -1;
    body.focus();
  });
  await expect(close).toBeFocused();

  const viewportBox = await page.getByTestId('lumora-viewport').boundingBox();
  await page.mouse.click(viewportBox!.x + 20, viewportBox!.y + 20);
  await page.keyboard.press('Escape');
  await expect(log).toBeHidden();
  await expect(header).not.toHaveAttribute('inert', '');
  await expect(toggle).toBeFocused();
});

test('375x667 expanded host log keeps the complete timeline inside Studio', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByTestId('host-log-toggle').click();
  await expect(page.getByTestId('host-event-log')).toBeVisible();
  await page.getByTestId('timeline-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const studio = rect('[data-testid="lumora-studio"]');
    const timeline = rect('[data-testid="lumora-timeline"]');
    const timelineBody = rect('[data-testid="timeline-body"]');
    const shots = rect('[data-testid="timeline-shots"]');
    return {
      studioBottom: studio.bottom,
      timelineBottom: timeline.bottom,
      timelineBodyBottom: timelineBody.bottom,
      shotsBottom: shots.bottom,
    };
  });
  expect(geometry.timelineBottom).toBeLessThanOrEqual(geometry.studioBottom + 1);
  expect(geometry.timelineBodyBottom).toBeLessThanOrEqual(geometry.studioBottom + 1);
  expect(geometry.shotsBottom).toBeLessThanOrEqual(geometry.timelineBodyBottom + 1);
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
  const studios = page.getByTestId('lumora-studio');
  await expect(studios).toHaveCount(2);
  const openers = page.getByTestId('open-plugin-manager');
  await expect(openers).toHaveCount(2);
  await clickToolbarItem(page, 'open-plugin-manager', studios.first());
  const lowerDialog = page.getByRole('dialog', { name: '插件管理' }).first();
  await openers.nth(1).evaluate((button) => button.click());
  await expect(page.getByRole('dialog', { name: '插件管理' })).toHaveCount(2);

  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog', { name: '插件管理' })).toHaveCount(1);
  await expect(lowerDialog).toBeVisible();
});

test('overwrite confirmation participates in the shared modal stack below a later command palette', async ({ page }) => {
  await page.getByTestId('editor-panel-objects').click();
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('editor-panel-scene').click();
  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
  await page.getByTestId('open-command-palette').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByTestId('command-palette')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
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
