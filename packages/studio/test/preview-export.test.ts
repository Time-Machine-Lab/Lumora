import { describe, expect, it, vi } from 'vitest';
import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import {
  PreviewExportError,
  buildStoryboardManifest,
  createPreviewExportPlan,
  detectWebmSupport,
  recordPreviewWebm,
} from '../src/export/preview-export';
import type {
  PreviewEncodedFrame,
  PreviewEncoderSession,
  PreviewExportPlan,
  PreviewRecordingDependencies,
} from '../src/export/preview-export';

function sampleProject(): Project {
  return createSampleProject('lumora://export-test', '导出测试');
}

describe('preview export contract', () => {
  it('preserves storyboard order and computes the exact 720p/24fps frame plan', () => {
    const project = sampleProject();
    const result = createPreviewExportPlan(project, {
      shotIds: ['sample-shot-3', 'sample-shot-1'],
      resolution: '720p',
      fps: 24,
      mimeType: 'video/webm;codecs=vp8',
    });

    expect(result).toEqual({
      ok: true,
      plan: expect.objectContaining({
        width: 1280,
        height: 720,
        fps: 24,
        mimeType: 'video/webm;codecs=vp8',
        duration: 3,
        totalFrames: 72,
        shots: [
          expect.objectContaining({ id: 'sample-shot-1' }),
          expect.objectContaining({ id: 'sample-shot-3' }),
        ],
      }),
    });
  });

  it('allocates frames from cumulative shot boundaries without per-shot rounding drift', () => {
    const project = sampleProject();
    const result = createPreviewExportPlan({
      ...project,
      shots: project.shots.map((shot, index) => ({
        ...shot,
        startTime: index * 0.06,
        endTime: index * 0.06 + 0.06,
      })),
    }, {
      shotIds: project.shots.map((shot) => shot.id),
      resolution: '720p',
      fps: 24,
      mimeType: 'video/webm;codecs=vp8',
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        totalFrames: 4,
        shots: [
          { frameCount: 1 },
          { frameCount: 2 },
          { frameCount: 1 },
        ],
      },
    });
  });

  it('rejects an empty range and shots without a valid camera before encoding', () => {
    const project = sampleProject();
    expect(
      createPreviewExportPlan(project, {
        shotIds: [],
        resolution: '720p',
        fps: 24,
        mimeType: 'video/webm',
      }),
    ).toEqual({ ok: false, code: 'no-shots', message: expect.stringContaining('分镜') });

    const invalid: Project = {
      ...project,
      shots: [{ ...project.shots[0]!, cameraObjectId: 'missing-camera' }],
    };
    expect(
      createPreviewExportPlan(invalid, {
        shotIds: ['sample-shot-1'],
        resolution: '720p',
        fps: 24,
        mimeType: 'video/webm',
      }),
    ).toEqual({
      ok: false,
      code: 'invalid-shot',
      message: expect.stringContaining('有效机位'),
    });
  });

  it('rejects a shot whose camera is outside the active scene', () => {
    const project = sampleProject();
    const activeScene = project.scenes[0]!;
    const inactiveCamera: Project = {
      ...project,
      scenes: [
        {
          ...activeScene,
          rootObjectIds: activeScene.rootObjectIds.filter((id) => id !== 'sample-camera'),
        },
        {
          id: 'scene-2',
          name: '备用场景',
          rootObjectIds: ['sample-camera'],
          activeCameraId: 'sample-camera',
        },
      ],
      shots: [{ ...project.shots[0]!, cameraObjectId: 'sample-camera' }],
    };

    expect(
      createPreviewExportPlan(inactiveCamera, {
        shotIds: ['sample-shot-1'],
        resolution: '720p',
        fps: 24,
        mimeType: 'video/webm',
      }),
    ).toEqual({
      ok: false,
      code: 'invalid-shot',
      message: expect.stringContaining('有效机位'),
    });
  });

  it('detects WebCodecs support without constructing an encoder', () => {
    expect(
      detectWebmSupport({
        hasVideoEncoder: true,
        hasVideoFrame: true,
      }),
    ).toEqual({ supported: true, mimeType: 'video/webm;codecs=vp8' });

    expect(
      detectWebmSupport({
        hasVideoEncoder: false,
        hasVideoFrame: true,
      }),
    ).toEqual({ supported: false, reason: expect.stringContaining('VideoEncoder') });
  });

  it('builds a structured storyboard manifest without assets or plugin settings', () => {
    const project: Project = {
      ...sampleProject(),
      pluginData: { 'com.example.private': { apiKey: 'must-not-export' } },
      assets: [
        {
          id: 'asset-secret',
          kind: 'gltf',
          name: 'large.glb',
          mime: 'model/gltf-binary',
          hash: 'abc',
          size: 1,
          source: 'file',
          storageRef: 'blob:secret',
          payload: 'PRIVATE_BASE64',
          createdAt: '2026-08-27T00:00:00.000Z',
        },
      ],
    };
    const manifest = buildStoryboardManifest(
      project,
      ['sample-shot-2', 'sample-shot-1'],
      '2026-08-27T01:02:03.000Z',
    );

    expect(manifest).toEqual({
      format: 'lumora.storyboard',
      version: 1,
      exportedAt: '2026-08-27T01:02:03.000Z',
      project: {
        uri: 'lumora://export-test',
        name: '导出测试',
        schemaVersion: 4,
        revision: 0,
        aspect: [16, 9],
      },
      shots: [
        expect.objectContaining({ id: 'sample-shot-1', order: 0, duration: 1.5 }),
        expect.objectContaining({ id: 'sample-shot-2', order: 1, duration: 1.5 }),
      ],
    });
    expect(JSON.stringify(manifest)).not.toMatch(/must-not-export|PRIVATE_BASE64|blob:secret/);
  });

  it('preserves selected unbound shots and their contiguous manifest order', () => {
    const project = sampleProject();
    const withUnboundShot: Project = {
      ...project,
      shots: [
        { ...project.shots[0]!, cameraObjectId: null },
        project.shots[1]!,
      ],
    };

    const manifest = buildStoryboardManifest(
      withUnboundShot,
      ['sample-shot-1', 'sample-shot-2'],
      '2026-08-27T01:02:03.000Z',
    );

    expect(manifest.shots).toEqual([
      expect.objectContaining({ id: 'sample-shot-1', order: 0, cameraObjectId: null }),
      expect.objectContaining({ id: 'sample-shot-2', order: 1, cameraObjectId: 'sample-camera-2' }),
    ]);
  });
});

interface EncoderHarness {
  encoder: PreviewEncoderSession & {
    encodeFrame: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  encodedFrames: PreviewEncodedFrame[];
  canvas: HTMLCanvasElement;
  deps: PreviewRecordingDependencies;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function encoderHarness(blob = new Blob(['webm-bytes'], { type: 'video/webm;codecs=vp8' })): EncoderHarness {
  const encodedFrames: PreviewEncodedFrame[] = [];
  const canvas = {
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
  const encoder = {
    encodeFrame: vi.fn((_canvas, frame) => encodedFrames.push({ ...frame })),
    flush: vi.fn(async () => blob),
    close: vi.fn(),
  } as PreviewEncoderSession & {
    encodeFrame: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  return {
    encoder,
    encodedFrames,
    canvas,
    deps: {
      createCanvas: () => canvas,
      createEncoder: () => encoder,
    },
  };
}

function shortPlan(): PreviewExportPlan {
  const project = sampleProject();
  const result = createPreviewExportPlan(project, {
    shotIds: ['sample-shot-1', 'sample-shot-2'],
    resolution: '480p',
    fps: 24,
    mimeType: 'video/webm;codecs=vp8',
  });
  if (!result.ok) throw new Error(result.message);
  return {
    ...result.plan,
    shots: result.plan.shots.map((shot, index) => ({
      ...shot,
      startTime: index * 0.125,
      endTime: index * 0.125 + 0.125,
      frameCount: 3,
    })),
    duration: 0.25,
    totalFrames: 6,
  };
}

describe('recordPreviewWebm', () => {
  it('renders frames in shot order, reports monotonic progress, and closes the encoder', async () => {
    const harness = encoderHarness();
    const rendered: Array<{ shot: string; sourceTime: number }> = [];
    const progress: number[] = [];

    const blob = await recordPreviewWebm(
      shortPlan(),
      ({ shot, sourceTime }) => {
        rendered.push({ shot: shot.id, sourceTime });
        return true;
      },
      {
        onProgress: (event) => progress.push(event.completedFrames),
        dependencies: harness.deps,
      },
    );

    expect(blob.type).toBe('video/webm;codecs=vp8');
    expect(blob.size).toBeGreaterThan(0);
    expect(rendered.map((frame) => frame.shot)).toEqual([
      'sample-shot-1',
      'sample-shot-1',
      'sample-shot-1',
      'sample-shot-2',
      'sample-shot-2',
      'sample-shot-2',
    ]);
    expect(rendered[0]!.sourceTime).toBe(0);
    expect(rendered[3]!.sourceTime).toBe(0.125);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(harness.encodedFrames).toHaveLength(7);
    expect(harness.encodedFrames.map((frame) => frame.timestamp)).toEqual([
      0, 41_667, 83_333, 125_000, 166_667, 208_333, 250_000,
    ]);
    expect(harness.encodedFrames[0]).toMatchObject({ duration: 41_667, keyFrame: true });
    expect(harness.encodedFrames.at(-1)).toMatchObject({ timestamp: 250_000, keyFrame: false });
    expect(harness.encoder.flush).toHaveBeenCalledTimes(1);
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('uses exact media timestamps independent of render execution time', async () => {
    const harness = encoderHarness();
    let renderCost = 0;

    await recordPreviewWebm(shortPlan(), () => {
      renderCost += 73;
      return true;
    }, { dependencies: harness.deps });

    expect(renderCost).toBe(6 * 73);
    expect(harness.encodedFrames.map((frame) => frame.timestamp)).toEqual([
      0, 41_667, 83_333, 125_000, 166_667, 208_333, 250_000,
    ]);
  });

  it('waits for encoder flush before returning and closing', async () => {
    const harness = encoderHarness();
    const flushed = deferred<Blob>();
    harness.encoder.flush.mockImplementation(() => flushed.promise);

    const recording = recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps });
    await vi.waitFor(() => expect(harness.encoder.flush).toHaveBeenCalledTimes(1));
    expect(harness.encoder.close).not.toHaveBeenCalled();

    flushed.resolve(new Blob(['webm'], { type: 'video/webm;codecs=vp8' }));
    await expect(recording).resolves.toMatchObject({ type: 'video/webm;codecs=vp8' });
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('cancels while encoder flush is pending', async () => {
    const harness = encoderHarness();
    const controller = new AbortController();
    harness.encoder.flush.mockImplementation(() => {
      controller.abort();
      return new Promise<Blob>(() => undefined);
    });

    await expect(recordPreviewWebm(shortPlan(), () => true, {
      dependencies: harness.deps,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending encoder flush when operation ownership becomes stale', async () => {
    const harness = encoderHarness();
    let operationCurrent = true;
    harness.encoder.flush.mockImplementation(() => new Promise<Blob>(() => undefined));

    const recording = recordPreviewWebm(shortPlan(), () => true, {
      dependencies: harness.deps,
      isOperationCurrent: () => operationCurrent,
    });
    await vi.waitFor(() => expect(harness.encoder.flush).toHaveBeenCalledTimes(1));
    operationCurrent = false;

    await expect(recording).rejects.toMatchObject(
      { code: 'cancelled' } satisfies Partial<PreviewExportError>,
    );
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('settles immediately when encoder flush fails', async () => {
    const harness = encoderHarness();
    harness.encoder.flush.mockRejectedValue(new Error('codec failed'));

    await expect(
      recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('times out a missing encoder flush and remains retryable', async () => {
    const harness = encoderHarness();
    harness.encoder.flush.mockImplementation(() => new Promise<Blob>(() => undefined));

    await expect(recordPreviewWebm(shortPlan(), () => true, {
      dependencies: harness.deps,
      finalizationTimeoutMs: 5,
    })).rejects.toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);

    const retryHarness = encoderHarness();
    await expect(
      recordPreviewWebm(shortPlan(), () => true, { dependencies: retryHarness.deps }),
    ).resolves.toMatchObject({ type: 'video/webm;codecs=vp8' });
  });

  it('does not encode a frame after the operation becomes stale while renderFrame awaits', async () => {
    const harness = encoderHarness();
    let operationCurrent = true;

    await expect(
      recordPreviewWebm(
        shortPlan(),
        async () => {
          await Promise.resolve();
          operationCurrent = false;
          return true;
        },
        { dependencies: harness.deps, isOperationCurrent: () => operationCurrent },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('cancels without a file and closes the encoder', async () => {
    const harness = encoderHarness();
    const controller = new AbortController();
    let frames = 0;

    await expect(
      recordPreviewWebm(
        shortPlan(),
        () => {
          frames += 1;
          if (frames === 2) controller.abort();
          return true;
        },
        { signal: controller.signal, dependencies: harness.deps },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.flush).not.toHaveBeenCalled();
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation during 100% encoder finalization and returns no blob', async () => {
    const harness = encoderHarness();
    const controller = new AbortController();
    harness.encoder.flush.mockImplementation(async () => {
      controller.abort();
      return new Blob(['must-not-download']);
    });

    await expect(
      recordPreviewWebm(shortPlan(), () => true, {
        signal: controller.signal,
        dependencies: harness.deps,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('reports capture failure and still releases encoder resources', async () => {
    const harness = encoderHarness();

    await expect(
      recordPreviewWebm(shortPlan(), () => false, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'capture-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });

  it('releases the canvas when encoder construction fails', async () => {
    const harness = encoderHarness();
    harness.deps.createEncoder = vi.fn(() => {
      throw new Error('encoder unavailable');
    });

    await expect(
      recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.canvas.width).toBe(1);
    expect(harness.canvas.height).toBe(1);
  });

  it('rejects an empty muxer result and closes the encoder', async () => {
    const harness = encoderHarness(new Blob([], { type: 'video/webm;codecs=vp8' }));

    await expect(
      recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.encoder.close).toHaveBeenCalledTimes(1);
  });
});
