import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { MINIMAL_GLB } from './helpers/glb';

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  decodedPixelCount: number;
}

interface ExportInstrumentation {
  recorderConstructions: number;
  captureStreams: number;
  trackStops: number;
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function inspectWebm(page: Page, bytes: Buffer): Promise<VideoMetadata> {
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([data], { type: 'video/webm' }));
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    document.body.appendChild(video);

    const waitForEvent = (name: 'loadedmetadata' | 'seeked') =>
      new Promise<void>((resolve, reject) => {
        const timeout = globalThis.setTimeout(
          () => reject(new Error(`Timed out waiting for video ${name}`)),
          10_000,
        );
        video.addEventListener(name, () => {
          globalThis.clearTimeout(timeout);
          resolve();
        }, { once: true });
        video.addEventListener('error', () => {
          globalThis.clearTimeout(timeout);
          reject(new Error(video.error?.message || 'Chromium could not decode the WebM'));
        }, { once: true });
      });

    try {
      const metadataReady = waitForEvent('loadedmetadata');
      video.load();
      await metadataReady;
      const duration = video.duration;
      const seeked = waitForEvent('seeked');
      video.currentTime = Math.min(Math.max(duration / 2, 0.01), Math.max(duration - 0.01, 0.01));
      await seeked;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable');
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let decodedPixelCount = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0) {
          decodedPixelCount += 1;
        }
      }
      return {
        duration,
        width: video.videoWidth,
        height: video.videoHeight,
        decodedPixelCount,
      };
    } finally {
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, bytes.toString('base64'));
}

async function openSampleExport(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
}

async function observeExportShotOrder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportShotOrder?: string[];
    };
    scope.__lumoraExportShotOrder = [];
    const workspace = document.querySelector('[data-testid="export-workspace"]');
    if (!workspace) throw new Error('Export workspace is not mounted');
    new MutationObserver(() => {
      const status = workspace.querySelector('[role="status"]')?.textContent ?? '';
      const shot = /\u00b7\s*(.+)$/.exec(status)?.[1]?.trim();
      const shots = scope.__lumoraExportShotOrder!;
      if (shot && shots.at(-1) !== shot) shots.push(shot);
    }).observe(workspace, { childList: true, subtree: true, characterData: true });
  });
}

async function exportWebm(page: Page): Promise<{ bytes: Buffer; order: string[] }> {
  await observeExportShotOrder(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 WebM' }).click();
  const download = await downloadPromise;
  await expect(page.getByRole('status')).toContainText('导出完成');
  const bytes = await readDownload(download);
  const order = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportShotOrder?: string[] }
  ).__lumoraExportShotOrder ?? []);
  return { bytes, order };
}

test('exports three ordered shots as a playable 720p/24fps WebM', async ({ page }) => {
  await openSampleExport(page);
  await expect(page.getByLabel('分辨率')).toHaveValue('720p');
  await expect(page.getByLabel('帧率')).toHaveValue('24');

  const { bytes, order } = await exportWebm(page);
  expect(bytes.length).toBeGreaterThan(1_000);
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(order).toEqual(['分镜 1 · 开场全景', '分镜 2 · 推近主体', '分镜 3 · 特写']);

  const metadata = await inspectWebm(page, bytes);
  expect(metadata.width).toBe(1280);
  expect(metadata.height).toBe(720);
  expect(metadata.duration).toBeCloseTo(4.5, 0);
  expect(metadata.decodedPixelCount).toBeGreaterThan(1280 * 720 * 0.9);
});

test('reports unsupported codecs before constructing a recorder or downloading a file', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportInstrumentation?: ExportInstrumentation;
    };
    scope.__lumoraExportInstrumentation = {
      recorderConstructions: 0,
      captureStreams: 0,
      trackStops: 0,
    };
    const originalCaptureStream = HTMLCanvasElement.prototype.captureStream;
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: function captureStream(this: HTMLCanvasElement, frameRate?: number) {
        scope.__lumoraExportInstrumentation!.captureStreams += 1;
        return originalCaptureStream.call(this, frameRate);
      },
    });
    class UnsupportedMediaRecorder {
      static isTypeSupported(): boolean {
        return false;
      }

      constructor() {
        scope.__lumoraExportInstrumentation!.recorderConstructions += 1;
        throw new Error('Recorder must not be constructed for an unsupported codec');
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: UnsupportedMediaRecorder,
    });
  });
  let downloads = 0;
  page.on('download', () => downloads += 1);

  await openSampleExport(page);
  await expect(page.getByRole('alert')).toContainText('不支持 VP8/VP9 WebM 编码');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  await page.waitForTimeout(200);

  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.recorderConstructions).toBe(0);
  expect(instrumentation.captureStreams).toBe(0);
  expect(downloads).toBe(0);
});

test('cancels recording, releases media tracks, and returns to an editable project', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportInstrumentation?: ExportInstrumentation;
    };
    scope.__lumoraExportInstrumentation = {
      recorderConstructions: 0,
      captureStreams: 0,
      trackStops: 0,
    };
    const originalCaptureStream = HTMLCanvasElement.prototype.captureStream;
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: function captureStream(this: HTMLCanvasElement, frameRate?: number) {
        const stream = originalCaptureStream.call(this, frameRate);
        scope.__lumoraExportInstrumentation!.captureStreams += 1;
        for (const track of stream.getTracks()) {
          const originalStop = track.stop.bind(track);
          Object.defineProperty(track, 'stop', {
            configurable: true,
            value: () => {
              scope.__lumoraExportInstrumentation!.trackStops += 1;
              originalStop();
            },
          });
        }
        return stream;
      },
    });
  });
  let downloads = 0;
  page.on('download', () => downloads += 1);

  await openSampleExport(page);
  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByRole('button', { name: '取消导出' })).toBeVisible();
  await expect(page.getByLabel('导出进度')).not.toHaveJSProperty('value', 0);
  await page.getByRole('button', { name: '取消导出' }).click();
  await expect(page.getByRole('status')).toContainText('导出已取消');

  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.captureStreams).toBe(1);
  expect(instrumentation.trackStops).toBeGreaterThanOrEqual(1);
  expect(downloads).toBe(0);

  await page.getByRole('button', { name: '关闭导出' }).click();
  await expect(page.getByTestId('open-export-workspace')).toBeFocused();
  const rows = page.locator('.lumora-tree-row');
  const before = await rows.count();
  await page.getByTestId('add-object').click();
  await page.getByTestId('add-立方体').click();
  await expect(rows).toHaveCount(before + 1);
});

test('keeps the export workspace usable at desktop and mobile viewports', async ({ page }, testInfo) => {
  const assertLayout = async () => {
    const layout = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>('[data-testid="export-workspace"]');
      const studio = document.querySelector<HTMLElement>('[data-testid="lumora-studio"]');
      if (!workspace || !studio) throw new Error('Export workspace is not mounted');
      const workspaceBox = workspace.getBoundingClientRect();
      const studioBox = studio.getBoundingClientRect();
      const escapedControls = [...workspace.querySelectorAll<HTMLElement>('button, select')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < -1 || box.right > document.documentElement.clientWidth + 1;
        })
        .map((element) => element.textContent?.trim() || element.getAttribute('aria-label'));
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        workspaceLeft: workspaceBox.left,
        workspaceRight: workspaceBox.right,
        workspaceTop: workspaceBox.top,
        workspaceBottom: workspaceBox.bottom,
        studioTop: studioBox.top,
        studioBottom: studioBox.bottom,
        escapedControls,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.workspaceLeft).toBeGreaterThanOrEqual(0);
    expect(layout.workspaceRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.workspaceTop).toBeCloseTo(layout.studioTop, 0);
    expect(layout.workspaceBottom).toBeCloseTo(layout.studioBottom, 0);
    expect(layout.escapedControls).toEqual([]);
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await openSampleExport(page);
  await expect(page.getByTestId('lumora-toolbar')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
  await assertLayout();
  await testInfo.attach('export-desktop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 375, height: 667 });
  await assertLayout();
  await expect(page.getByRole('button', { name: '关闭导出' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
  await testInfo.attach('export-mobile', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByTestId('export-workspace').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole('button', { name: '导出 分镜 3 · 特写 PNG' })).toBeVisible();
  const closeInStudioViewport = await page.getByRole('button', { name: '关闭导出' }).evaluate((button) => {
    const studio = document.querySelector<HTMLElement>('[data-testid="lumora-studio"]');
    if (!studio) return false;
    const buttonBox = button.getBoundingClientRect();
    const studioBox = studio.getBoundingClientRect();
    return buttonBox.top >= studioBox.top && buttonBox.bottom <= studioBox.bottom;
  });
  expect(closeInStudioViewport).toBe(true);
});

test('completes the new-project release flow without unhandled browser errors', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto('/');

  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-new').click();
  await page.getByTestId('project-name-input').fill('发布验收项目');
  await page.getByTestId('project-name-confirm').click();
  await expect(page.getByTestId('lumora-toasts')).toContainText('已新建项目');

  await page.getByTestId('toolbar-model-file-input').setInputFiles({
    name: 'release-hero.glb',
    mimeType: 'model/gltf-binary',
    buffer: MINIMAL_GLB,
  });
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  await page.getByTestId('add-object').click();
  await page.getByTestId('add-摄像机').click();
  const cameraType = page.locator('.lumora-tree-row__type--camera');
  await expect(cameraType).toHaveCount(2);
  await page.getByTitle('摄像机', { exact: true }).click();

  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('timeline-record')).toHaveText('■');
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('timeline-record')).toHaveText('●');
  await expect(page.locator('[data-testid^="track-lane-"]')).not.toHaveCount(0);

  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-concept').fill('A product reveal in three concise shots.');
  await page.getByTestId('storyboard-generate').click();
  await expect(page.getByTestId('storyboard-draft-shot')).toHaveCount(3);
  await page.getByTestId('storyboard-accept-all').click();
  await page.getByTestId('storyboard-tab-adopted').click();
  const adopted = page.getByTestId('storyboard-adopted-shot');
  await expect(adopted).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const row = adopted.nth(index);
    const duration = row.locator('label').filter({ hasText: '时长（秒）' }).locator('input');
    await duration.fill('0.2');
    await duration.press('Tab');
    await row.locator('label').filter({ hasText: '机位' }).locator('select').selectOption({ label: '摄像机' });
  }
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 10_000 });

  await page.reload();
  await page.getByTestId('project-menu').click();
  await page.locator('[data-testid="recent-project"]', { hasText: '发布验收项目' })
    .locator('.lumora-project-menu__recent-open')
    .click();
  await expect(page.locator('.lumora-tree-row', { hasText: 'release-hero' })).toBeVisible();
  await expect(page.locator('.lumora-tree-row__type--camera')).toHaveCount(2);
  await expect(page.locator('[data-testid^="track-lane-"]')).not.toHaveCount(0);
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);

  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-summary')).toContainText('3 个分镜');
  await expect(page.getByTestId('export-summary')).toContainText('0.60 秒');
  const { bytes, order } = await exportWebm(page);
  expect(bytes.length).toBeGreaterThan(1_000);
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(order).toEqual(['Shot 1', 'Shot 2', 'Shot 3']);
  const metadata = await inspectWebm(page, bytes);
  expect(metadata.duration).toBeCloseTo(0.6, 0);
  expect(browserErrors).toEqual([]);
});
