import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { MINIMAL_GLB } from './helpers/glb';
import { decodePng, pngPixel } from './helpers/png';

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  decodedPixelCount: number;
  frameComparisons: Array<{
    time: number;
    differences: number[];
  }>;
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

async function inspectWebm(
  page: Page,
  bytes: Buffer,
  referencePngs: Buffer[] = [],
  sampleTimes: number[] = [],
): Promise<VideoMetadata> {
  return page.evaluate(async ({ webmBase64, referenceBase64s, requestedTimes }) => {
    const binary = atob(webmBase64);
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

    const loadImage = (base64: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Chromium could not decode a reference PNG'));
      image.src = `data:image/png;base64,${base64}`;
    });

    const seekTo = async (time: number) => {
      const bounded = Math.min(Math.max(time, 0.001), Math.max(video.duration - 0.001, 0.001));
      if (Math.abs(video.currentTime - bounded) < 0.0001) return;
      const seeked = waitForEvent('seeked');
      video.currentTime = bounded;
      await seeked;
    };

    try {
      const metadataReady = waitForEvent('loadedmetadata');
      video.load();
      await metadataReady;
      const duration = video.duration;
      await seekTo(duration / 2);
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
      const frameComparisons: VideoMetadata['frameComparisons'] = [];
      if (referenceBase64s.length > 0 && requestedTimes.length > 0) {
        const references = await Promise.all(referenceBase64s.map(loadImage));
        const signatureCanvas = document.createElement('canvas');
        signatureCanvas.width = 64;
        signatureCanvas.height = 36;
        const signatureContext = signatureCanvas.getContext('2d', { willReadFrequently: true });
        if (!signatureContext) throw new Error('2D signature canvas is unavailable');
        const signature = (source: CanvasImageSource) => {
          signatureContext.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
          signatureContext.drawImage(source, 0, 0, signatureCanvas.width, signatureCanvas.height);
          return new Uint8ClampedArray(
            signatureContext.getImageData(0, 0, signatureCanvas.width, signatureCanvas.height).data,
          );
        };
        const referenceSignatures = references.map(signature);
        for (const time of requestedTimes) {
          await seekTo(time);
          const frame = signature(video);
          const differences = referenceSignatures.map((reference) => {
            let difference = 0;
            for (let index = 0; index < frame.length; index += 4) {
              difference += Math.abs(frame[index]! - reference[index]!);
              difference += Math.abs(frame[index + 1]! - reference[index + 1]!);
              difference += Math.abs(frame[index + 2]! - reference[index + 2]!);
            }
            return difference / (signatureCanvas.width * signatureCanvas.height * 3 * 255);
          });
          frameComparisons.push({ time, differences });
        }
      }
      return {
        duration,
        width: video.videoWidth,
        height: video.videoHeight,
        decodedPixelCount,
        frameComparisons,
      };
    } finally {
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, {
    webmBase64: bytes.toString('base64'),
    referenceBase64s: referencePngs.map((reference) => reference.toString('base64')),
    requestedTimes: sampleTimes,
  });
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

async function exportShotPng(page: Page, accessibleName: RegExp): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: accessibleName }).click();
  return readDownload(await downloadPromise);
}

async function cameraPose(
  page: Page,
  cameraId: string,
): Promise<{ position: [number, number, number]; rotation: [number, number, number] }> {
  const readout = page.getByTestId('camera-pose-readout');
  await expect.poll(() => readout.textContent()).not.toBe('');
  const text = await readout.textContent();
  if (!text) throw new Error('Camera pose readout is unavailable');
  const pose = JSON.parse(text)[cameraId];
  if (!pose) throw new Error(`Camera ${cameraId} is missing from the pose readout`);
  return pose;
}

function blueSphereSilhouetteAspect(png: ReturnType<typeof decodePng>): number {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const [red, green, blue] = pngPixel(png, x, y);
      if (blue < 60 || blue - red < 20 || blue - green < 10 || green - red < 10) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels += 1;
    }
  }
  if (pixels < 100 || maxX < minX || maxY < minY) {
    throw new Error('Known foreground sphere silhouette was not found in the exported frame');
  }
  return (maxX - minX + 1) / (maxY - minY + 1);
}

test('opens export with the native Space button action without toggling playback', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  const trigger = page.getByTestId('open-export-workspace');
  const playBefore = await page.getByTestId('timeline-play').textContent();

  await trigger.focus();
  await trigger.press('Space');

  await expect(page.getByTestId('export-workspace')).toBeVisible();
  await expect(page.getByTestId('timeline-play')).toHaveText(playBefore ?? '');
});

test('exports three ordered shots as a playable 720p/24fps WebM', async ({ page }) => {
  await openSampleExport(page);
  await page.getByRole('button', { name: '关闭导出' }).click();
  await page.getByTestId('open-storyboard-workspace').click();
  await page.getByTestId('storyboard-tab-adopted').click();
  const adoptedShots = page.getByTestId('storyboard-adopted-shot');
  await expect(adoptedShots).toHaveCount(3);
  await adoptedShots.nth(2).locator('label').filter({ hasText: '机位' }).locator('select')
    .selectOption('sample-camera');
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  await expect(page.getByLabel('分辨率')).toHaveValue('720p');
  await expect(page.getByLabel('帧率')).toHaveValue('24');
  const referencePngs = [
    await exportShotPng(page, /导出 分镜 1.*PNG/),
    await exportShotPng(page, /导出 分镜 2.*PNG/),
    await exportShotPng(page, /导出 分镜 3.*PNG/),
  ];

  const { bytes, order } = await exportWebm(page);
  expect(bytes.length).toBeGreaterThan(1_000);
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(order).toEqual(['分镜 1 · 开场全景', '分镜 2 · 推近主体', '分镜 3 · 特写']);

  const metadata = await inspectWebm(page, bytes, referencePngs, [0.75, 2.25, 3.75]);
  expect(metadata.width).toBe(1280);
  expect(metadata.height).toBe(720);
  expect(Math.abs(metadata.duration - 4.5)).toBeLessThanOrEqual(1 / 24);
  expect(metadata.decodedPixelCount).toBeGreaterThan(1280 * 720 * 0.9);
  expect(metadata.frameComparisons).toHaveLength(3);
  expect(metadata.frameComparisons.map(({ differences }) => (
    differences.indexOf(Math.min(...differences))
  ))).toEqual([0, 1, 2]);
  for (const [index, comparison] of metadata.frameComparisons.entries()) {
    const ordered = [...comparison.differences].sort((a, b) => a - b);
    expect(comparison.differences[index]).toBeLessThan(0.08);
    expect(ordered[1]! - ordered[0]!).toBeGreaterThan(0.001);
  }
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

test('isolates editor shortcuts while export is idle and while recording', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-camera-2')).toBeVisible();
  await page.getByTestId('tree-row-sample-camera-2').click();
  const rows = page.locator('.lumora-tree-row');
  const rowCount = await rows.count();
  const cameraPoseBefore = await cameraPose(page, 'sample-camera-2');
  const playBefore = await page.getByTestId('timeline-play').textContent();
  await page.getByTestId('open-export-workspace').click();

  const pressEditorShortcuts = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+Shift+K');
    await page.keyboard.press('Control+Z');
    await page.keyboard.press('Control+Shift+Z');
    await page.keyboard.press('Control+Y');
    await page.keyboard.press('Control+D');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await page.keyboard.down('w');
    await page.waitForTimeout(150);
    await page.keyboard.up('w');
    await page.waitForTimeout(50);
  };

  await pressEditorShortcuts();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(rows).toHaveCount(rowCount);
  await expect(page.getByTestId('tree-row-sample-camera-2')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('timeline-play')).toHaveText(playBefore ?? '');
  expect(await cameraPose(page, 'sample-camera-2')).toEqual(cameraPoseBefore);

  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByLabel('导出进度')).not.toHaveJSProperty('value', 0);
  await pressEditorShortcuts();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(rows).toHaveCount(rowCount);
  await expect(page.getByTestId('tree-row-sample-camera-2')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('timeline-play')).toHaveText(playBefore ?? '');
  expect(await cameraPose(page, 'sample-camera-2')).toEqual(cameraPoseBefore);
  await page.getByRole('button', { name: '取消导出' }).click();
  await expect(page.getByRole('status')).toContainText('导出已取消');
});

test('cancels at 100% finalization without downloading and remains retryable', async ({ page }) => {
  await page.addInitScript(() => {
    class FinalizationRecorder {
      static isTypeSupported(mimeType: string): boolean {
        return mimeType.startsWith('video/webm');
      }

      state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;

      start(): void {
        this.state = 'recording';
      }

      stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.(new BlobEvent('dataavailable', { data: new Blob(['partial-webm']) }));
        // Deliberately omit onstop so AbortSignal must win the finalization race.
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FinalizationRecorder,
    });
  });
  let downloads = 0;
  page.on('download', () => downloads += 1);
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');

  const runAndCancel = async () => {
    await page.getByRole('button', { name: '导出 WebM' }).click();
    await expect(page.getByLabel('导出进度')).toHaveJSProperty('value', 100);
    await page.getByRole('button', { name: '取消导出' }).click();
    await expect(page.getByRole('status')).toContainText('导出已取消');
    await expect(page.getByRole('button', { name: '导出 WebM' })).toBeFocused();
  };

  await runAndCancel();
  await runAndCancel();
  expect(downloads).toBe(0);
});

test('fails explicitly when timer throttling misses the real-time frame deadline', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & { __lumoraThrottleExport?: boolean };
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(
        handler,
        scope.__lumoraThrottleExport && (timeout ?? 0) < 100 ? (timeout ?? 0) + 120 : timeout,
        ...args,
      )) as typeof globalThis.setTimeout;
  });
  let downloads = 0;
  page.on('download', () => downloads += 1);
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __lumoraThrottleExport?: boolean }).__lumoraThrottleExport = true;
  });

  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByRole('alert')).toContainText('未能维持所选帧率');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeFocused();
  expect(downloads).toBe(0);
});

test('invalidates an old export when the same project URI is reopened', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  const projectDownload = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  await projectDownload;
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  let previewDownloads = 0;
  page.on('download', () => previewDownloads += 1);

  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByLabel('导出进度')).not.toHaveJSProperty('value', 0);
  await page.getByTestId('reopen-last-export').click();

  await expect(page.getByTestId('export-workspace')).toHaveCount(0);
  await expect(page.getByTestId('tree-row-sample-camera')).toBeVisible();
  await page.waitForTimeout(250);
  expect(previewDownloads).toBe(0);
});

test('preserves foreground geometry in a full-width 854x480 PNG', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const focalLength = 50;
    const fov = (2 * Math.atan(24 / 2 / focalLength) * 180) / Math.PI;
    const project = {
      uri: 'lumora://export-geometry-probe',
      name: 'Export geometry probe',
      schemaVersion: 4,
      createdAt: new Date().toISOString(),
      revision: 0,
      settings: { fps: 24, aspect: [16, 9] },
      activeSceneId: 'probe-scene',
      scenes: [{
        id: 'probe-scene',
        name: 'Probe scene',
        rootObjectIds: ['probe-camera', 'probe-sphere', 'probe-ground', 'probe-light'],
        activeCameraId: 'probe-camera',
      }],
      objects: [
        {
          id: 'probe-camera',
          type: 'camera',
          name: 'Probe camera',
          parentId: null,
          transform: { position: [0, 2, 5], rotation: [-0.35, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          camera: {
            projection: 'perspective',
            focalLength,
            fov,
            sensorWidth: 36,
            sensorHeight: 24,
            near: 0.1,
            far: 200,
            aspect: null,
          },
        },
        {
          id: 'probe-sphere',
          type: 'primitive',
          name: 'Probe sphere',
          parentId: null,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          geometry: { kind: 'sphere' },
          material: { color: '#4dabf7' },
        },
        {
          id: 'probe-ground',
          type: 'primitive',
          name: 'Probe ground',
          parentId: null,
          transform: { position: [0, -0.6, 0], rotation: [-Math.PI / 2, 0, 0], scale: [12, 12, 1] },
          visible: true,
          locked: false,
          geometry: { kind: 'plane' },
          material: { color: '#232734' },
        },
        {
          id: 'probe-light',
          type: 'light',
          name: 'Probe light',
          parentId: null,
          transform: { position: [3, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          light: { kind: 'directional', color: '#ffffff', intensity: 1.4 },
        },
      ],
      tracks: [],
      shots: [{
        id: 'probe-shot',
        name: 'Geometry probe',
        cameraObjectId: 'probe-camera',
        startTime: 0,
        endTime: 1,
      }],
      assets: [],
    };
    localStorage.setItem('lumora.demo.last-export', JSON.stringify(project));
  });
  await page.reload();
  await page.getByTestId('reopen-last-export').click();
  await expect(page.getByTestId('tree-row-probe-sphere')).toBeVisible();
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  const png720 = decodePng(await exportShotPng(page, /导出 Geometry probe.*PNG/));
  await page.getByLabel('分辨率').selectOption('480p');
  const png = decodePng(await exportShotPng(page, /导出 Geometry probe.*PNG/));

  expect({ width: png.width, height: png.height }).toEqual({ width: 854, height: 480 });
  const silhouette720 = blueSphereSilhouetteAspect(png720);
  const silhouette480 = blueSphereSilhouetteAspect(png);
  expect(silhouette720).toBeGreaterThan(0.95);
  expect(silhouette720).toBeLessThan(1.05);
  expect(silhouette480).toBeGreaterThan(0.95);
  expect(silhouette480).toBeLessThan(1.05);
  expect(Math.abs(silhouette480 - silhouette720)).toBeLessThan(0.03);
  const edgeColorCount = (x: number) => new Set(
    Array.from({ length: png.height }, (_, y) => pngPixel(png, x, y).slice(0, 3).join(',')),
  ).size;
  expect(edgeColorCount(0)).toBeGreaterThan(1);
  expect(edgeColorCount(853)).toBeGreaterThan(1);
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
  const quantizedDuration = 14 / 24;
  expect(Math.abs(quantizedDuration - 0.6)).toBeLessThanOrEqual(0.5 / 24);
  for (let run = 0; run < 3; run += 1) {
    const { bytes, order } = await exportWebm(page);
    expect(bytes.length).toBeGreaterThan(1_000);
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(order).toEqual(['Shot 1', 'Shot 2', 'Shot 3']);
    const metadata = await inspectWebm(page, bytes);
    expect(Math.abs(metadata.duration - quantizedDuration)).toBeLessThanOrEqual(1 / 24);
  }
  expect(browserErrors).toEqual([]);
});
