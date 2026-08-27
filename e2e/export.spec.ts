import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
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
  encoderConstructions: number;
  encoderConfigures: number;
  encoderEncodes: number;
  encoderFlushes: number;
  encoderCloses: number;
  maxEncodeQueueSize: number;
  supportChecks: number;
  supportConfigs: VideoEncoderConfig[];
  captureStreams: number;
  progressValues: number[];
}

interface WebmProbe {
  packets: Array<{ pts_time: string; duration_time?: string }>;
  format: { duration: string };
}

const execFileAsync = promisify(execFile);

async function instrumentWebCodecs(
  page: Page,
  flushMode: 'native' | 'pending' | 'fail-once' = 'native',
  supportMode: 'native' | 'pending' | 'unsupported' | 'reject' | 'deferred' = 'native',
  configureMode: 'native' | 'fail-once' = 'native',
): Promise<void> {
  await page.addInitScript(({ flush, support, configure }) => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportInstrumentation?: ExportInstrumentation;
      __lumoraResolveSupportCheck?: (index: number, supported: boolean) => void;
    };
    const instrumentation: ExportInstrumentation = {
      encoderConstructions: 0,
      encoderConfigures: 0,
      encoderEncodes: 0,
      encoderFlushes: 0,
      encoderCloses: 0,
      maxEncodeQueueSize: 0,
      supportChecks: 0,
      supportConfigs: [],
      captureStreams: 0,
      progressValues: [],
    };
    scope.__lumoraExportInstrumentation = instrumentation;

    const progressValue = Object.getOwnPropertyDescriptor(HTMLProgressElement.prototype, 'value');
    if (progressValue?.get && progressValue.set) {
      Object.defineProperty(HTMLProgressElement.prototype, 'value', {
        ...progressValue,
        get: progressValue.get,
        set(value: number) {
          instrumentation.progressValues.push(Number(value));
          progressValue.set!.call(this, value);
        },
      });
    }
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name: string, value: string) {
      nativeSetAttribute.call(this, name, value);
      if (this instanceof HTMLProgressElement && name.toLowerCase() === 'value') {
        instrumentation.progressValues.push(this.value);
      }
    };

    const originalCaptureStream = HTMLCanvasElement.prototype.captureStream;
    if (originalCaptureStream) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
        configurable: true,
        value: function captureStream(this: HTMLCanvasElement, frameRate?: number) {
          instrumentation.captureStreams += 1;
          return originalCaptureStream.call(this, frameRate);
        },
      });
    }

    const NativeVideoEncoder = globalThis.VideoEncoder;
    if (typeof NativeVideoEncoder !== 'function') return;
    const nativeIsConfigSupported = NativeVideoEncoder.isConfigSupported.bind(NativeVideoEncoder);
    const supportResolvers: Array<(supported: boolean) => void> = [];
    scope.__lumoraResolveSupportCheck = (index, supported) => supportResolvers[index]?.(supported);
    const InstrumentedVideoEncoder = new Proxy(NativeVideoEncoder, {
      construct(target, args) {
        const encoder = Reflect.construct(target, args) as VideoEncoder;
        instrumentation.encoderConstructions += 1;
        const nativeConfigure = encoder.configure.bind(encoder);
        const nativeEncode = encoder.encode.bind(encoder);
        const nativeFlush = encoder.flush.bind(encoder);
        const nativeClose = encoder.close.bind(encoder);
        let closed = false;
        Object.defineProperty(encoder, 'configure', {
          configurable: true,
          value: (config: VideoEncoderConfig) => {
            instrumentation.encoderConfigures += 1;
            if (configure === 'fail-once' && instrumentation.encoderConfigures === 1) {
              throw new DOMException('Injected WebCodecs configure failure', 'NotSupportedError');
            }
            return nativeConfigure(config);
          },
        });
        Object.defineProperty(encoder, 'encode', {
          configurable: true,
          value: (frame: VideoFrame, options?: VideoEncoderEncodeOptions) => {
            nativeEncode(frame, options);
            instrumentation.encoderEncodes += 1;
            instrumentation.maxEncodeQueueSize = Math.max(
              instrumentation.maxEncodeQueueSize,
              encoder.encodeQueueSize,
            );
          },
        });
        Object.defineProperty(encoder, 'flush', {
          configurable: true,
          value: () => {
            instrumentation.encoderFlushes += 1;
            if (flush === 'pending') return new Promise<void>(() => undefined);
            if (flush === 'fail-once' && instrumentation.encoderFlushes === 1) {
              return Promise.reject(new DOMException('Injected WebCodecs flush failure', 'EncodingError'));
            }
            return nativeFlush();
          },
        });
        Object.defineProperty(encoder, 'close', {
          configurable: true,
          value: () => {
            if (!closed) {
              closed = true;
              instrumentation.encoderCloses += 1;
            }
            return nativeClose();
          },
        });
        return encoder;
      },
      get(target, property, receiver) {
        if (property !== 'isConfigSupported') return Reflect.get(target, property, receiver);
        return (config: VideoEncoderConfig) => {
          const checkIndex = instrumentation.supportChecks;
          instrumentation.supportChecks += 1;
          instrumentation.supportConfigs.push({ ...config });
          if (support === 'pending') return new Promise<VideoEncoderSupport>(() => undefined);
          if (support === 'unsupported') return Promise.resolve({ supported: false, config });
          if (support === 'reject') {
            return Promise.reject(new DOMException('Injected VP8 capability failure', 'NotSupportedError'));
          }
          if (support === 'deferred') {
            return new Promise<VideoEncoderSupport>((resolve) => {
              supportResolvers[checkIndex] = (supported) => resolve({ supported, config });
            });
          }
          return nativeIsConfigSupported(config);
        };
      },
    });
    Object.defineProperty(globalThis, 'VideoEncoder', {
      configurable: true,
      value: InstrumentedVideoEncoder,
    });
  }, { flush: flushMode, support: supportMode, configure: configureMode });
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function probeWebm(bytes: Buffer, outputPath: string): Promise<WebmProbe> {
  await writeFile(outputPath, bytes);
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,duration_time',
    '-show_entries', 'format=duration',
    '-of', 'json',
    outputPath,
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout) as WebmProbe;
}

async function persistTimingProbe(
  page: Page,
  sourceDuration: number,
  cameraObjectId = 'probe-camera',
): Promise<void> {
  await page.evaluate(({ duration, shotCameraObjectId }) => {
    const focalLength = 50;
    const fov = (2 * Math.atan(24 / 2 / focalLength) * 180) / Math.PI;
    const project = {
      uri: `lumora://webm-timing-${duration}`,
      name: 'WebM timing probe',
      schemaVersion: 4,
      createdAt: new Date().toISOString(),
      revision: 0,
      settings: { fps: 24, aspect: [16, 9] },
      activeSceneId: 'probe-scene',
      scenes: [{
        id: 'probe-scene',
        name: 'Probe scene',
        rootObjectIds: ['probe-camera', 'probe-cube', 'probe-light'],
        activeCameraId: 'probe-camera',
      }, {
        id: 'inactive-scene',
        name: 'Inactive scene',
        rootObjectIds: ['inactive-camera'],
        activeCameraId: 'inactive-camera',
      }],
      objects: [
        {
          id: 'probe-camera',
          type: 'camera',
          name: 'Probe camera',
          parentId: null,
          transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
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
          id: 'inactive-camera',
          type: 'camera',
          name: 'Inactive camera',
          parentId: null,
          transform: { position: [2, 1, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
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
          id: 'probe-cube',
          type: 'primitive',
          name: 'Probe cube',
          parentId: null,
          transform: { position: [0, 0, 0], rotation: [0.2, 0.4, 0], scale: [1.5, 1.5, 1.5] },
          visible: true,
          locked: false,
          geometry: { kind: 'box' },
          material: { color: '#e64980' },
        },
        {
          id: 'probe-light',
          type: 'light',
          name: 'Probe light',
          parentId: null,
          transform: { position: [3, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          light: { kind: 'directional', color: '#ffffff', intensity: 1.5 },
        },
      ],
      tracks: [],
      shots: [{
        id: 'probe-shot',
        name: 'Timing probe',
        cameraObjectId: shotCameraObjectId,
        startTime: 0,
        endTime: duration,
      }],
      assets: [],
    };
    localStorage.setItem('lumora.demo.last-export', JSON.stringify(project));
  }, { duration: sourceDuration, shotCameraObjectId: cameraObjectId });
}

async function persistVisualOrderProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const focalLength = 50;
    const fov = (2 * Math.atan(24 / 2 / focalLength) * 180) / Math.PI;
    const camera = (id: string, name: string, x: number, z: number) => ({
      id,
      type: 'camera',
      name,
      parentId: null,
      transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
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
    });
    const subject = (id: string, name: string, x: number, kind: string, color: string) => ({
      id,
      type: 'primitive',
      name,
      parentId: null,
      transform: { position: [x, 0, 0], rotation: [0.2, 0.4, 0], scale: [1.6, 1.6, 1.6] },
      visible: true,
      locked: false,
      geometry: { kind },
      material: { color },
    });
    const project = {
      uri: 'lumora://persisted-three-camera-export',
      name: 'Persisted three-camera export',
      schemaVersion: 4,
      createdAt: new Date().toISOString(),
      revision: 0,
      settings: { fps: 24, aspect: [16, 9] },
      activeSceneId: 'visual-scene',
      scenes: [{
        id: 'visual-scene',
        name: 'Visual order scene',
        rootObjectIds: [
          'camera-red', 'camera-green', 'camera-blue',
          'subject-red', 'subject-green', 'subject-blue', 'visual-light',
        ],
        activeCameraId: 'camera-red',
      }],
      objects: [
        camera('camera-red', 'Red camera', -4, 6),
        camera('camera-green', 'Green camera', 0, 5),
        camera('camera-blue', 'Blue camera', 4, 4),
        subject('subject-red', 'Red box', -4, 'box', '#f03e3e'),
        subject('subject-green', 'Green sphere', 0, 'sphere', '#37b24d'),
        subject('subject-blue', 'Blue cone', 4, 'cone', '#228be6'),
        {
          id: 'visual-light',
          type: 'light',
          name: 'Visual light',
          parentId: null,
          transform: { position: [3, 5, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          light: { kind: 'directional', color: '#ffffff', intensity: 1.8 },
        },
      ],
      tracks: [],
      shots: [
        { id: 'shot-red', name: 'Red view', cameraObjectId: 'camera-red', startTime: 0, endTime: 0.5 },
        { id: 'shot-green', name: 'Green view', cameraObjectId: 'camera-green', startTime: 0.5, endTime: 1 },
        { id: 'shot-blue', name: 'Blue view', cameraObjectId: 'camera-blue', startTime: 1, endTime: 1.5 },
      ],
      assets: [],
    };
    localStorage.setItem('lumora.demo.last-export', JSON.stringify(project));
  });
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

async function observeExportShotOrder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportShotOrder?: string[];
    };
    scope.__lumoraExportShotOrder = [];
    const workspace = document.querySelector('[data-testid="export-workspace"]');
    if (!workspace) throw new Error('Export workspace is not mounted');
    new MutationObserver(() => {
      const status = workspace.querySelector('[data-testid="export-visual-status"]')?.textContent ?? '';
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

async function inspectorPosition(page: Page): Promise<[string, string, string]> {
  return Promise.all([
    page.getByTestId('inspector-axis-0').inputValue(),
    page.getByTestId('inspector-axis-1').inputValue(),
    page.getByTestId('inspector-axis-2').inputValue(),
  ]);
}

async function observeExportLiveAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __lumoraLiveAnnouncements?: string[] };
    scope.__lumoraLiveAnnouncements = [];
    const workspace = document.querySelector('[data-testid="export-workspace"]');
    if (!workspace) throw new Error('Export workspace is not mounted');
    new MutationObserver((records) => {
      const touchesLiveRegion = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest('[data-testid="export-live-status"], [data-testid="export-live-alert"]')) {
          return true;
        }
        return [...record.addedNodes, ...record.removedNodes].some((node) => (
          node instanceof Element && (
            node.matches('[data-testid="export-live-status"], [data-testid="export-live-alert"]') ||
            node.querySelector('[data-testid="export-live-status"], [data-testid="export-live-alert"]') !== null
          )
        ));
      });
      if (!touchesLiveRegion) return;
      const polite = workspace.querySelector('[data-testid="export-live-status"]')?.textContent?.trim() ?? '';
      const assertive = workspace.querySelector('[data-testid="export-live-alert"]')?.textContent?.trim() ?? '';
      const message = assertive || polite;
      const announcements = scope.__lumoraLiveAnnouncements!;
      if (message) announcements.push(message);
    }).observe(workspace, { childList: true, characterData: true, subtree: true });
  });
}

async function exportLiveAnnouncements(page: Page): Promise<string[]> {
  return page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraLiveAnnouncements?: string[] }
  ).__lumoraLiveAnnouncements ?? []);
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
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __lumoraHostShortcutCount?: number };
    scope.__lumoraHostShortcutCount = 0;
    window.addEventListener('keydown', () => {
      scope.__lumoraHostShortcutCount! += 1;
    });
  });

  await trigger.focus();
  await trigger.press('Space');

  await expect(page.getByTestId('export-workspace')).toBeVisible();
  await expect(page.getByTestId('timeline-play')).toHaveText(playBefore ?? '');
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraHostShortcutCount?: number }
  ).__lumoraHostShortcutCount)).toBe(0);
});

for (const key of ['Space', 'Enter'] as const) {
  test(`opens export exactly once with native ${key} inside a real open ShadowRoot`, async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('open-sample-project').click();
    await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
    await moveReactRootIntoOpenShadowRoot(page);
    const trigger = page.getByTestId('open-export-workspace');
    const playBefore = await page.getByTestId('timeline-play').textContent();
    await trigger.evaluate((button) => {
      const scope = globalThis as typeof globalThis & { __lumoraShadowExportClicks?: number };
      scope.__lumoraShadowExportClicks = 0;
      button.addEventListener('click', () => {
        scope.__lumoraShadowExportClicks! += 1;
      });
    });

    await trigger.focus();
    await trigger.press(key);

    await expect(page.getByTestId('export-workspace')).toBeVisible();
    expect(await page.evaluate(() => (
      globalThis as typeof globalThis & { __lumoraShadowExportClicks?: number }
    ).__lumoraShadowExportClicks)).toBe(1);
    await expect(page.getByTestId('timeline-play')).toHaveText(playBefore ?? '');
  });
}

test('keeps Enter and Space export activations from a later host window listener', async ({ page }) => {
  await instrumentWebCodecs(page, 'pending');

  for (const key of ['Enter', 'Space']) {
    await openSampleExport(page);
    await page.getByLabel('导出范围').selectOption('sample-shot-1');
    await page.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __lumoraHostExportKeys?: string[] };
      scope.__lumoraHostExportKeys = [];
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.closest('[data-testid="export-workspace"]')) return;
        scope.__lumoraHostExportKeys!.push(`${event.key}:${target.getAttribute('aria-label') ?? target.textContent?.trim()}`);
      });
    });

    const manifestDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出清单' }).press(key);
    await manifestDownload;

    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /导出 分镜 1.*PNG/ }).press(key);
    await pngDownload;

    const primary = page.getByRole('button', { name: '导出 WebM' });
    await expect(primary).toBeEnabled();
    await primary.press(key);
    const cancel = page.getByRole('button', { name: '取消导出' });
    await expect(cancel).toBeVisible();
    await cancel.press(key);
    await expect(page.getByRole('status')).toContainText('导出已取消');

    await expect(primary).toBeEnabled();
    await primary.press(key);
    await expect(cancel).toBeVisible();
    await cancel.press(key);
    await expect(page.getByRole('status')).toContainText('导出已取消');

    expect(await page.evaluate(() => (
      globalThis as typeof globalThis & { __lumoraHostExportKeys?: string[] }
    ).__lumoraHostExportKeys)).toEqual([]);
  }
});

test('keeps per-frame visual progress while live status uses bounded milestones', async ({ page }) => {
  await instrumentWebCodecs(page);
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');
  await page.getByLabel('分辨率').selectOption('480p');
  await observeExportLiveAnnouncements(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 WebM' }).click();
  await download;
  await expect(page.getByTestId('export-live-status')).toContainText('导出完成');

  const evidence = await page.evaluate(() => ({
    announcements: (
      globalThis as typeof globalThis & { __lumoraLiveAnnouncements?: string[] }
    ).__lumoraLiveAnnouncements ?? [],
    progressValues: (
      globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
    ).__lumoraExportInstrumentation.progressValues,
  }));
  const running = evidence.announcements.filter((message) => message.startsWith('正在导出'));
  expect(evidence.progressValues.length).toBeGreaterThan(10);
  expect(running).toEqual([
    '正在导出 0%',
    '正在导出 25%',
    '正在导出 50%',
    '正在导出 75%',
  ]);
  expect(running.length).toBeLessThan(evidence.progressValues.length);
  expect(evidence.announcements.filter((message) => message === '导出完成')).toHaveLength(1);
});

test('emits raw live-region mutations for repeated identical manifest PNG and WebM successes', async ({ page }) => {
  await instrumentWebCodecs(page);
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');
  await page.getByLabel('分辨率').selectOption('480p');
  await observeExportLiveAnnouncements(page);

  for (let index = 0; index < 2; index += 1) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出清单' }).click();
    await download;
    await expect.poll(async () => (
      await exportLiveAnnouncements(page)
    ).filter((message) => message === '分镜清单已导出').length).toBe(index + 1);
  }

  const pngSuccess = '已导出「分镜 1 · 开场全景」PNG';
  for (let index = 0; index < 2; index += 1) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /导出 分镜 1.*PNG/ }).click();
    await download;
    await expect.poll(async () => (
      await exportLiveAnnouncements(page)
    ).filter((message) => message === pngSuccess).length).toBe(index + 1);
  }

  for (let index = 0; index < 2; index += 1) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 WebM' }).click();
    await download;
    await expect.poll(async () => (
      await exportLiveAnnouncements(page)
    ).filter((message) => message === '导出完成').length).toBe(index + 1);
  }
});

test('emits raw live-region mutations for repeated identical preflight errors', async ({ page }) => {
  await instrumentWebCodecs(page);
  await page.goto('/');
  await persistTimingProbe(page, 0.1, 'inactive-camera');
  await page.getByTestId('reopen-last-export').click();
  await expect(page.getByTestId('tree-row-probe-cube')).toBeVisible();
  await page.getByTestId('open-export-workspace').click();
  await observeExportLiveAnnouncements(page);

  let webmError = '';
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: '导出 WebM' }).click();
    const alert = page.getByTestId('export-live-alert');
    await expect(alert).toBeVisible();
    webmError ||= (await alert.textContent())?.trim() ?? '';
    await expect.poll(async () => (
      await exportLiveAnnouncements(page)
    ).filter((message) => message === webmError).length).toBe(index + 1);
  }

  let pngError = '';
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: /导出 Timing probe PNG/ }).click();
    const alert = page.getByTestId('export-live-alert');
    await expect(alert).toContainText('未绑定活动场景中的有效机位');
    pngError ||= (await alert.textContent())?.trim() ?? '';
    await expect.poll(async () => (
      await exportLiveAnnouncements(page)
    ).filter((message) => message === pngError).length).toBe(index + 1);
  }
});

test('announces WebM cancellation exactly once', async ({ page }) => {
  await instrumentWebCodecs(page, 'pending');
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');
  await observeExportLiveAnnouncements(page);

  await page.getByRole('button', { name: '导出 WebM' }).click();
  const cancel = page.getByRole('button', { name: '取消导出' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByRole('status')).toContainText('导出已取消');

  await expect.poll(async () => (
    await exportLiveAnnouncements(page)
  ).filter((message) => message === '导出已取消')).toEqual(['导出已取消']);
});

test('announces a WebM error exactly once through the assertive region', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'native', 'fail-once');
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');
  await observeExportLiveAnnouncements(page);

  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByTestId('export-live-alert')).toContainText('Injected WebCodecs configure failure');

  await expect.poll(async () => (
    await exportLiveAnnouncements(page)
  ).filter((message) => message.includes('Injected WebCodecs configure failure'))).toHaveLength(1);
});

test('retains the quantized terminal packet in real 24fps and 30fps WebM artifacts', async ({ page }, testInfo) => {
  const cases = [
    { frames: 14, fps: 24, sourceDuration: 0.58 },
    { frames: 45, fps: 30, sourceDuration: 1.49 },
  ] as const;

  for (const probeCase of cases) {
    await page.goto('/');
    await persistTimingProbe(page, probeCase.sourceDuration);
    await page.reload();
    await page.getByTestId('reopen-last-export').click();
    await expect(page.getByTestId('tree-row-probe-cube')).toBeVisible();
    await page.getByTestId('open-export-workspace').click();
    await page.getByLabel('分辨率').selectOption('480p');
    await page.getByLabel('帧率').selectOption(String(probeCase.fps));

    const { bytes } = await exportWebm(page);
    const probe = await probeWebm(
      bytes,
      testInfo.outputPath(`terminal-${probeCase.frames}-${probeCase.fps}.webm`),
    );
    await testInfo.attach(`ffprobe-${probeCase.frames}-${probeCase.fps}`, {
      body: Buffer.from(JSON.stringify(probe, null, 2)),
      contentType: 'application/json',
    });

    const quantizedDuration = probeCase.frames / probeCase.fps;
    const tolerance = 1 / probeCase.fps / 4;
    expect(Math.abs(probeCase.sourceDuration - quantizedDuration)).toBeLessThan(1 / probeCase.fps / 2);
    expect(probe.packets).toHaveLength(probeCase.frames + 1);
    expect(Math.abs(Number(probe.packets.at(-1)!.pts_time) - quantizedDuration)).toBeLessThan(tolerance);
    expect(Math.abs(Number(probe.format.duration) - quantizedDuration)).toBeLessThan(tolerance);
  }
});

test('reopens and exports three visually distinct camera shots in order', async ({ page }) => {
  await page.goto('/');
  await persistVisualOrderProbe(page);
  await page.reload();
  await page.getByTestId('reopen-last-export').click();
  await expect(page.getByTestId('tree-row-camera-red')).toBeVisible();
  await expect(page.getByTestId('tree-row-camera-green')).toBeVisible();
  await expect(page.getByTestId('tree-row-camera-blue')).toBeVisible();
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  await page.getByLabel('分辨率').selectOption('480p');
  await expect(page.getByLabel('帧率')).toHaveValue('24');
  const referencePngs = [
    await exportShotPng(page, /导出 Red view.*PNG/),
    await exportShotPng(page, /导出 Green view.*PNG/),
    await exportShotPng(page, /导出 Blue view.*PNG/),
  ];

  const { bytes, order } = await exportWebm(page);
  expect(bytes.length).toBeGreaterThan(1_000);
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(order).toEqual(['Red view', 'Green view', 'Blue view']);

  const metadata = await inspectWebm(page, bytes, referencePngs, [0.25, 0.75, 1.25]);
  expect(metadata.width).toBe(854);
  expect(metadata.height).toBe(480);
  expect(Math.abs(metadata.duration - 1.5)).toBeLessThan(1 / 96);
  expect(metadata.decodedPixelCount).toBeGreaterThan(854 * 480 * 0.9);
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

test('reports missing WebCodecs before encoding or downloading a file', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportInstrumentation?: ExportInstrumentation;
    };
    scope.__lumoraExportInstrumentation = {
      encoderConstructions: 0,
      encoderConfigures: 0,
      encoderEncodes: 0,
      encoderFlushes: 0,
      encoderCloses: 0,
      maxEncodeQueueSize: 0,
      supportChecks: 0,
      supportConfigs: [],
      captureStreams: 0,
      progressValues: [],
    };
    const originalCaptureStream = HTMLCanvasElement.prototype.captureStream;
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: function captureStream(this: HTMLCanvasElement, frameRate?: number) {
        scope.__lumoraExportInstrumentation!.captureStreams += 1;
        return originalCaptureStream.call(this, frameRate);
      },
    });
    Object.defineProperty(globalThis, 'VideoEncoder', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'VideoFrame', {
      configurable: true,
      value: undefined,
    });
  });
  let downloads = 0;
  page.on('download', () => downloads += 1);

  await openSampleExport(page);
  await expect(page.getByRole('alert')).toContainText('不支持 WebCodecs VideoEncoder');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  await page.waitForTimeout(200);

  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.encoderConstructions).toBe(0);
  expect(instrumentation.captureStreams).toBe(0);
  expect(downloads).toBe(0);
});

test('cancels encoding, closes WebCodecs, and returns to an editable project', async ({ page }) => {
  await instrumentWebCodecs(page);
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
  expect(instrumentation.encoderConstructions).toBe(1);
  expect(instrumentation.encoderCloses).toBe(1);
  expect(instrumentation.captureStreams).toBe(0);
  expect(downloads).toBe(0);

  await page.getByRole('button', { name: '关闭导出' }).click();
  await expect(page.getByTestId('open-export-workspace')).toBeFocused();
  const rows = page.locator('.lumora-tree-row');
  const before = await rows.count();
  await page.getByTestId('add-object').click();
  await page.getByTestId('add-立方体').click();
  await expect(rows).toHaveCount(before + 1);
});

test('cancels a long native WebCodecs export before all frames with a bounded queue', async ({ page }, testInfo) => {
  await instrumentWebCodecs(page);
  let downloads = 0;
  page.on('download', () => downloads += 1);
  await page.goto('/');
  await persistTimingProbe(page, 8);
  await page.getByTestId('reopen-last-export').click();
  await expect(page.getByTestId('tree-row-probe-cube')).toBeVisible();
  await page.getByTestId('open-export-workspace').click();
  await expect(page.getByTestId('export-workspace')).toBeVisible();
  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByRole('button', { name: '取消导出' })).toBeVisible();

  const cancellation = await page.evaluate(() => new Promise<{
    encoderEncodes: number;
    progress: number;
    progressWrites: number;
    positiveProgressWrites: number;
    lastProgressWrite: number | undefined;
  }>((resolve, reject) => {
    const startedAt = performance.now();
    const poll = () => {
      const scope = globalThis as typeof globalThis & {
        __lumoraExportInstrumentation: ExportInstrumentation;
      };
      const instrumentation = scope.__lumoraExportInstrumentation;
      const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '取消导出');
      const progress = document.querySelector<HTMLProgressElement>('[aria-label="导出进度"]');
      const positiveProgressWrites = instrumentation.progressValues.filter((value) => value > 0).length;
      const lastProgressWrite = instrumentation.progressValues.at(-1);
      if (
        instrumentation.encoderEncodes > 0
        && cancel
        && progress
        && progress.value > 0
        && positiveProgressWrites > 0
        && lastProgressWrite === progress.value
      ) {
        const snapshot = {
          encoderEncodes: instrumentation.encoderEncodes,
          progress: progress.value,
          progressWrites: instrumentation.progressValues.length,
          positiveProgressWrites,
          lastProgressWrite,
        };
        cancel.click();
        resolve(snapshot);
        return;
      }
      if (performance.now() - startedAt > 5_000) {
        reject(new Error('Encoding and committed DOM progress did not begin before the cancellation deadline'));
        return;
      }
      setTimeout(poll, 0);
    };
    poll();
  }));

  await expect(page.getByRole('status')).toContainText('导出已取消');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
  const readCancellationState = () => page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __lumoraExportInstrumentation: ExportInstrumentation;
    };
    return {
      instrumentation: scope.__lumoraExportInstrumentation,
    };
  });
  const settled = await readCancellationState();
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const afterMacroTask = await readCancellationState();

  expect(cancellation.encoderEncodes).toBeGreaterThan(0);
  expect(cancellation.progress).toBeGreaterThan(0);
  expect(cancellation.positiveProgressWrites).toBeGreaterThan(0);
  expect(cancellation.lastProgressWrite).toBe(cancellation.progress);
  expect(settled.instrumentation.encoderEncodes).toBe(cancellation.encoderEncodes);
  expect(afterMacroTask.instrumentation.encoderEncodes).toBe(cancellation.encoderEncodes);
  expect(settled.instrumentation.progressValues).toHaveLength(cancellation.progressWrites);
  expect(afterMacroTask.instrumentation.progressValues).toHaveLength(cancellation.progressWrites);
  expect(settled.instrumentation.progressValues.at(-1)).toBe(cancellation.progress);
  expect(afterMacroTask.instrumentation.progressValues.at(-1)).toBe(cancellation.progress);
  await expect(page.getByRole('status')).toContainText('导出已取消');
  expect(afterMacroTask.instrumentation.encoderEncodes).toBeLessThan(8 * 24);
  const instrumentation = afterMacroTask.instrumentation;
  expect(instrumentation.maxEncodeQueueSize).toBeLessThanOrEqual(4);
  expect(instrumentation.encoderConstructions).toBe(1);
  expect(instrumentation.encoderCloses).toBe(1);
  expect(downloads).toBe(0);
  await testInfo.attach('long-export-backpressure-evidence', {
    body: Buffer.from(JSON.stringify({
      sourceFrames: 8 * 24,
      encodedAtCancellation: cancellation.encoderEncodes,
      encodedFramesWhenSettled: instrumentation.encoderEncodes,
      progressAtCancellation: cancellation.progress,
      positiveProgressWritesAtCancellation: cancellation.positiveProgressWrites,
      lastProgressWriteAtCancellation: cancellation.lastProgressWrite,
      progressAfterMacroTask: afterMacroTask.instrumentation.progressValues.at(-1),
      progressWritesAtCancellation: cancellation.progressWrites,
      progressWritesAfterMacroTask: afterMacroTask.instrumentation.progressValues.length,
      maxEncodeQueueSize: instrumentation.maxEncodeQueueSize,
      encoderConstructions: instrumentation.encoderConstructions,
      encoderCloses: instrumentation.encoderCloses,
      downloads,
    }, null, 2)),
    contentType: 'application/json',
  });
});

test('keeps WebM disabled while the native VP8 configuration check is pending', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'pending');
  await openSampleExport(page);

  await expect(page.getByRole('status')).toContainText('正在检查 VP8');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.supportChecks).toBeGreaterThanOrEqual(1);
  expect(instrumentation.supportConfigs[0]).toMatchObject({
    codec: 'vp8',
    width: 1280,
    height: 720,
    bitrate: 6_000_000,
    framerate: 24,
  });
  expect(instrumentation.encoderConstructions).toBe(0);
});

test('reports an unsupported native VP8 configuration without constructing an encoder', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'unsupported');
  await openSampleExport(page);

  await expect(page.getByRole('alert')).toContainText('不支持当前分辨率');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.supportChecks).toBeGreaterThanOrEqual(1);
  expect(instrumentation.encoderConstructions).toBe(0);
});

test('reports a failed native VP8 configuration check without constructing an encoder', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'reject');
  await openSampleExport(page);

  await expect(page.getByRole('alert')).toContainText('Injected VP8 capability failure');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.supportChecks).toBeGreaterThanOrEqual(1);
  expect(instrumentation.encoderConstructions).toBe(0);
});

test('ignores a stale VP8 preflight result after the selected resolution changes', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'deferred');
  await openSampleExport(page);
  await expect(page.getByRole('status')).toContainText('正在检查 VP8');
  await expect.poll(async () => page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation.supportChecks)).toBeGreaterThan(0);
  const initialChecks = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation.supportChecks);

  await page.getByLabel('分辨率').selectOption('480p');
  await expect.poll(async () => page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation.supportChecks)).toBe(initialChecks + 1);
  await page.evaluate((index) => (
    globalThis as typeof globalThis & {
      __lumoraResolveSupportCheck(index: number, supported: boolean): void;
    }
  ).__lumoraResolveSupportCheck(index, true), initialChecks);
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeEnabled();

  await page.evaluate((count) => {
    const scope = globalThis as typeof globalThis & {
      __lumoraResolveSupportCheck(index: number, supported: boolean): void;
    };
    for (let index = 0; index < count; index += 1) {
      scope.__lumoraResolveSupportCheck(index, false);
    }
  }, initialChecks);
  await page.waitForTimeout(50);
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
  await expect(page.getByText('WebM · VP8')).toBeVisible();
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.supportConfigs.slice(0, initialChecks).every((config) => config.width === 1280)).toBe(true);
  expect(instrumentation.supportConfigs.at(-1)?.width).toBe(854);
  expect(instrumentation.encoderConstructions).toBe(0);
});

test('keeps an unsupported VP8 config disabled when a stale config later reports support', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'deferred');
  let downloads = 0;
  page.on('download', () => downloads += 1);
  await openSampleExport(page);
  await expect(page.getByRole('status')).toContainText('正在检查 VP8');
  await expect.poll(async () => page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation.supportChecks)).toBeGreaterThan(0);
  const initialChecks = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation.supportChecks);

  await page.getByLabel('分辨率').selectOption('480p');
  await expect.poll(async () => page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation.supportChecks)).toBe(initialChecks + 1);
  await page.evaluate((index) => (
    globalThis as typeof globalThis & {
      __lumoraResolveSupportCheck(index: number, supported: boolean): void;
    }
  ).__lumoraResolveSupportCheck(index, false), initialChecks);
  await expect(page.getByRole('alert')).toContainText('不支持当前分辨率');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();

  await page.evaluate((count) => {
    const scope = globalThis as typeof globalThis & {
      __lumoraResolveSupportCheck(index: number, supported: boolean): void;
    };
    for (let index = 0; index < count; index += 1) {
      scope.__lumoraResolveSupportCheck(index, true);
    }
  }, initialChecks);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('不支持当前分辨率');
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.supportConfigs.slice(0, initialChecks).every((config) => config.width === 1280)).toBe(true);
  expect(instrumentation.supportConfigs.at(-1)?.width).toBe(854);
  expect(instrumentation.encoderConstructions).toBe(0);
  expect(instrumentation.encoderConfigures).toBe(0);
  expect(instrumentation.encoderEncodes).toBe(0);
  expect(downloads).toBe(0);
});

test('closes a configure-failed encoder and remains retryable', async ({ page }) => {
  await instrumentWebCodecs(page, 'native', 'native', 'fail-once');
  let downloads = 0;
  page.on('download', () => downloads += 1);
  await openSampleExport(page);

  const primary = page.getByRole('button', { name: '导出 WebM' });
  await primary.click();
  await expect(page.getByRole('alert')).toContainText('Injected WebCodecs configure failure');
  await expect(primary).toBeEnabled();
  await expect(primary).toBeFocused();
  let instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.encoderConstructions).toBe(1);
  expect(instrumentation.encoderConfigures).toBe(1);
  expect(instrumentation.encoderEncodes).toBe(0);
  expect(instrumentation.encoderCloses).toBe(1);
  expect(downloads).toBe(0);

  const downloadPromise = page.waitForEvent('download');
  await primary.click();
  await downloadPromise;
  await expect(page.getByRole('status')).toContainText('导出完成');
  await expect(primary).toBeFocused();
  instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.encoderConstructions).toBe(2);
  expect(instrumentation.encoderConfigures).toBe(2);
  expect(instrumentation.encoderCloses).toBe(2);
  expect(downloads).toBe(1);
});

test('restores focus to the initiating button after the first WebM success', async ({ page }) => {
  await instrumentWebCodecs(page);
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');
  await page.getByLabel('分辨率').selectOption('480p');
  const primary = page.getByRole('button', { name: '导出 WebM' });

  const download = page.waitForEvent('download');
  await primary.click();
  await download;

  await expect(page.getByRole('status')).toContainText('导出完成');
  await expect(primary).toBeEnabled();
  await expect(primary).toBeFocused();
});

test('proves live camera drive sensitivity before isolating editor shortcuts while export is idle and encoding', async ({ page }) => {
  await instrumentWebCodecs(page, 'pending');
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-camera-2')).toBeVisible();
  await page.getByTestId('tree-row-sample-camera-2').click();
  const rows = page.locator('.lumora-tree-row');
  const rowCount = await rows.count();
  const cameraPositionBeforeDrive = await inspectorPosition(page);
  const playBefore = await page.getByTestId('timeline-play').textContent();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('w');
  try {
    await expect.poll(() => inspectorPosition(page)).not.toEqual(cameraPositionBeforeDrive);
    await page.getByTestId('open-export-workspace').click();
    await expect(page.getByTestId('export-workspace')).toBeVisible();
    const frozenPosition = await inspectorPosition(page);
    expect(frozenPosition).not.toEqual(cameraPositionBeforeDrive);
    await page.waitForTimeout(150);
    expect(await inspectorPosition(page)).toEqual(frozenPosition);
  } finally {
    await page.keyboard.up('w');
  }
  const cameraPositionBefore = await inspectorPosition(page);

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
  expect(await inspectorPosition(page)).toEqual(cameraPositionBefore);

  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByLabel('导出进度')).not.toHaveJSProperty('value', 0);
  await pressEditorShortcuts();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(rows).toHaveCount(rowCount);
  await expect(page.getByTestId('tree-row-sample-camera-2')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('timeline-play')).toHaveText(playBefore ?? '');
  expect(await inspectorPosition(page)).toEqual(cameraPositionBefore);
  await page.getByRole('button', { name: '取消导出' }).click();
  await expect(page.getByRole('status')).toContainText('导出已取消');
});

test('cancels at 100% finalization without downloading and remains retryable', async ({ page }) => {
  await instrumentWebCodecs(page, 'pending');
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
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.encoderConstructions).toBe(2);
  expect(instrumentation.encoderFlushes).toBe(2);
  expect(instrumentation.encoderCloses).toBe(2);
  expect(instrumentation.captureStreams).toBe(0);
});

test('surfaces a WebCodecs flush failure and remains retryable', async ({ page }) => {
  await instrumentWebCodecs(page, 'fail-once');
  let downloads = 0;
  page.on('download', () => downloads += 1);
  await openSampleExport(page);
  await page.getByLabel('导出范围').selectOption('sample-shot-1');

  await page.getByRole('button', { name: '导出 WebM' }).click();
  await expect(page.getByRole('alert')).toContainText('Injected WebCodecs flush failure');
  await expect(page.getByRole('button', { name: '导出 WebM' })).toBeFocused();
  expect(downloads).toBe(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 WebM' }).click();
  await downloadPromise;
  await expect(page.getByRole('status')).toContainText('导出完成');
  expect(downloads).toBe(1);
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.encoderConstructions).toBe(2);
  expect(instrumentation.encoderFlushes).toBe(2);
  expect(instrumentation.encoderCloses).toBe(2);
  expect(instrumentation.captureStreams).toBe(0);
});

test('invalidates an old export when the same project URI is reopened', async ({ page }) => {
  await instrumentWebCodecs(page);
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
  const instrumentation = await page.evaluate(() => (
    globalThis as typeof globalThis & { __lumoraExportInstrumentation: ExportInstrumentation }
  ).__lumoraExportInstrumentation);
  expect(instrumentation.encoderConstructions).toBe(1);
  expect(instrumentation.encoderCloses).toBe(1);
  expect(instrumentation.captureStreams).toBe(0);
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
