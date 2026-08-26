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
  MediaRecorderLike,
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

  it('detects browser and codec support without constructing a recorder', () => {
    const isTypeSupported = vi.fn((mime: string) => mime.includes('vp8'));
    expect(
      detectWebmSupport({
        hasMediaRecorder: true,
        hasCanvasCaptureStream: true,
        isTypeSupported,
      }),
    ).toEqual({ supported: true, mimeType: 'video/webm;codecs=vp8' });
    expect(isTypeSupported).toHaveBeenCalled();

    expect(
      detectWebmSupport({
        hasMediaRecorder: false,
        hasCanvasCaptureStream: true,
        isTypeSupported,
      }),
    ).toEqual({ supported: false, reason: expect.stringContaining('MediaRecorder') });
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

interface RecorderHarness {
  recorder: MediaRecorderLike;
  track: { requestFrame?: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  stream: MediaStream;
  deps: PreviewRecordingDependencies;
}

function recorderHarness(chunk = new Blob(['webm-bytes'], { type: 'video/webm' })): RecorderHarness {
  const track = { requestFrame: vi.fn(), stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const canvas = {
    width: 0,
    height: 0,
    captureStream: vi.fn(() => stream),
  } as unknown as HTMLCanvasElement;
  const recorder: MediaRecorderLike = {
    state: 'inactive',
    ondataavailable: null,
    onerror: null,
    onstop: null,
    start: vi.fn(function start(this: MediaRecorderLike) {
      this.state = 'recording';
    }),
    stop: vi.fn(function stop(this: MediaRecorderLike) {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: chunk } as BlobEvent);
      this.onstop?.(new Event('stop'));
    }),
  };
  return {
    recorder,
    track,
    stream,
    deps: {
      createCanvas: () => canvas,
      createRecorder: () => recorder,
      waitForFrame: vi.fn(async () => undefined),
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
  it('renders frames in shot order, reports monotonic progress, and releases media tracks', async () => {
    const harness = recorderHarness();
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
    expect(harness.track.requestFrame).toHaveBeenCalledTimes(6);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.recorder.stop).toHaveBeenCalledTimes(1);
  });

  it('holds the recorder to absolute frame deadlines instead of adding render overhead', async () => {
    const harness = recorderHarness();
    let elapsed = 0;
    harness.deps.now = () => elapsed;
    harness.deps.waitForFrame = vi.fn(async (milliseconds) => {
      elapsed += milliseconds;
    });

    await recordPreviewWebm(
      shortPlan(),
      () => {
        elapsed += 10;
        return true;
      },
      { dependencies: harness.deps },
    );

    expect(elapsed).toBeCloseTo(250, 5);
    expect(harness.deps.waitForFrame).toHaveBeenCalledTimes(6);
    expect(vi.mocked(harness.deps.waitForFrame).mock.calls[0]![0]).toBeCloseTo(1000 / 24 - 10, 5);
  });

  it('fails before recording when captureStream(0) does not expose requestFrame', async () => {
    const harness = recorderHarness();
    harness.track.requestFrame = undefined;

    await expect(
      recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'unsupported' } satisfies Partial<PreviewExportError>);

    expect(harness.recorder.start).not.toHaveBeenCalled();
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly after a sustained frame deadline miss instead of exporting drifted media', async () => {
    const harness = recorderHarness();
    let elapsed = 0;
    harness.deps.now = () => elapsed;
    harness.deps.waitForFrame = vi.fn(async (milliseconds) => {
      elapsed += milliseconds;
    });

    await expect(
      recordPreviewWebm(
        shortPlan(),
        () => {
          elapsed += 60;
          return true;
        },
        { dependencies: harness.deps },
      ),
    ).rejects.toMatchObject({ code: 'timing-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('cancels without a file and releases the recorder and stream', async () => {
    const harness = recorderHarness();
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

    expect(harness.recorder.stop).toHaveBeenCalledTimes(1);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation during 100% recorder finalization and returns no blob', async () => {
    const harness = recorderHarness();
    const controller = new AbortController();
    harness.recorder.stop = vi.fn(function stop(this: MediaRecorderLike) {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['must-not-download']) } as BlobEvent);
      controller.abort();
      this.onstop?.(new Event('stop'));
    });

    await expect(
      recordPreviewWebm(shortPlan(), () => true, {
        signal: controller.signal,
        dependencies: harness.deps,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<PreviewExportError>);

    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('settles immediately on recorder error even when onstop never arrives', async () => {
    const harness = recorderHarness();
    harness.recorder.stop = vi.fn(function stop(this: MediaRecorderLike) {
      this.state = 'inactive';
      this.onerror?.(new Event('error'));
    });
    const recording = recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps });
    const settled = recording.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    const outcome = await Promise.race([
      settled,
      new Promise<'pending'>((resolve) => globalThis.setTimeout(() => resolve('pending'), 20)),
    ]);
    if (outcome === 'pending') {
      harness.recorder.onstop?.(new Event('stop'));
      await settled;
    }

    expect(outcome).toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('times out bounded finalization when onstop is missing and remains retryable', async () => {
    const harness = recorderHarness();
    harness.recorder.stop = vi.fn(function stop(this: MediaRecorderLike) {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['partial']) } as BlobEvent);
    });
    const recording = recordPreviewWebm(shortPlan(), () => true, {
      dependencies: harness.deps,
      finalizationTimeoutMs: 5,
    });
    const settled = recording.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    const outcome = await Promise.race([
      settled,
      new Promise<'pending'>((resolve) => globalThis.setTimeout(() => resolve('pending'), 20)),
    ]);
    if (outcome === 'pending') {
      harness.recorder.onstop?.(new Event('stop'));
      await settled;
    }

    expect(outcome).toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('reports capture failure and still releases encoder resources', async () => {
    const harness = recorderHarness();

    await expect(
      recordPreviewWebm(shortPlan(), () => false, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'capture-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.recorder.stop).toHaveBeenCalledTimes(1);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('releases the capture stream when recorder construction fails', async () => {
    const harness = recorderHarness();
    harness.deps.createRecorder = vi.fn(() => {
      throw new Error('recorder unavailable');
    });

    await expect(
      recordPreviewWebm(shortPlan(), () => true, { dependencies: harness.deps }),
    ).rejects.toMatchObject({ code: 'encoder-failed' } satisfies Partial<PreviewExportError>);

    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });
});
