import { getReachableIds } from '@lumora/core';
import type { Project, ShotClipData } from '@lumora/core';

export type PreviewResolution = '720p' | '480p';
export type PreviewFrameRate = 24 | 30;
export type PreviewExportErrorCode =
  | 'no-shots'
  | 'invalid-shot'
  | 'unsupported'
  | 'capture-failed'
  | 'timing-failed'
  | 'cancelled'
  | 'encoder-failed';

export interface PreviewExportOptions {
  shotIds: readonly string[];
  resolution: PreviewResolution;
  fps: PreviewFrameRate;
  mimeType: string;
}

export interface PreviewExportShot extends ShotClipData {
  frameCount: number;
}

export interface PreviewExportPlan {
  shots: PreviewExportShot[];
  width: number;
  height: number;
  fps: PreviewFrameRate;
  mimeType: string;
  duration: number;
  totalFrames: number;
}

export type PreviewPlanResult =
  | { ok: true; plan: PreviewExportPlan }
  | { ok: false; code: 'no-shots' | 'invalid-shot' | 'unsupported'; message: string };

export interface WebmSupportProbe {
  hasMediaRecorder: boolean;
  hasCanvasCaptureStream: boolean;
  isTypeSupported(mimeType: string): boolean;
}

export type WebmSupport =
  | { supported: true; mimeType: string }
  | { supported: false; reason: string };

export interface StoryboardManifest {
  format: 'lumora.storyboard';
  version: 1;
  exportedAt: string;
  project: {
    uri: string;
    name: string;
    schemaVersion: number;
    revision: number;
    aspect: [number, number];
  };
  shots: Array<{
    id: string;
    order: number;
    name: string;
    cameraObjectId: string | null;
    startTime: number;
    endTime: number;
    duration: number;
    shotSize?: ShotClipData['shotSize'];
    movement?: ShotClipData['movement'];
    prompt?: string;
    aiSource?: ShotClipData['aiSource'];
  }>;
}

export interface PreviewFrameContext {
  canvas: HTMLCanvasElement;
  shot: PreviewExportShot;
  sourceTime: number;
  completedFrames: number;
  totalFrames: number;
  width: number;
  height: number;
}

export interface PreviewExportProgress {
  completedFrames: number;
  totalFrames: number;
  ratio: number;
  shotId: string;
  shotName: string;
}

export interface MediaRecorderLike {
  state: RecordingState;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: ((event: Event) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface PreviewRecordingDependencies {
  createCanvas(): HTMLCanvasElement;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorderLike;
  waitForFrame(milliseconds: number, signal?: AbortSignal): Promise<void>;
  now?(): number;
}

export interface PreviewRecordingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PreviewExportProgress) => void;
  dependencies?: PreviewRecordingDependencies;
  finalizationTimeoutMs?: number;
}

export const DEFAULT_RECORDER_FINALIZATION_TIMEOUT_MS = 5_000;

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

const RESOLUTIONS: Record<PreviewResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

export class PreviewExportError extends Error {
  constructor(
    public readonly code: PreviewExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewExportError';
  }
}

function defaultSupportProbe(): WebmSupportProbe {
  const recorder = globalThis.MediaRecorder;
  const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
  return {
    hasMediaRecorder: typeof recorder === 'function',
    hasCanvasCaptureStream: typeof canvasPrototype?.captureStream === 'function',
    isTypeSupported: (mimeType) =>
      typeof recorder?.isTypeSupported === 'function' && recorder.isTypeSupported(mimeType),
  };
}

export function detectWebmSupport(probe: WebmSupportProbe = defaultSupportProbe()): WebmSupport {
  if (!probe.hasMediaRecorder) {
    return { supported: false, reason: '当前浏览器不支持 MediaRecorder，无法导出 WebM' };
  }
  if (!probe.hasCanvasCaptureStream) {
    return { supported: false, reason: '当前浏览器不支持画布视频捕获，无法导出 WebM' };
  }
  for (const mimeType of MIME_CANDIDATES) {
    if (probe.isTypeSupported(mimeType)) return { supported: true, mimeType };
  }
  return { supported: false, reason: '当前浏览器不支持 VP8/VP9 WebM 编码' };
}

function selectedShots(project: Project, shotIds: readonly string[]): ShotClipData[] {
  const selected = new Set(shotIds);
  return project.shots.filter((shot) => selected.has(shot.id));
}

export function isActiveSceneCamera(project: Project, cameraObjectId: string | null): boolean {
  if (!cameraObjectId) return false;
  const camera = project.objects.find((object) => object.id === cameraObjectId);
  return camera?.type === 'camera' && getReachableIds(project, project.activeSceneId).has(camera.id);
}

export function createPreviewExportPlan(
  project: Project,
  options: PreviewExportOptions,
): PreviewPlanResult {
  const shots = selectedShots(project, options.shotIds);
  if (shots.length === 0) {
    return { ok: false, code: 'no-shots', message: '请选择至少一个分镜后再导出' };
  }
  if (!options.mimeType.toLowerCase().startsWith('video/webm')) {
    return { ok: false, code: 'unsupported', message: 'MVP 仅支持 WebM 预览编码' };
  }
  const resolution = RESOLUTIONS[options.resolution];
  if (!resolution || (options.fps !== 24 && options.fps !== 30)) {
    return { ok: false, code: 'unsupported', message: '不支持所选分辨率或帧率' };
  }

  const planned: PreviewExportShot[] = [];
  let cumulativeDuration = 0;
  let allocatedFrames = 0;
  for (const shot of shots) {
    if (!isActiveSceneCamera(project, shot.cameraObjectId)) {
      return {
        ok: false,
        code: 'invalid-shot',
        message: `分镜「${shot.name}」未绑定有效机位`,
      };
    }
    if (
      !Number.isFinite(shot.startTime) ||
      !Number.isFinite(shot.endTime) ||
      shot.startTime < 0 ||
      shot.endTime <= shot.startTime
    ) {
      return {
        ok: false,
        code: 'invalid-shot',
        message: `分镜「${shot.name}」的时间范围无效`,
      };
    }
    cumulativeDuration += shot.endTime - shot.startTime;
    const cumulativeBoundary = Math.round(cumulativeDuration * options.fps);
    const frameCount = cumulativeBoundary - allocatedFrames;
    if (frameCount < 1) {
      return {
        ok: false,
        code: 'invalid-shot',
        message: `分镜「${shot.name}」时长不足以在所选帧率下分配画面`,
      };
    }
    planned.push({ ...shot, frameCount });
    allocatedFrames = cumulativeBoundary;
  }

  const duration = cumulativeDuration;
  const totalFrames = allocatedFrames;
  return {
    ok: true,
    plan: {
      shots: planned,
      width: resolution.width,
      height: resolution.height,
      fps: options.fps,
      mimeType: options.mimeType,
      duration,
      totalFrames,
    },
  };
}

export function buildStoryboardManifest(
  project: Project,
  shotIds: readonly string[],
  exportedAt = new Date().toISOString(),
): StoryboardManifest {
  const shots = selectedShots(project, shotIds);
  return {
    format: 'lumora.storyboard',
    version: 1,
    exportedAt,
    project: {
      uri: project.uri,
      name: project.name,
      schemaVersion: project.schemaVersion,
      revision: project.revision,
      aspect: [...project.settings.aspect],
    },
    shots: shots.map((shot, order) => ({
        id: shot.id,
        order,
        name: shot.name,
        cameraObjectId: shot.cameraObjectId,
        startTime: shot.startTime,
        endTime: shot.endTime,
        duration: shot.endTime - shot.startTime,
        ...(shot.shotSize ? { shotSize: shot.shotSize } : {}),
        ...(shot.movement ? { movement: shot.movement } : {}),
        ...(shot.prompt ? { prompt: shot.prompt } : {}),
        ...(shot.aiSource ? { aiSource: { ...shot.aiSource } } : {}),
      })),
  };
}

function abortError(): PreviewExportError {
  return new PreviewExportError('cancelled', '预览导出已取消');
}

function waitForFrame(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultRecordingDependencies(): PreviewRecordingDependencies {
  return {
    createCanvas: () => document.createElement('canvas'),
    createRecorder: (stream, options) => new MediaRecorder(stream, options) as unknown as MediaRecorderLike,
    waitForFrame,
  };
}

export async function recordPreviewWebm(
  plan: PreviewExportPlan,
  renderFrame: (context: PreviewFrameContext) => boolean | Promise<boolean>,
  options: PreviewRecordingOptions = {},
): Promise<Blob> {
  const dependencies = options.dependencies ?? defaultRecordingDependencies();
  const now = dependencies.now ?? (() => globalThis.performance.now());
  const signal = options.signal;
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? DEFAULT_RECORDER_FINALIZATION_TIMEOUT_MS;
  if (signal?.aborted) throw abortError();

  const canvas = dependencies.createCanvas();
  canvas.width = plan.width;
  canvas.height = plan.height;
  if (typeof canvas.captureStream !== 'function') {
    throw new PreviewExportError('unsupported', '当前浏览器不支持画布视频捕获');
  }

  let stream!: MediaStream;
  let recorder: MediaRecorderLike;
  try {
    stream = canvas.captureStream(0);
    recorder = dependencies.createRecorder(stream, {
      mimeType: plan.mimeType,
      videoBitsPerSecond: plan.height >= 720 ? 6_000_000 : 3_000_000,
    });
  } catch {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    canvas.width = 1;
    canvas.height = 1;
    throw new PreviewExportError('encoder-failed', '无法初始化 WebM 编码器');
  }

  const chunks: Blob[] = [];
  let recorderFailure: PreviewExportError | null = null;
  type RecorderOutcome = { type: 'stopped' } | { type: 'error'; error: PreviewExportError };
  const recorderOutcome = new Promise<RecorderOutcome>((resolve) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      recorderFailure = new PreviewExportError('encoder-failed', 'WebM 编码器运行失败');
      resolve({ type: 'error', error: recorderFailure });
    };
    recorder.onstop = () => resolve({ type: 'stopped' });
  });

  try {
    const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    if (!track || typeof track.requestFrame !== 'function') {
      throw new PreviewExportError(
        'unsupported',
        '当前浏览器不支持逐帧画布捕获，无法可靠导出 WebM',
      );
    }
    recorder.start();
    const recordingStartedAt = now();
    const frameDuration = 1000 / plan.fps;
    let completedFrames = 0;
    for (const shot of plan.shots) {
      for (let shotFrame = 0; shotFrame < shot.frameCount; shotFrame += 1) {
        if (signal?.aborted) throw abortError();
        if (recorderFailure) throw recorderFailure;
        const sourceTime = shot.startTime + shotFrame / plan.fps;
        const rendered = await renderFrame({
          canvas,
          shot,
          sourceTime,
          completedFrames,
          totalFrames: plan.totalFrames,
          width: plan.width,
          height: plan.height,
        });
        if (signal?.aborted) throw abortError();
        if (!rendered) {
          throw new PreviewExportError('capture-failed', `无法渲染分镜「${shot.name}」`);
        }
        track.requestFrame();
        completedFrames += 1;
        options.onProgress?.({
          completedFrames,
          totalFrames: plan.totalFrames,
          ratio: completedFrames / plan.totalFrames,
          shotId: shot.id,
          shotName: shot.name,
        });
        const targetElapsed = completedFrames * frameDuration;
        const remaining = Math.max(0, targetElapsed - (now() - recordingStartedAt));
        await dependencies.waitForFrame(remaining, signal);
        if (now() - recordingStartedAt - targetElapsed > frameDuration * 2) {
          throw new PreviewExportError(
            'timing-failed',
            '浏览器未能维持所选帧率，已停止导出以避免生成时长漂移的 WebM',
          );
        }
      }
    }
    if (recorderFailure) throw recorderFailure;
    recorder.stop();
    const finalization = await new Promise<RecorderOutcome>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(abortError()));
      const timer = globalThis.setTimeout(
        () => finish(() => reject(new PreviewExportError(
          'encoder-failed',
          'WebM 编码器收尾超时，请重试',
        ))),
        Math.max(1, finalizationTimeoutMs),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      void recorderOutcome.then((outcome) => finish(() => resolve(outcome)));
    });
    if (finalization.type === 'error') throw finalization.error;
    if (signal?.aborted) throw abortError();
    if (chunks.length === 0) {
      throw new PreviewExportError('encoder-failed', 'WebM 编码器未产生有效数据');
    }
    return new Blob(chunks, { type: plan.mimeType });
  } catch (error) {
    if (signal?.aborted && !(error instanceof PreviewExportError)) throw abortError();
    if (error instanceof PreviewExportError) throw error;
    throw new PreviewExportError(
      'encoder-failed',
      error instanceof Error ? error.message : 'WebM 导出失败',
    );
  } finally {
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // 终止失败不阻断底层媒体轨道释放。
      }
    }
    for (const track of stream.getTracks()) track.stop();
    canvas.width = 1;
    canvas.height = 1;
  }
}
