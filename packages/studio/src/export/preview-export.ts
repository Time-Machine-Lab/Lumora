import { getReachableIds } from '@lumora/core';
import type { Project, ShotClipData } from '@lumora/core';
import { ArrayBufferTarget, Muxer } from 'webm-muxer';

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
  hasVideoEncoder: boolean;
  hasVideoFrame: boolean;
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

export interface PreviewEncodedFrame {
  timestamp: number;
  duration: number;
  keyFrame: boolean;
}

export interface PreviewEncoderSession {
  encodeFrame(canvas: HTMLCanvasElement, frame: PreviewEncodedFrame): void;
  flush(): Promise<Blob>;
  close(): void;
}

export interface PreviewRecordingDependencies {
  createCanvas(): HTMLCanvasElement;
  createEncoder(plan: PreviewExportPlan): PreviewEncoderSession;
}

export interface PreviewRecordingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PreviewExportProgress) => void;
  isOperationCurrent?: () => boolean;
  dependencies?: PreviewRecordingDependencies;
  finalizationTimeoutMs?: number;
}

export const DEFAULT_RECORDER_FINALIZATION_TIMEOUT_MS = 5_000;
const OPERATION_OWNERSHIP_POLL_MS = 16;

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
  return {
    hasVideoEncoder: typeof globalThis.VideoEncoder === 'function',
    hasVideoFrame: typeof globalThis.VideoFrame === 'function',
  };
}

export function detectWebmSupport(probe: WebmSupportProbe = defaultSupportProbe()): WebmSupport {
  if (!probe.hasVideoEncoder) {
    return { supported: false, reason: '当前浏览器不支持 WebCodecs VideoEncoder，无法可靠导出 WebM' };
  }
  if (!probe.hasVideoFrame) {
    return { supported: false, reason: '当前浏览器不支持 WebCodecs VideoFrame，无法可靠导出 WebM' };
  }
  return { supported: true, mimeType: MIME_CANDIDATES[1] };
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

function defaultRecordingDependencies(): PreviewRecordingDependencies {
  return {
    createCanvas: () => document.createElement('canvas'),
    createEncoder: (plan) => {
      const target = new ArrayBufferTarget();
      const vp9 = plan.mimeType.toLowerCase().includes('vp9');
      const muxer = new Muxer({
        target,
        video: {
          codec: vp9 ? 'V_VP9' : 'V_VP8',
          width: plan.width,
          height: plan.height,
          frameRate: plan.fps,
        },
        firstTimestampBehavior: 'strict',
      });
      let encoderFailure: Error | null = null;
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
        error: (error) => {
          encoderFailure = error;
        },
      });
      encoder.configure({
        codec: vp9 ? 'vp09.00.10.08' : 'vp8',
        width: plan.width,
        height: plan.height,
        bitrate: plan.height >= 720 ? 6_000_000 : 3_000_000,
        framerate: plan.fps,
        latencyMode: 'quality',
      });
      return {
        encodeFrame: (canvas, frame) => {
          if (encoderFailure) throw encoderFailure;
          const videoFrame = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: frame.duration,
          });
          try {
            encoder.encode(videoFrame, { keyFrame: frame.keyFrame });
          } finally {
            videoFrame.close();
          }
          if (encoderFailure) throw encoderFailure;
        },
        flush: async () => {
          await encoder.flush();
          if (encoderFailure) throw encoderFailure;
          muxer.finalize();
          return new Blob([target.buffer], { type: plan.mimeType });
        },
        close: () => {
          try {
            encoder.close();
          } catch {
            // An encoder error may already have closed the codec.
          }
        },
      };
    },
  };
}

export async function recordPreviewWebm(
  plan: PreviewExportPlan,
  renderFrame: (context: PreviewFrameContext) => boolean | Promise<boolean>,
  options: PreviewRecordingOptions = {},
): Promise<Blob> {
  const dependencies = options.dependencies ?? defaultRecordingDependencies();
  const signal = options.signal;
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? DEFAULT_RECORDER_FINALIZATION_TIMEOUT_MS;
  const ensureOperationCurrent = () => {
    if (signal?.aborted || options.isOperationCurrent?.() === false) throw abortError();
  };
  ensureOperationCurrent();

  const canvas = dependencies.createCanvas();
  canvas.width = plan.width;
  canvas.height = plan.height;
  let encoder: PreviewEncoderSession;
  try {
    encoder = dependencies.createEncoder(plan);
  } catch (error) {
    canvas.width = 1;
    canvas.height = 1;
    throw new PreviewExportError(
      'encoder-failed',
      error instanceof Error ? error.message : '无法初始化 WebM 编码器',
    );
  }

  try {
    const frameTimestamp = (index: number) => Math.round(index * 1_000_000 / plan.fps);
    let completedFrames = 0;
    for (const shot of plan.shots) {
      for (let shotFrame = 0; shotFrame < shot.frameCount; shotFrame += 1) {
        ensureOperationCurrent();
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
        ensureOperationCurrent();
        if (!rendered) {
          throw new PreviewExportError('capture-failed', `无法渲染分镜「${shot.name}」`);
        }
        const timestamp = frameTimestamp(completedFrames);
        encoder.encodeFrame(canvas, {
          timestamp,
          duration: frameTimestamp(completedFrames + 1) - timestamp,
          keyFrame: completedFrames === 0 || completedFrames % plan.fps === 0,
        });
        ensureOperationCurrent();
        completedFrames += 1;
        options.onProgress?.({
          completedFrames,
          totalFrames: plan.totalFrames,
          ratio: completedFrames / plan.totalFrames,
          shotId: shot.id,
          shotName: shot.name,
        });
        ensureOperationCurrent();
      }
    }
    // The muxer derives duration from the last encoded PTS, so encode the
    // unchanged canvas once at N/fps and wait for WebCodecs flush completion.
    const terminalTimestamp = frameTimestamp(plan.totalFrames);
    encoder.encodeFrame(canvas, {
      timestamp: terminalTimestamp,
      duration: frameTimestamp(plan.totalFrames + 1) - terminalTimestamp,
      keyFrame: false,
    });
    ensureOperationCurrent();
    const blob = await new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let ownershipTimer: number | null = null;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (ownershipTimer !== null) globalThis.clearInterval(ownershipTimer);
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
      if (options.isOperationCurrent) {
        ownershipTimer = globalThis.setInterval(() => {
          if (options.isOperationCurrent?.() === false) finish(() => reject(abortError()));
        }, OPERATION_OWNERSHIP_POLL_MS);
      }
      void encoder.flush().then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
    ensureOperationCurrent();
    if (blob.size === 0) {
      throw new PreviewExportError('encoder-failed', 'WebM 编码器未产生有效数据');
    }
    return blob;
  } catch (error) {
    if (signal?.aborted && !(error instanceof PreviewExportError)) throw abortError();
    if (error instanceof PreviewExportError) throw error;
    throw new PreviewExportError(
      'encoder-failed',
      error instanceof Error ? error.message : 'WebM 导出失败',
    );
  } finally {
    encoder.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}
