import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { Euler, Quaternion } from 'three';

/** 标签列宽度（px），与 TimelinePanel 导出的 TIMELINE_LABEL_WIDTH 一致；
 *  播放头 = 标签列 + time * zoom，关键帧/分镜/标尺刻度 = time * zoom（时间画布内） */
const LABEL_WIDTH = 186;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
});

/** 解析「00:00.00」时间显示 → 秒 */
async function timeSeconds(page: Page): Promise<number> {
  const text = await page.getByTestId('timeline-time').textContent();
  const m = /(\d+):(\d+)\.(\d+)/.exec(text ?? '');
  if (!m) throw new Error(`无法解析时间显示: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
}

/** 选中主摄像机 → 录制（示例项目已有录制轨道 → 覆盖确认）→ 进入录制态 */
async function startRecording(page: Page): Promise<void> {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
  await page.getByText('覆盖录制').click();
  await expect(page.getByTestId('timeline-record')).toHaveText('■');
  const viewport = page.getByTestId('lumora-viewport');
  await viewport.click({ position: { x: 2, y: 2 }, modifiers: ['Control'] });
  await expect(viewport).toBeFocused();
}

/** 隐藏视口上的 DOM 覆盖层（工具条/辅助线），让 canvas 截图只含 WebGL 像素 */
async function hideViewportOverlays(page: Page): Promise<void> {
  for (const testid of ['viewport-toolbar', 'lumora-guides']) {
    const overlay = page.getByTestId(testid);
    if ((await overlay.count()) > 0) {
      await overlay.evaluate((el) => {
        (el as HTMLElement).style.display = 'none';
      });
    }
  }
}

async function focusViewportByKeyboard(page: Page): Promise<void> {
  const viewport = page.getByTestId('lumora-viewport');
  for (let index = 0; index < 100; index += 1) {
    await page.keyboard.press('Tab');
    if (await viewport.evaluate((element) => document.activeElement === element)) break;
  }
  await expect(viewport).toBeFocused();
  const focusStyle = await viewport.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);
}

/** 画布截图：先等一帧渲染（seek/暂停后场景经 rAF 重绘） */
async function canvasShot(page: Page): Promise<Buffer> {
  await waitForStableFrame(page);
  await page.waitForTimeout(120);
  return page.locator('.lumora-viewport canvas').screenshot();
}

async function waitForStableFrame(page: Page, frameCount = 2): Promise<void> {
  await page.evaluate(async (count) => {
    await new Promise<void>((resolve) => {
      let remaining = Math.max(1, count);
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, frameCount);
}

/** 播放头横向位置（行内 px，含标签列）：186 + time * zoom */
async function playheadPx(page: Page): Promise<number> {
  return page.getByTestId('timeline-playhead').evaluate((el) => parseFloat((el as HTMLElement).style.left));
}

/** 当前 zoom：点击时刻为 kfTime 的关键帧后由播放头位置反推（吸附应已关闭，跳转精确） */
async function measureZoom(page: Page, kfTestId: string, kfTime: number): Promise<number> {
  await page.getByTestId(kfTestId).click();
  const zoom = (await playheadPx(page) - LABEL_WIDTH) / kfTime;
  expect(zoom).toBeGreaterThan(20); // 合理性：默认 ~64 px/s
  return zoom;
}

/** 在标尺上点击时刻 t（吸附关闭时精确）：先把目标时刻滚动到时间线可见范围
 *  （画布内坐标 = 标签列 + time * zoom），再以时间画布的实时视口矩形计算点击位，
 *  与面板 seekFromEvent 使用同一坐标空间 */
async function seekByRuler(page: Page, t: number, zoom: number): Promise<void> {
  const body = page.getByTestId('timeline-body');
  await body.evaluate((el, targetX) => {
    el.scrollLeft = Math.max(0, targetX - el.clientWidth / 2);
  }, 186 + t * zoom);
  const timeArea = page.locator('[data-testid="timeline-ruler"] .lumora-timeline__time-area');
  const box = await timeArea.boundingBox();
  if (!box) throw new Error('标尺不可见');
  await page.mouse.click(box.x + t * zoom, box.y + box.height / 2);
}

/** 数值位姿读取：CameraPoseReadout 序列化的 JSON（e2e 数值断言，复审 AC 补强） */
async function cameraPose(
  page: Page,
  cameraId = 'sample-camera',
): Promise<{ position: [number, number, number]; rotation: [number, number, number]; focalLength: number | null }> {
  await waitForStableFrame(page);
  const text = await page.getByTestId('camera-pose-readout').textContent();
  if (!text) throw new Error('位姿读取钩子不可用');
  const pose = JSON.parse(text)[cameraId];
  if (!pose) throw new Error(`机位 ${cameraId} 不在位姿钩子输出中`);
  return pose;
}

async function stableCameraPose(
  page: Page,
  cameraId = 'sample-camera',
): ReturnType<typeof cameraPose> {
  let previous = await cameraPose(page, cameraId);
  let stableSamples = 0;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const current = await cameraPose(page, cameraId);
    const focalDelta = Math.abs((current.focalLength ?? 0) - (previous.focalLength ?? 0));
    if (
      vectorDistance(current.position, previous.position) < 0.00001 &&
      quaternionAngle(current.rotation, previous.rotation) < 0.00001 &&
      focalDelta < 0.00001
    ) {
      stableSamples += 1;
      if (stableSamples >= 2) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }
  throw new Error(`机位 ${cameraId} 未在稳定帧窗口内静止`);
}

async function rightDrag(
  page: Page,
  viewport: ReturnType<Page['getByTestId']>,
  options: { leaveViewport?: boolean } = {},
): Promise<boolean> {
  const viewportBounds = await viewport.boundingBox();
  if (!viewportBounds) throw new Error('viewport is unavailable');
  const pageViewport = page.viewportSize();
  if (!pageViewport) throw new Error('page viewport is unavailable');
  const contextMenu = page.evaluate(() => new Promise<boolean>((resolve) => {
    const handler = (event: MouseEvent) => {
      cleanup();
      resolve(event.defaultPrevented);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, 1_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      document.removeEventListener('contextmenu', handler);
    };
    document.addEventListener('contextmenu', handler);
  }));
  const visibleLeft = Math.max(0, viewportBounds.x);
  const visibleTop = Math.max(0, viewportBounds.y);
  const visibleRight = Math.min(pageViewport.width, viewportBounds.x + viewportBounds.width);
  const visibleBottom = Math.min(pageViewport.height, viewportBounds.y + viewportBounds.height);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) throw new Error('viewport has no visible hit area');
  const startX = visibleLeft + (visibleRight - visibleLeft) * 0.42;
  const startY = visibleTop + (visibleBottom - visibleTop) * 0.52;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(
    startX + viewportBounds.width * 0.18,
    startY - viewportBounds.height * 0.1,
    { steps: 8 },
  );
  if (options.leaveViewport) {
    const toolbarBounds = await page.getByTestId('lumora-toolbar').boundingBox();
    if (!toolbarBounds) throw new Error('toolbar is unavailable');
    await page.mouse.move(toolbarBounds.x + 8, toolbarBounds.y + toolbarBounds.height / 2, { steps: 4 });
  }
  await page.mouse.up({ button: 'right' });
  await waitForStableFrame(page);
  return contextMenu;
}

async function moveReactRootIntoOpenShadowRoot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reactRoot = document.getElementById('root');
    if (!reactRoot) throw new Error('React root is missing');
    const host = document.createElement('div');
    host.dataset.testid = 'e2e-shadow-host';
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).append(reactRoot);
  });
}

function vectorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(...a.map((value, index) => value - (b[index] ?? 0)));
}

function quaternionAngle(a: readonly number[], b: readonly number[]): number {
  const qa = new Quaternion().setFromEuler(new Euler(a[0], a[1], a[2], 'XYZ'));
  const qb = new Quaternion().setFromEuler(new Euler(b[0], b[1], b[2], 'XYZ'));
  return qa.angleTo(qb);
}

async function setRange(page: Page, testId: string, value: number): Promise<void> {
  const input = page.getByTestId(testId);
  await input.fill(String(value));
  await expect(input).toHaveValue(String(value));
}

/** 两张 PNG 截图的像素差异比例（0..1）：任一通道差绝对值之和 > 30 的像素占比；
 *  在页面内用 canvas 解码比对（两帧经同一截图管线，编码参数一致） */
async function pixelDiffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    ([a64, b64]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${src}`;
        });
      return (async () => {
        const [ia, ib] = await Promise.all([load(a64), load(b64)]);
        const w = Math.min(ia.width, ib.width);
        const h = Math.min(ia.height, ib.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(ia, 0, 0, w, h);
        const da = ctx.getImageData(0, 0, w, h).data;
        ctx.drawImage(ib, 0, 0, w, h);
        const db = ctx.getImageData(0, 0, w, h).data;
        let diff = 0;
        for (let i = 0; i < da.length; i += 4) {
          const delta =
            Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!);
          if (delta > 30) diff += 1;
        }
        return diff / (da.length / 4);
      })();
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

async function shotLeft(page: Page, shotId: string): Promise<number> {
  return page.getByTestId(`shot-block-${shotId}`).evaluate((el) => parseFloat((el as HTMLElement).style.left));
}

async function expectShotLeft(page: Page, shotId: string, expectedPx: number): Promise<void> {
  const actual = await shotLeft(page, shotId);
  expect(Math.abs(actual - expectedPx)).toBeLessThan(1);
}

test('idle director view drives the rendered camera and reports its heading', async ({ page }) => {
  const viewport = page.getByTestId('lumora-viewport');
  await expect(page.getByTestId('view-mode-select')).toHaveValue('director');
  await hideViewportOverlays(page);
  await focusViewportByKeyboard(page);

  const indicator = page.getByTestId('camera-direction-indicator');
  const status = page.getByTestId('camera-direction-status');
  const arrow = page.locator('.lumora-camera-direction__arrow');
  await expect(indicator).toBeVisible();
  await expect(status).toHaveText(/^Heading \d+ deg \| Pitch [+-]?\d+ deg$/);
  await expect(arrow).toBeVisible();
  const viewportBounds = await viewport.boundingBox();
  const indicatorBounds = await indicator.boundingBox();
  if (!viewportBounds || !indicatorBounds) throw new Error('direction indicator bounds are unavailable');
  expect(indicatorBounds.x).toBeGreaterThanOrEqual(viewportBounds.x);
  expect(indicatorBounds.x + indicatorBounds.width).toBeLessThanOrEqual(viewportBounds.x + viewportBounds.width);
  expect(indicatorBounds.y).toBeGreaterThanOrEqual(viewportBounds.y);
  expect(indicatorBounds.y + indicatorBounds.height).toBeLessThanOrEqual(viewportBounds.y + viewportBounds.height);
  const initialStatus = await status.textContent();
  const initialArrowTransform = await arrow.evaluate((element) => (element as HTMLElement).style.transform);
  const beforeDrive = await canvasShot(page);

  await page.keyboard.down('w');
  await page.waitForTimeout(220);
  await page.keyboard.up('w');
  await page.waitForTimeout(100);
  const afterDrive = await canvasShot(page);
  expect(await pixelDiffRatio(page, beforeDrive, afterDrive)).toBeGreaterThan(0.005);

  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport is unavailable');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.45, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await expect(status).not.toHaveText(initialStatus ?? '');
  await expect.poll(() => arrow.evaluate((element) => (element as HTMLElement).style.transform))
    .not.toBe(initialArrowTransform);
});

test('camera takeover guidance and viewport context-menu suppression follow the active owner', async ({ page }) => {
  const viewport = page.getByTestId('lumora-viewport');

  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  const status = page.getByTestId('camera-control-status');
  await expect(status).toContainText('主摄像机推镜');
  await expect(status).toContainText('主摄像机变焦');
  await expect(status).not.toContainText('立方体旋转');
  expect(await rightDrag(page, viewport)).toBe(true);

  await page.getByRole('button', { name: /定位轨道/ }).click();
  await expect(page.getByTestId('track-disabled-sample-track-camera-dolly')).toBeFocused();
  await page.getByTestId('track-disabled-sample-track-camera-dolly').check();
  await page.getByTestId('track-disabled-sample-track-camera-focus').check();
  await expect(status).toHaveText('机位“主摄像机”可手动操控。');

  await page.getByTestId('timeline-play').click();
  await expect(status).toContainText('播放正在接管机位；暂停播放后可手动操控。');
  expect(await rightDrag(page, viewport)).toBe(true);
  await page.getByTestId('timeline-play').click();

  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  const exportStatus = page.getByTestId('export-camera-control-status');
  await expect(exportStatus).toBeVisible();
  await expect(exportStatus).toContainText('导出工作区正在接管视口；关闭导出工作区后可手动操控。');
  expect(await rightDrag(page, viewport)).toBe(true);
});

test('real right-drag drives only an unblocked POV and suppresses complete gestures', async ({ page }) => {
  const viewport = page.getByTestId('lumora-viewport');
  const status = page.getByTestId('camera-control-status');
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  const dolly = page.getByTestId('track-disabled-sample-track-camera-dolly');
  const focus = page.getByTestId('track-disabled-sample-track-camera-focus');

  await dolly.check();
  await focus.check();
  await expect(status).toHaveText('机位“主摄像机”可手动操控。');
  const freeBefore = await stableCameraPose(page);
  expect(await rightDrag(page, viewport)).toBe(true);
  const freeAfter = await stableCameraPose(page);
  expect(vectorDistance(freeAfter.position, freeBefore.position)).toBeLessThan(0.000001);
  expect(quaternionAngle(freeAfter.rotation, freeBefore.rotation)).toBeGreaterThan(0.001);

  await dolly.uncheck();
  await focus.uncheck();
  const trackBefore = await stableCameraPose(page);
  expect(await rightDrag(page, viewport)).toBe(true);
  const trackAfter = await stableCameraPose(page);
  expect(vectorDistance(trackAfter.position, trackBefore.position)).toBeLessThan(0.000001);
  expect(quaternionAngle(trackAfter.rotation, trackBefore.rotation)).toBeLessThan(0.000001);

  await page.getByTestId('view-mode-select').selectOption('director');
  await page.getByTestId('timeline-play').click();
  const playbackBefore = await stableCameraPose(page, '__rendered__');
  expect(await rightDrag(page, viewport)).toBe(true);
  const playbackAfter = await stableCameraPose(page, '__rendered__');
  expect(vectorDistance(playbackAfter.position, playbackBefore.position)).toBeLessThan(0.000001);
  expect(quaternionAngle(playbackAfter.rotation, playbackBefore.rotation)).toBeLessThan(0.000001);
  await page.getByTestId('timeline-play').click();

  const resumedBefore = await stableCameraPose(page, '__rendered__');
  expect(await rightDrag(page, viewport)).toBe(true);
  const resumedAfter = await stableCameraPose(page, '__rendered__');
  expect(quaternionAngle(resumedAfter.rotation, resumedBefore.rotation)).toBeGreaterThan(0.001);

  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  const viewportBounds = await viewport.boundingBox();
  if (!viewportBounds) throw new Error('viewport is unavailable under export overlay');
  const exportOverlayOwnsViewportPoint = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit?.closest('[data-testid="export-workspace"]') !== null;
  }, {
    x: viewportBounds.x + viewportBounds.width * 0.42,
    y: viewportBounds.y + viewportBounds.height * 0.52,
  });
  expect(exportOverlayOwnsViewportPoint).toBe(true);
  const exportBefore = await stableCameraPose(page, '__rendered__');
  expect(await rightDrag(page, viewport)).toBe(true);
  const exportAfter = await stableCameraPose(page, '__rendered__');
  expect(vectorDistance(exportAfter.position, exportBefore.position)).toBeLessThan(0.000001);
  expect(quaternionAngle(exportAfter.rotation, exportBefore.rotation)).toBeLessThan(0.000001);

  await page.getByRole('button', { name: '关闭导出' }).click();
  const outOfViewportBefore = await stableCameraPose(page, '__rendered__');
  expect(await rightDrag(page, viewport, { leaveViewport: true })).toBe(true);
  const outOfViewportAfter = await stableCameraPose(page, '__rendered__');
  expect(quaternionAngle(outOfViewportAfter.rotation, outOfViewportBefore.rotation)).toBeGreaterThan(0.001);
});

test('suppresses an out-of-bounds release from an open ShadowRoot viewport', async ({ page }) => {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await expect(page.getByTestId('camera-control-status')).toContainText('主摄像机推镜');
  await moveReactRootIntoOpenShadowRoot(page);
  const viewport = page.getByTestId('lumora-viewport');
  await expect(viewport).toBeVisible();
  await waitForStableFrame(page);
  expect(await rightDrag(page, viewport, { leaveViewport: true })).toBe(true);
});

test('does not expire a long-held right-drag before releasing outside the viewport', async ({ page }) => {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await expect(page.getByTestId('camera-control-status')).toContainText('主摄像机推镜');
  const viewport = page.getByTestId('lumora-viewport');
  const bounds = await viewport.boundingBox();
  const toolbar = await page.getByTestId('lumora-toolbar').boundingBox();
  if (!bounds || !toolbar) throw new Error('viewport or toolbar is unavailable');
  const contextMenu = page.evaluate(() => new Promise<boolean>((resolve) => {
    const handler = (event: MouseEvent) => {
      document.removeEventListener('contextmenu', handler);
      resolve(event.defaultPrevented);
    };
    document.addEventListener('contextmenu', handler);
    window.setTimeout(() => {
      document.removeEventListener('contextmenu', handler);
      resolve(false);
    }, 4_000);
  }));
  const startX = bounds.x + bounds.width * 0.5;
  const startY = bounds.y + bounds.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(2_300);
  await page.mouse.move(toolbar.x + 8, toolbar.y + toolbar.height / 2, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  expect(await contextMenu).toBe(true);
});

test('allows a new outside right-click after an orphaned viewport pointerdown', async ({ page }) => {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await expect(page.getByTestId('camera-control-status')).toContainText('主摄像机推镜');
  const viewport = page.getByTestId('lumora-viewport');
  const viewportBounds = await viewport.boundingBox();
  const toolbarBounds = await page.getByTestId('lumora-toolbar').boundingBox();
  if (!viewportBounds || !toolbarBounds) throw new Error('viewport or toolbar is unavailable');
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraOutsidePointerDowns?: number;
      __lumoraOutsideContextMenus?: boolean[];
    };
    scope.__lumoraOutsidePointerDowns = 0;
    scope.__lumoraOutsideContextMenus = [];
    window.addEventListener('pointerdown', (event) => {
      const target = event.composedPath()[0];
      if (target instanceof Element && target.closest('[data-testid="lumora-toolbar"]')) {
        scope.__lumoraOutsidePointerDowns! += 1;
      }
    }, true);
    window.addEventListener('contextmenu', (event) => {
      const target = event.composedPath()[0];
      if (target instanceof Element && target.closest('[data-testid="lumora-toolbar"]')) {
        scope.__lumoraOutsideContextMenus!.push(event.defaultPrevented);
      }
    });
  });

  // Seed the abnormal state directly: a real browser cannot begin a second
  // physical right-click until the first button is released, while the bug is
  // specifically that the application missed that terminating event.
  await viewport.dispatchEvent('pointerdown', {
    bubbles: true,
    composed: true,
    pointerId: 91,
    pointerType: 'mouse',
    button: 2,
    buttons: 2,
    clientX: viewportBounds.x + viewportBounds.width * 0.5,
    clientY: viewportBounds.y + viewportBounds.height * 0.5,
  });
  await page.mouse.click(toolbarBounds.x + 8, toolbarBounds.y + toolbarBounds.height / 2, { button: 'right' });

  const result = await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraOutsidePointerDowns?: number;
      __lumoraOutsideContextMenus?: boolean[];
    };
    return {
      pointerDowns: scope.__lumoraOutsidePointerDowns ?? 0,
      contextMenus: scope.__lumoraOutsideContextMenus ?? [],
    };
  });
  expect(result.pointerDowns).toBeGreaterThan(0);
  expect(result.contextMenus).toContain(false);
});

test('director free-drive orientation remains stable across pixel and line-mode wheel gestures', async ({ page }) => {
  const viewport = page.getByTestId('lumora-viewport');
  await hideViewportOverlays(page);
  await focusViewportByKeyboard(page);
  const status = page.getByTestId('camera-direction-status');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport is unavailable');

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.45, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  // Pointer-look smoothing must settle before OrbitControls is authoritative again.
  await page.waitForTimeout(1_600);
  await expect(status).toHaveText(/Heading \d+ deg \| Pitch [+-]?\d+ deg/);
  const afterLook = await status.textContent();
  const beforeWheel = await cameraPose(page, '__rendered__');

  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(500);

  await expect(status).toHaveText(afterLook ?? '');
  const afterWheel = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterWheel.position, beforeWheel.position)).toBeGreaterThan(0.01);
  expect(quaternionAngle(afterWheel.rotation, beforeWheel.rotation)).toBeLessThan(0.001);

  await page.locator('canvas').first().dispatchEvent('wheel', {
    deltaY: -3,
    deltaMode: 1,
    clientX: box.x + box.width * 0.5,
    clientY: box.y + box.height * 0.55,
  });
  await page.waitForTimeout(500);

  const afterLineWheel = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterLineWheel.position, afterWheel.position)).toBeGreaterThan(0.01);
  expect(quaternionAngle(afterLineWheel.rotation, afterWheel.rotation)).toBeLessThan(0.001);
  await expect(status).toHaveText(afterLook ?? '');

  const beforeFractionalWheel = afterLineWheel;
  for (let index = 0; index < 8; index += 1) {
    await page.locator('canvas').first().dispatchEvent('wheel', {
      deltaY: 0.75,
      deltaMode: 0,
      clientX: box.x + box.width * 0.5,
      clientY: box.y + box.height * 0.55,
    });
  }
  await page.waitForTimeout(500);

  const afterFractionalWheel = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterFractionalWheel.position, beforeFractionalWheel.position)).toBeGreaterThan(0.01);
  expect(quaternionAngle(afterFractionalWheel.rotation, beforeFractionalWheel.rotation)).toBeLessThan(0.001);
  await expect(status).toHaveText(afterLook ?? '');
});

test('director keyboard-only mode ignores pointer and wheel input while preserving arrow rotation', async ({ page }) => {
  const modeButton = page.getByRole('button', { name: '纯键盘操控' });
  await modeButton.click();
  await expect(modeButton).toHaveAttribute('aria-pressed', 'true');

  const viewport = page.getByTestId('lumora-viewport');
  const canvas = page.locator('.lumora-viewport canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas is unavailable');
  await page.waitForTimeout(120);
  const start = await cameraPose(page, '__rendered__');

  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.35, { steps: 6 });
  await page.mouse.up({ button: 'left' });
  await page.mouse.wheel(0, 240);
  for (let index = 0; index < 8; index += 1) {
    await canvas.dispatchEvent('wheel', {
      deltaY: 0.75,
      deltaMode: 0,
      clientX: box.x + box.width * 0.5,
      clientY: box.y + box.height * 0.5,
    });
  }
  await page.waitForTimeout(500);

  const afterPointer = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterPointer.position, start.position)).toBeLessThan(0.001);
  expect(quaternionAngle(afterPointer.rotation, start.rotation)).toBeLessThan(0.001);

  await focusViewportByKeyboard(page);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(260);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(100);

  const afterArrow = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterArrow.position, afterPointer.position)).toBeLessThan(0.01);
  expect(quaternionAngle(afterArrow.rotation, afterPointer.rotation)).toBeGreaterThan(0.03);
  await expect(viewport).toBeFocused();
});

test('director OrbitControls requires a fresh pointerdown after an input-mode boundary', async ({ page }) => {
  const canvas = page.locator('.lumora-viewport canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas is unavailable');
  const keyboardOnly = page.getByRole('button', { name: '纯键盘操控' });
  const keyboardMouse = page.getByRole('button', { name: '键盘移动 + 鼠标视角' });

  const startX = box.x + box.width * 0.7;
  const startY = box.y + box.height * 0.3;
  await expect(page.getByTestId('camera-pose-readout')).not.toHaveText('');
  await page.mouse.move(startX, startY);
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(startX - 60, startY + 30, { steps: 4 });
  await page.mouse.up({ button: 'left' });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  const beforeGesture = await cameraPose(page, '__rendered__');
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(startX - 30, startY + 15, { steps: 3 });
  await page.waitForTimeout(120);
  const duringGesture = await cameraPose(page, '__rendered__');
  expect(quaternionAngle(duringGesture.rotation, beforeGesture.rotation)).toBeGreaterThan(0.01);
  await page.waitForTimeout(1_600);
  const beforeBoundary = await cameraPose(page, '__rendered__');

  await keyboardOnly.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(keyboardOnly).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(100);
  await keyboardMouse.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(keyboardMouse).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(100);

  const afterBoundary = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterBoundary.position, beforeBoundary.position)).toBeLessThan(0.01);
  expect(quaternionAngle(afterBoundary.rotation, beforeBoundary.rotation)).toBeLessThan(0.001);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.7, { steps: 6 });
  await page.waitForTimeout(300);
  const afterStaleMove = await cameraPose(page, '__rendered__');
  expect(vectorDistance(afterStaleMove.position, afterBoundary.position)).toBeLessThan(0.001);
  expect(quaternionAngle(afterStaleMove.rotation, afterBoundary.rotation)).toBeLessThan(0.001);
  await page.mouse.up({ button: 'left' });

  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55, { steps: 6 });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(300);
  const afterFreshDrag = await cameraPose(page, '__rendered__');
  expect(quaternionAngle(afterFreshDrag.rotation, afterStaleMove.rotation)).toBeGreaterThan(0.03);
});

test('overwrite confirmation portal retains resolved Studio theme styles', async ({ page }) => {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('timeline-record').click();
  const overlay = page.getByTestId('overwrite-confirm');
  await expect(overlay).toBeVisible();

  const styles = await overlay.evaluate((element) => {
    const overlayStyle = getComputedStyle(element);
    const modal = element.querySelector<HTMLElement>('.lumora-timeline__modal')!;
    const button = modal.querySelector<HTMLElement>('.lumora-button')!;
    const modalStyle = getComputedStyle(modal);
    const buttonStyle = getComputedStyle(button);
    return {
      surfaceVariable: overlayStyle.getPropertyValue('--lumora-surface-2').trim(),
      modalBackground: modalStyle.backgroundColor,
      modalBorderStyle: modalStyle.borderTopStyle,
      modalBorderWidth: modalStyle.borderTopWidth,
      buttonBackground: buttonStyle.backgroundColor,
      buttonBorderStyle: buttonStyle.borderTopStyle,
      buttonColor: buttonStyle.color,
    };
  });
  expect(styles.surfaceVariable).toBe('#232734');
  expect(styles.modalBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.modalBorderStyle).toBe('solid');
  expect(styles.modalBorderWidth).toBe('1px');
  expect(styles.buttonBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.buttonBorderStyle).toBe('solid');
  expect(styles.buttonColor).not.toBe('rgba(0, 0, 0, 0)');
  await page.getByText('取消').click();
});

test('offscreen capture preserves a non-default cube face/mip and encodes real WebGL pixels upright', async ({ page }, testInfo) => {
  // This regression imports source modules through Vite's /@fs endpoint,
  // which is intentionally unavailable in the production preview server.
  test.skip(testInfo.project.name === 'edge-preview', 'source-module import requires the Vite dev server');
  const frameCaptureUrl = `/@fs/${resolve('packages/studio/src/components/editor/frame-capture.ts').replace(/\\/g, '/')}`;
  const threeUrl = `/@fs/${resolve('node_modules/three/build/three.module.js').replace(/\\/g, '/')}`;
  const result = await page.evaluate(
    async ({ frameCaptureUrl, threeUrl }) => {
      const THREE = await import(threeUrl);
      const { captureProjectFrame } = (await import(frameCaptureUrl)) as {
        captureProjectFrame: (
          renderer: InstanceType<typeof THREE.WebGLRenderer>,
          scene: InstanceType<typeof THREE.Scene>,
          camera: InstanceType<typeof THREE.Camera>,
          aspect: number,
        ) => string | null;
      };
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      renderer.setPixelRatio(1);
      renderer.setSize(64, 64, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const defaultViewport = [7, 8, 40, 36];
      const defaultScissor = [5, 6, 30, 28];
      const targetViewport = [2, 3, 20, 18];
      const targetScissor = [1, 2, 16, 14];
      const cubeTarget = new THREE.WebGLCubeRenderTarget(64, {
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
      });
      cubeTarget.viewport.fromArray(targetViewport);
      cubeTarget.scissor.fromArray(targetScissor);
      cubeTarget.scissorTest = true;

      const bindOriginalState = (face: number) => {
        renderer.setRenderTarget(null);
        renderer.setViewport(...defaultViewport);
        renderer.setScissor(...defaultScissor);
        renderer.setScissorTest(true);
        renderer.setRenderTarget(cubeTarget, face, 1);
      };
      const values = (vector: { toArray: () => number[] }) => vector.toArray();
      const snapshot = () => {
        const gl = renderer.getContext();
        return {
          target: renderer.getRenderTarget() === cubeTarget,
          face: renderer.getActiveCubeFace(),
          mip: renderer.getActiveMipmapLevel(),
          defaultViewport: values(renderer.getViewport(new THREE.Vector4())),
          defaultScissor: values(renderer.getScissor(new THREE.Vector4())),
          defaultScissorTest: renderer.getScissorTest(),
          currentViewport: values(renderer.getCurrentViewport(new THREE.Vector4())),
          glScissor: Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array),
          glScissorTest: gl.isEnabled(gl.SCISSOR_TEST),
        };
      };

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#000000');
      const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 10);
      camera.position.z = 2;
      const geometry = new THREE.PlaneGeometry(3, 0.94);
      const top = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#ff0000' }));
      top.position.y = 0.47;
      const bottom = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#0000ff' }));
      bottom.position.y = -0.47;
      scene.add(top, bottom);

      bindOriginalState(3);
      const png = captureProjectFrame(renderer, scene, camera, 1);
      if (!png) throw new Error('real WebGL capture returned null');
      const image = await new Promise<HTMLImageElement>((resolveImage, rejectImage) => {
        const next = new Image();
        next.onload = () => resolveImage(next);
        next.onerror = rejectImage;
        next.src = png;
      });
      const decodeCanvas = document.createElement('canvas');
      decodeCanvas.width = image.width;
      decodeCanvas.height = image.height;
      const context = decodeCanvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const sample = (x: number, y: number) =>
        Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
      const successState = snapshot();

      bindOriginalState(5);
      const realRender = renderer.render.bind(renderer);
      renderer.render = () => {
        throw new Error('forced render failure');
      };
      const failedCapture = captureProjectFrame(renderer, scene, camera, 1);
      renderer.render = realRender;
      const failureState = snapshot();

      top.material.dispose();
      bottom.material.dispose();
      geometry.dispose();
      cubeTarget.dispose();
      renderer.dispose();
      canvas.remove();
      return {
        size: [image.width, image.height],
        top: sample(Math.floor(image.width / 2), Math.floor(image.height / 4)),
        bottom: sample(Math.floor(image.width / 2), Math.floor((image.height * 3) / 4)),
        successState,
        failedCapture,
        failureState,
        defaultViewport,
        defaultScissor,
        targetViewport,
        targetScissor,
      };
    },
    { frameCaptureUrl, threeUrl },
  );

  expect(result.size).toEqual([320, 320]);
  expect(result.top[0]).toBeGreaterThan(180);
  expect(result.top[1]).toBeLessThan(80);
  expect(result.top[2]).toBeLessThan(80);
  expect(result.bottom[0]).toBeLessThan(80);
  expect(result.bottom[1]).toBeLessThan(80);
  expect(result.bottom[2]).toBeGreaterThan(180);
  expect(result.successState).toEqual({
    target: true,
    face: 3,
    mip: 1,
    defaultViewport: result.defaultViewport,
    defaultScissor: result.defaultScissor,
    defaultScissorTest: true,
    currentViewport: result.targetViewport,
    glScissor: result.targetScissor,
    glScissorTest: true,
  });
  expect(result.failedCapture).toBeNull();
  expect(result.failureState).toEqual({
    target: true,
    face: 5,
    mip: 1,
    defaultViewport: result.defaultViewport,
    defaultScissor: result.defaultScissor,
    defaultScissorTest: true,
    currentViewport: result.targetViewport,
    glScissor: result.targetScissor,
    glScissorTest: true,
  });
});

test('AC1 浏览器级：真实约 5s 持续驾驶录制 → 抽稀覆盖轨道 → 晚段位姿 late delta + 两次回放同一确定终点严格一致', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera'); // 主摄像机 POV
  await startRecording(page);
  await hideViewportOverlays(page);

  // 真实约 5s 持续驾驶输入（KeyS 后退按住）：录制后半段仍持续位移（复审 AC 补强）——
  // ~1s / ~2.5s / ~4.5s 三张画面逐步不同（而非仅开头有运动）；
  // 后退保持场景物体始终在视锥内（前进 ~2.8s 后物体出镜，只剩纯色地面，画面逐帧相同）
  await page.keyboard.down('s');
  await page.waitForTimeout(1000);
  const rec1 = await canvasShot(page);
  await page.waitForTimeout(1500);
  const rec25 = await canvasShot(page);
  await page.waitForTimeout(2000);
  const rec45 = await canvasShot(page);
  await page.keyboard.up('s');
  expect(rec25.equals(rec1)).toBe(false);
  expect(rec45.equals(rec25)).toBe(false);
  await page.getByTestId('timeline-record').click(); // ■ = 停止
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');

  // 位置轨道被抽稀覆盖：2-10 个关键帧、首帧≈0、末帧≈5s；旧 4s 关键帧消失
  const dollyKfs = page.locator('[data-testid^="keyframe-sample-track-camera-dolly-"]');
  const kfCount = await dollyKfs.count();
  expect(kfCount).toBeGreaterThanOrEqual(2);
  expect(kfCount).toBeLessThanOrEqual(10);
  await expect(page.getByTestId('keyframe-sample-track-camera-dolly-4')).toHaveCount(0);
  const kfTimes = await dollyKfs.evaluateAll((els) =>
    els.map((el) =>
      Number(/keyframe-sample-track-camera-dolly-([0-9.]+)$/.exec(el.getAttribute('data-testid') ?? '')?.[1]),
    ),
  );
  expect(Math.min(...kfTimes)).toBeLessThan(0.1);
  const lastKfTime = Math.max(...kfTimes);
  expect(lastKfTime).toBeGreaterThan(4.7);
  expect(lastKfTime).toBeLessThan(5.6);

  // 关闭吸附 → 坐标换算精确
  await page.getByTestId('timeline-snap').setChecked(false);
  const zoom = await measureZoom(page, `keyframe-sample-track-camera-dolly-${lastKfTime}`, lastKfTime);

  // 回到起点 → 起点画面 + 起点数值位姿
  await seekByRuler(page, 0.02, zoom);
  const s0 = await canvasShot(page);
  const pose0 = await cameraPose(page);

  // 晚于故障阈值（~3.5s）的两个时点直接读 camera pose 断言 late delta：
  // 示例 cube 自身 0-4s 有旋转轨道，仅画面变化无法证明相机在动（复审阻断 5
  // 反例：相机自 3.5s 起停住，2.5→4.5 画面仍变）；相机位姿是直接证据 ——
  // 后段关键帧错位/平台化时 4.0 与 4.5 的插值位姿相同或滞留。驾驶约 2.5m/s
  // 持续后移 → 0.5s 理论位移 ~1.25m，阈值 0.25m 留 5 倍余量
  await seekByRuler(page, 4.0, zoom);
  const pose40 = await cameraPose(page);
  const p40 = await canvasShot(page);
  await seekByRuler(page, 4.5, zoom);
  const pose45 = await cameraPose(page);
  const p45 = await canvasShot(page);
  expect(Math.abs(pose45.position[2]! - pose40.position[2]!)).toBeGreaterThan(0.25);
  expect(Math.abs(pose45.rotation[0]! - pose40.rotation[0]!)).toBeLessThan(0.05); // 驾驶仅平移
  expect(p45.equals(p40)).toBe(false);

  // Two independent real playbacks: start at zero, run to the natural non-looping
  // endpoint, and read immediately. No endpoint seek is allowed in this helper.
  await page.getByTestId('timeline-loop').setChecked(false);
  const playToNaturalEnd = async () => {
    await seekByRuler(page, 0, zoom);
    await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
    const play = page.getByTestId('timeline-play');
    await play.click();
    await expect(play).toHaveAttribute('title', '暂停（空格）');
    await expect(play).toHaveAttribute('title', '播放（空格）', { timeout: 10_000 });
    const endTime = await timeSeconds(page);
    expect(Math.abs(endTime - lastKfTime)).toBeLessThan(0.08);
    const pose = await cameraPose(page);
    const pixels = await canvasShot(page);
    return { endTime, pose, pixels };
  };

  const runA = await playToNaturalEnd();
  expect(Math.abs(runA.pose.position[2]! - pose0.position[2]!)).toBeGreaterThan(0.5);
  expect(runA.pixels.equals(s0)).toBe(false);
  const runB = await playToNaturalEnd();
  expect(runB.endTime).toBe(runA.endTime);
  expect(runB.pose.position).toEqual(runA.pose.position);
  expect(runB.pose.rotation).toEqual(runA.pose.rotation);
  expect(runB.pose.focalLength).toEqual(runA.pose.focalLength);
  const diffEnd = await pixelDiffRatio(page, runA.pixels, runB.pixels);
  expect(diffEnd).toBeLessThan(0.01);
});

test('recording control: keyboard-mouse mode records deterministic tap, smooth hold, and bounded look', async ({ page }) => {
  await setRange(page, 'camera-control-speed', 3);
  await setRange(page, 'camera-control-tap-step', 0.2);
  await setRange(page, 'camera-control-sensitivity', 1.4);
  await startRecording(page);
  const viewport = page.getByTestId('lumora-viewport');
  const start = await cameraPose(page);

  await page.keyboard.down('w');
  await page.waitForTimeout(50);
  await page.keyboard.up('w');
  await page.waitForTimeout(120);
  const afterTap = await cameraPose(page);
  expect(vectorDistance(afterTap.position, start.position)).toBeGreaterThan(0.17);
  expect(vectorDistance(afterTap.position, start.position)).toBeLessThan(0.23);

  await page.keyboard.down('d');
  await page.waitForTimeout(320);
  const holdMid = await cameraPose(page);
  await page.waitForTimeout(360);
  const holdLate = await cameraPose(page);
  await page.keyboard.up('d');
  expect(vectorDistance(holdMid.position, afterTap.position)).toBeGreaterThan(0.2);
  expect(vectorDistance(holdLate.position, holdMid.position)).toBeGreaterThan(0.35);
  expect(vectorDistance(holdLate.rotation, start.rotation)).toBeLessThan(0.001);

  await page.waitForTimeout(800);
  const box = await viewport.boundingBox();
  if (!box) throw new Error('视口不可见');
  const lookStart = await cameraPose(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 30, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(240);
  const afterLook = await cameraPose(page);
  expect(vectorDistance(afterLook.position, lookStart.position)).toBeLessThan(0.01);
  expect(vectorDistance(afterLook.rotation, lookStart.rotation)).toBeGreaterThan(0.03);

  if (process.env.RECORDING_CONTROL_EVIDENCE === '1') {
    await page.screenshot({
      fullPage: true,
      path: resolve('test-results/edge-recording-controls-desktop.png'),
    });
    await page.setViewportSize({ width: 760, height: 800 });
    await page.getByTestId('timeline-record').scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    await page.screenshot({
      fullPage: true,
      path: resolve('test-results/edge-recording-controls-760px.png'),
    });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByTestId('timeline-record').scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    await page.screenshot({
      fullPage: true,
      path: resolve('test-results/edge-recording-controls-375px.png'),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
  const positionLane = page.getByTestId('track-lane-sample-track-camera-dolly');
  const rotationLane = page.locator('.lumora-timeline__lane').filter({ hasText: '录制主摄像机·旋转' });
  await expect(positionLane).toHaveCount(1);
  await expect(rotationLane).toHaveCount(1);
  const positionKeys = positionLane.locator('.lumora-timeline__keyframe');
  const positionCount = await positionKeys.count();
  expect(positionCount).toBeGreaterThanOrEqual(3);
  const recordedPositionSamples = await positionKeys.evaluateAll((elements) => {
    const prefix = 'keyframe-sample-track-camera-dolly-';
    return elements.map((element) => ({
      time: Number((element.getAttribute('data-testid') ?? '').slice(prefix.length)),
      value: JSON.parse(element.getAttribute('data-keyframe-value') ?? '[]') as number[],
    }));
  });
  const sampledTap = recordedPositionSamples.reduce((closest, sample) =>
    vectorDistance(sample.value, afterTap.position) < vectorDistance(closest.value, afterTap.position)
      ? sample
      : closest,
  ).value;
  const sampledLateHold = recordedPositionSamples.reduce((closest, sample) =>
    vectorDistance(sample.value, holdLate.position) < vectorDistance(closest.value, holdLate.position)
      ? sample
      : closest,
  ).value;
  expect(vectorDistance(sampledTap, afterTap.position)).toBeLessThan(0.05);
  expect(vectorDistance(sampledTap, start.position)).toBeGreaterThan(0.17);
  expect(vectorDistance(sampledTap, start.position)).toBeLessThan(0.23);
  expect(vectorDistance(sampledLateHold, holdLate.position)).toBeLessThan(0.12);
  expect(vectorDistance(sampledLateHold, sampledTap)).toBeGreaterThan(0.5);
  for (let index = 1; index < recordedPositionSamples.length; index += 1) {
    const previous = recordedPositionSamples[index - 1]!;
    const current = recordedPositionSamples[index]!;
    const elapsed = current.time - previous.time;
    expect(vectorDistance(current.value, previous.value)).toBeLessThanOrEqual(0.23 + 3.1 * elapsed);
  }
  const rotationKeys = rotationLane.locator('.lumora-timeline__keyframe');
  const rotationCount = await rotationKeys.count();
  expect(rotationCount).toBeGreaterThanOrEqual(2);
  const rotations = await rotationKeys.evaluateAll((elements) =>
    elements.map((element) => JSON.parse(element.getAttribute('data-keyframe-value') ?? '[]') as number[]),
  );
  const sampledLook = rotations.reduce((closest, rotation) =>
    vectorDistance(rotation, afterLook.rotation) < vectorDistance(closest, afterLook.rotation)
      ? rotation
      : closest,
  );
  expect(vectorDistance(sampledLook, afterLook.rotation)).toBeLessThan(0.05);
  expect(vectorDistance(sampledLook, start.rotation)).toBeGreaterThan(0.03);
  const adjacentRotationDeltas = rotations.slice(1).map((rotation, index) =>
    vectorDistance(rotation, rotations[index]!),
  );
  expect(Math.max(...adjacentRotationDeltas)).toBeLessThan(0.5);
});

test('recording control stays bound to its camera across camera selection and deselection', async ({ page }) => {
  await startRecording(page);
  const recordingStart = await cameraPose(page, 'sample-camera');
  const otherStart = await cameraPose(page, 'sample-camera-2');

  await page.getByTestId('tree-row-sample-camera-2').click();
  await page.keyboard.down('s');
  await page.waitForTimeout(260);
  await page.keyboard.up('s');
  await page.waitForTimeout(80);
  const afterSwitch = await cameraPose(page, 'sample-camera');
  const otherAfterSwitch = await cameraPose(page, 'sample-camera-2');
  expect(vectorDistance(afterSwitch.position, recordingStart.position)).toBeGreaterThan(0.1);
  expect(vectorDistance(otherAfterSwitch.position, otherStart.position)).toBeLessThan(0.01);

  await page.getByTestId('tree-row-sample-camera-2').click({ modifiers: ['Control'] });
  await page.keyboard.down('s');
  await page.waitForTimeout(260);
  await page.keyboard.up('s');
  await page.waitForTimeout(80);
  const afterDeselection = await cameraPose(page, 'sample-camera');
  const otherAfterDeselection = await cameraPose(page, 'sample-camera-2');
  expect(vectorDistance(afterDeselection.position, afterSwitch.position)).toBeGreaterThan(0.1);
  expect(vectorDistance(otherAfterDeselection.position, otherStart.position)).toBeLessThan(0.01);
});

test('recording right drag rotates its camera without panning the director view', async ({ page }) => {
  await startRecording(page);
  await hideViewportOverlays(page);
  const viewport = page.getByTestId('lumora-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport is unavailable');
  const speedControl = page.getByTestId('camera-control-speed');
  await speedControl.focus();
  await expect(speedControl).toBeFocused();
  const cameraStart = await cameraPose(page);
  const directorStart = await canvasShot(page);

  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.65);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(260);
  await expect(viewport).toBeFocused();

  const cameraEnd = await cameraPose(page);
  const directorEnd = await canvasShot(page);
  expect(vectorDistance(cameraEnd.rotation, cameraStart.rotation)).toBeGreaterThan(0.03);
  expect(await pixelDiffRatio(page, directorStart, directorEnd)).toBeLessThan(0.01);

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.65, { steps: 3 });
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
    }));
  });
  const cancelledPose = await cameraPose(page);
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 5 });
  await page.waitForTimeout(220);
  const afterCancelledMove = await cameraPose(page);
  await page.mouse.up({ button: 'right' });
  expect(vectorDistance(afterCancelledMove.rotation, cancelledPose.rotation)).toBeLessThan(0.001);
});

test('recording lost pointer capture freezes queued look while held keyboard movement continues', async ({ page }) => {
  await startRecording(page);
  await hideViewportOverlays(page);
  const viewport = page.getByTestId('lumora-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport is unavailable');
  const start = await cameraPose(page);

  await page.keyboard.down('s');
  await page.waitForTimeout(220);
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.65);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.45, { steps: 4 });
  await page.waitForTimeout(50);
  const afterLook = await cameraPose(page);
  expect(quaternionAngle(afterLook.rotation, start.rotation)).toBeGreaterThan(0.03);

  await viewport.dispatchEvent('lostpointercapture', { pointerId: 1, pointerType: 'mouse' });
  const lossTime = await timeSeconds(page);
  const poseAtLoss = await cameraPose(page);
  await page.waitForTimeout(400);
  const poseAfterWait = await cameraPose(page);
  await page.keyboard.up('s');
  await page.mouse.up({ button: 'right' });

  expect(quaternionAngle(poseAfterWait.rotation, poseAtLoss.rotation)).toBeLessThan(0.001);
  expect(vectorDistance(poseAfterWait.position, poseAtLoss.position)).toBeGreaterThan(0.1);

  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
  const rotationLane = page.locator('.lumora-timeline__lane').filter({ hasText: '录制主摄像机·旋转' });
  const rotationSamples = await rotationLane.locator('.lumora-timeline__keyframe').evaluateAll((elements) =>
    elements.map((element) => {
      const testId = element.getAttribute('data-testid') ?? '';
      return {
        time: Number(testId.slice(testId.lastIndexOf('-') + 1)),
        value: JSON.parse(element.getAttribute('data-keyframe-value') ?? '[]') as number[],
      };
    }),
  );
  const postLossSamples = rotationSamples.filter((sample) => sample.time >= lossTime + 0.05);
  expect(postLossSamples.length).toBeGreaterThan(0);
  for (const sample of postLossSamples) {
    expect(quaternionAngle(sample.value, poseAtLoss.rotation)).toBeLessThan(0.002);
  }
});

test('recording viewport remains operable at 760px and 375px and right drag survives resize', async ({ page }) => {
  await startRecording(page);

  const expectOperableViewport = async (width: number, height: number, minimumSceneHeight: number) => {
    await page.setViewportSize({ width, height });
    const viewport = page.getByTestId('lumora-viewport');
    await viewport.scrollIntoViewIfNeeded();
    await page.waitForTimeout(160);
    const measurements = await page.evaluate(() => {
      const scene = document.querySelector<HTMLElement>('.lumora-studio__scene-slot')!.getBoundingClientRect();
      const viewportRect = document.querySelector<HTMLElement>('[data-testid="lumora-viewport"]')!.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>('[data-testid="viewport-toolbar"]')!.getBoundingClientRect();
      const direction = document.querySelector<HTMLElement>('[data-testid="camera-direction-indicator"]')!.getBoundingClientRect();
      return {
        scene: { top: scene.top, right: scene.right, bottom: scene.bottom, left: scene.left, height: scene.height },
        viewport: {
          top: viewportRect.top,
          right: viewportRect.right,
          bottom: viewportRect.bottom,
          left: viewportRect.left,
          height: viewportRect.height,
        },
        toolbar: {
          top: toolbar.top,
          right: toolbar.right,
          bottom: toolbar.bottom,
          left: toolbar.left,
          height: toolbar.height,
        },
        direction: {
          top: direction.top,
          right: direction.right,
          bottom: direction.bottom,
          left: direction.left,
          width: direction.width,
          height: direction.height,
        },
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(measurements.horizontalOverflow).toBeLessThanOrEqual(0);
    expect(measurements.scene.height).toBeGreaterThanOrEqual(minimumSceneHeight);
    expect(measurements.viewport.height).toBeGreaterThanOrEqual(minimumSceneHeight);
    expect(measurements.toolbar.left).toBeGreaterThanOrEqual(measurements.scene.left);
    expect(measurements.toolbar.right).toBeLessThanOrEqual(measurements.scene.right);
    expect(measurements.toolbar.top).toBeGreaterThanOrEqual(measurements.scene.top);
    expect(measurements.toolbar.bottom).toBeLessThanOrEqual(measurements.scene.bottom - 24);
    expect(measurements.direction.width).toBeGreaterThan(0);
    expect(measurements.direction.height).toBeGreaterThan(0);
    expect(measurements.direction.left).toBeGreaterThanOrEqual(measurements.viewport.left);
    expect(measurements.direction.right).toBeLessThanOrEqual(measurements.viewport.right);
    expect(measurements.direction.top).toBeGreaterThanOrEqual(measurements.viewport.top);
    expect(measurements.direction.bottom).toBeLessThanOrEqual(measurements.viewport.bottom);
  };

  await expectOperableViewport(760, 800, 280);
  await expectOperableViewport(375, 667, 220);

  const canvas = page.locator('.lumora-viewport canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas is unavailable after resize');
  const beforeDrag = await cameraPose(page);
  const dragY = box.height - 10;
  await canvas.hover({ position: { x: box.width * 0.45, y: dragY } });
  await page.mouse.down({ button: 'right' });
  const visibleBox = await canvas.boundingBox();
  if (!visibleBox) throw new Error('viewport canvas disappeared during resize regression');
  await page.mouse.move(visibleBox.x + visibleBox.width * 0.75, visibleBox.y + dragY, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(220);
  const afterDrag = await cameraPose(page);
  expect(vectorDistance(afterDrag.rotation, beforeDrag.rotation)).toBeGreaterThan(0.03);
});

test('embedded medium stage keeps a visible scene beside aggregate camera guidance', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  const studio = page.getByTestId('lumora-studio');
  await studio.evaluate((element) => {
    const node = element as HTMLElement;
    node.style.width = '684px';
    node.style.height = '600px';
  });
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(120);

  const measurements = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.lumora-studio__stage')!.getBoundingClientRect();
    const scene = document.querySelector<HTMLElement>('.lumora-studio__scene-slot')!.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>('[data-testid="camera-control-status"]')!.getBoundingClientRect();
    return { stageWidth: stage.width, sceneHeight: scene.height, statusBottom: status.bottom, sceneBottom: scene.bottom };
  });
  expect(measurements.stageWidth).toBeLessThan(900);
  expect(measurements.sceneHeight).toBeGreaterThanOrEqual(280);
  expect(measurements.statusBottom).toBeLessThanOrEqual(measurements.sceneBottom + 320);
});

test('recording control: keyboard-only mode ignores pointer look and records arrow rotation', async ({ page }) => {
  await page.getByRole('button', { name: '纯键盘操控' }).click();
  await startRecording(page);
  const viewport = page.getByTestId('lumora-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('视口不可见');
  const start = await cameraPose(page);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 30, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(180);
  const afterPointer = await cameraPose(page);
  expect(vectorDistance(afterPointer.rotation, start.rotation)).toBeLessThan(0.001);

  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(260);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(80);
  const afterArrow = await cameraPose(page);
  expect(vectorDistance(afterArrow.position, start.position)).toBeLessThan(0.01);
  expect(vectorDistance(afterArrow.rotation, start.rotation)).toBeGreaterThan(0.03);

  await page.getByTestId('timeline-record').click();
  await expect(page.locator('.lumora-timeline__lane').filter({ hasText: '录制主摄像机·旋转' })).toHaveCount(1);
});

test('AC2 浏览器级：按住驾驶键时页面失焦 → 相机 transform 冻结（录制暂停、画面逐像素不变）', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await startRecording(page);
  await hideViewportOverlays(page);
  const s0 = await canvasShot(page);

  // 按住驾驶键（KeyS 后退）：相机持续后移，场景物体保持可见 —— 位移在画面上
  // 显著可辨（前进会很快把物体推出视锥，只剩纯色地面，位移不可见）
  await page.keyboard.down('s');
  await page.waitForTimeout(600);
  const moving = await canvasShot(page);
  expect(moving.equals(s0)).toBe(false); // 画面持续变化（相机在动）

  // 按键仍按住、驾驶仍在推进时失焦：驾驶硬停 + 录制暂停 —— 相机 transform
  // 冻结在失焦瞬间（与 moving 帧之间隔了 300ms 的持续驾驶，位移必定可辨）
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('timeline-record')).toHaveText('▶'); // 进入暂停态
  await page.waitForTimeout(600);
  const frozen1 = await canvasShot(page);
  await page.waitForTimeout(400);
  const frozen2 = await canvasShot(page);
  expect(frozen2.equals(frozen1)).toBe(true); // 期间零位移（transform 冻结）
  expect(frozen1.equals(moving)).toBe(false); // 冻结在失焦瞬间的画面，而非失焦前

  // 松开按键 → 恢复录制 → 停止
  await page.keyboard.up('s');
  await page.getByTestId('timeline-record').click(); // ▶ = 恢复
  await expect(page.getByTestId('timeline-record')).toHaveText('■');
  await page.waitForTimeout(200);
  await page.getByTestId('timeline-record').click(); // 停止
});

test('AC3 浏览器级：关键帧间平滑插值 —— 中间帧与端点帧互不相同、同时刻确定性一致', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await page.getByTestId('timeline-snap').setChecked(false); // 精确坐标换算
  await hideViewportOverlays(page);

  const zoom = await measureZoom(page, 'keyframe-sample-track-camera-dolly-2', 2);
  const at = async (t: number) => {
    if (t === 0 || t === 2 || t === 4) {
      await page.getByTestId(`keyframe-sample-track-camera-dolly-${t}`).click();
    } else {
      await seekByRuler(page, t, zoom);
    }
    return canvasShot(page);
  };

  // 端点画面互不相同（推镜路径：z 7 → 4.5 → 3 + 焦距 50 → 35）
  const s0 = await at(0);
  const s2 = await at(2);
  const s4 = await at(4);
  expect(s0.equals(s2)).toBe(false);
  expect(s2.equals(s4)).toBe(false);
  expect(s0.equals(s4)).toBe(false);

  // 中间帧：与相邻端点均不同（插值生效，而非端点保持）
  const s1 = await at(1);
  const s3 = await at(3);
  expect(s1.equals(s0)).toBe(false);
  expect(s1.equals(s2)).toBe(false);
  expect(s3.equals(s2)).toBe(false);
  expect(s3.equals(s4)).toBe(false);

  // 确定性：同一时刻两次 seek → 画面逐像素一致
  const s2Again = await at(2);
  expect(s2Again.equals(s2)).toBe(true);

  // 数值断言（复审 AC 补强）：dolly 段 [0,2] 左端点无插值字段 → 线性插值，
  // t=1 处位置恰为两端中点 z=5.75；焦距段 [0,4] 线性（50→35）→ t=1 为 46.25
  const poseAt = async (t: number) => {
    await at(t);
    return cameraPose(page);
  };
  const pose1 = await poseAt(1);
  expect(pose1.position[2]).toBeCloseTo(5.75, 2);
  expect(pose1.focalLength).toBeCloseTo(46.25, 2);
  // 重复求值：回到起点再求值同一时刻 → 数值逐位一致（回放确定性）
  const pose0 = await poseAt(0);
  const pose1Again = await poseAt(1);
  expect(pose0.position[2]).toBeCloseTo(7, 2);
  expect(pose1Again.position[2]).toBeCloseTo(5.75, 2);
  expect(pose1Again.position).toEqual(pose1.position);
  expect(pose1Again.focalLength).toEqual(pose1.focalLength);

  // 关键帧点击精确定位到该帧时间
  await page.getByTestId('keyframe-sample-track-camera-dolly-0').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
  await page.getByTestId('keyframe-sample-track-camera-dolly-2').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:02.00');
});

test('AC4 浏览器级：分镜区段坐标与机位绑定 → 重排原子重算 → 重开一致', async ({ page }) => {
  const zoom = await measureZoom(page, 'keyframe-sample-track-camera-dolly-2', 2);

  // 初始区段坐标：时间画布内 startTime * zoom —— 0 / 1.5s / 3s
  await expectShotLeft(page, 'sample-shot-1', 0);
  await expectShotLeft(page, 'sample-shot-2', 1.5 * zoom);
  await expectShotLeft(page, 'sample-shot-3', 3 * zoom);
  // 机位绑定：区块 title「机位：主摄像机」
  // 机位绑定（复审 AC 补强：至少两台机位，按分镜身份校验绑定）
  await expect(page.getByTestId('shot-block-sample-shot-1')).toHaveAttribute('title', '机位：主摄像机');
  for (const shotId of ['sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：俯拍机位');
  }

  // 重排 1 → 右移两次 → [2, 3, 1]：区段时间按新顺序原子重算（视觉/时间顺序同变，审查第 3 项）
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await expectShotLeft(page, 'sample-shot-2', 0);
  await expectShotLeft(page, 'sample-shot-3', 1.5 * zoom);
  await expectShotLeft(page, 'sample-shot-1', 3 * zoom);
  // 机位绑定随分镜保留
  // 机位绑定（复审 AC 补强：至少两台机位，按分镜身份校验绑定）
  await expect(page.getByTestId('shot-block-sample-shot-1')).toHaveAttribute('title', '机位：主摄像机');
  for (const shotId of ['sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：俯拍机位');
  }

  // 保存 → 刷新重开 → 顺序/区段坐标/机位绑定一致（AC4 重开持久）
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 10_000 });
  await page.reload();
  await page.getByTestId('project-menu').click();
  await page
    .locator('[data-testid="recent-project"]')
    .filter({ hasText: '示例项目' })
    .locator('.lumora-project-menu__recent-open')
    .click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  const order = () =>
    page
      .locator('[data-testid^="shot-block-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(await order()).toEqual([
    'shot-block-sample-shot-2',
    'shot-block-sample-shot-3',
    'shot-block-sample-shot-1',
  ]);
  const zoom2 = await measureZoom(page, 'keyframe-sample-track-camera-dolly-2', 2);
  await expectShotLeft(page, 'sample-shot-2', 0);
  await expectShotLeft(page, 'sample-shot-3', 1.5 * zoom2);
  await expectShotLeft(page, 'sample-shot-1', 3 * zoom2);
  // 机位绑定（复审 AC 补强：至少两台机位，按分镜身份校验绑定）
  await expect(page.getByTestId('shot-block-sample-shot-1')).toHaveAttribute('title', '机位：主摄像机');
  for (const shotId of ['sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：俯拍机位');
  }
});

test('G 一般项：375px 窄视口 —— 运输控制完整可见可点、时间轴横向滚动收纳于内部', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });

  // 页面无横向溢出（窄屏布局纵向堆叠）
  const hOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(hOverflow).toBeLessThanOrEqual(0);

  // 运输控制完整可见（flex-wrap 收纳，不被裁剪）
  await expect(page.getByTestId('timeline-play')).toBeVisible();
  await expect(page.getByTestId('timeline-record')).toBeVisible();
  await expect(page.getByTestId('timeline-snap')).toBeVisible();
  await expect(page.getByTestId('timeline-time')).toBeVisible();

  // 时间轴内容横向滚动收纳在面板内部，不撑破页面
  const internalScroll = await page
    .getByTestId('timeline-body')
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(internalScroll).toBe(true);

  // 播放控制可用：点击后时间推进
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(400);
  expect(await timeSeconds(page)).toBeGreaterThan(0.25);
});
