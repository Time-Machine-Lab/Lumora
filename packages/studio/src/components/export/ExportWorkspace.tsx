import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Project, ShotClipData } from '@lumora/core';
import type { StudioRuntime } from '../../runtime/studio-runtime';
import type { TimelineSession } from '../../hooks/use-timeline-session';
import { useEventRefresh } from '../../hooks/use-event-refresh';
import type { ProjectFrameCapture } from '../editor/frame-capture';
import {
  PreviewExportError,
  buildStoryboardManifest,
  createPreviewExportPlan,
  detectWebmSupport,
  isActiveSceneCamera,
  recordPreviewWebm,
} from '../../export/preview-export';
import type {
  PreviewFrameRate,
  PreviewRecordingDependencies,
  PreviewResolution,
  WebmSupport,
  WebmSupportProbe,
} from '../../export/preview-export';

export type ThumbnailCapture = (cameraObjectId?: string | null) => string | null;
export type ExportFrameCapture = ProjectFrameCapture;

export interface ExportWorkspaceProps {
  runtime: StudioRuntime;
  project: Project;
  projectSessionToken?: number;
  session: TimelineSession;
  captureRef: RefObject<ThumbnailCapture | null>;
  exportFrameRef: RefObject<ExportFrameCapture | null>;
  captureReady?: boolean;
  onClose: () => void;
  support?: WebmSupport;
  supportProbe?: WebmSupportProbe;
  recordingDependencies?: PreviewRecordingDependencies;
}

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'running'; message: string }
  | { kind: 'success'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string };

type ExportOperationKind = 'manifest' | 'png' | 'webm' | 'plugin';

interface ExportOperationToken {
  uri: string;
  sessionGeneration: number;
  operationGeneration: number;
  kind: ExportOperationKind;
  initiator: HTMLButtonElement;
  exporterId?: string;
  pluginId?: string;
  exporterRegistrationGeneration?: number;
}

const RESOLUTION_SIZE: Record<PreviewResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

const CHECKING_WEBM_SUPPORT: WebmSupport = {
  supported: false,
  checking: true,
  reason: '正在检查 VP8 编码配置…',
};

interface DetectedWebmSupport {
  checkKey: string;
  support: WebmSupport;
}

function safeFilename(value: string): string {
  const invalid = '\\/:*?"<>|';
  const cleaned = [...value.trim()]
    .map((character) => invalid.includes(character) || character.charCodeAt(0) < 32 ? '_' : character)
    .join('');
  return cleaned || 'lumora-export';
}

function clickDownload(href: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  clickDownload(url, filename);
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ExportWorkspace({
  runtime,
  project,
  projectSessionToken,
  session,
  exportFrameRef,
  captureReady = true,
  onClose,
  support: supportOverride,
  supportProbe,
  recordingDependencies,
}: ExportWorkspaceProps) {
  useEventRefresh(runtime.events, ['contribution:changed', 'plugin:state-changed']);
  const [range, setRange] = useState('all');
  const [resolution, setResolution] = useState<PreviewResolution>('720p');
  const [fps, setFps] = useState<PreviewFrameRate>(24);
  const boundSessionToken = projectSessionToken ?? runtime.editor.getSessionToken();
  const supportCheckKey = JSON.stringify([boundSessionToken, project.uri, resolution, fps]);
  const [detectedSupport, setDetectedSupport] = useState<DetectedWebmSupport>(() => ({
    checkKey: supportCheckKey,
    support: CHECKING_WEBM_SUPPORT,
  }));
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' });
  const [progress, setProgress] = useState(0);
  const [activeOperation, setActiveOperation] = useState<ExportOperationToken | null>(null);
  const operationGenerationRef = useRef(0);
  const exporterRegistrationGenerationsRef = useRef(new Map<string, number>());
  const activeOperationRef = useRef<ExportOperationToken | null>(null);
  const mountedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const operationControlsRef = useRef<HTMLDivElement>(null);
  const pendingFocusOriginRef = useRef<HTMLButtonElement | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const support = supportOverride ?? (
    detectedSupport.checkKey === supportCheckKey
      ? detectedSupport.support
      : CHECKING_WEBM_SUPPORT
  );

  useEffect(() => {
    if (supportOverride) return;
    let current = true;
    setDetectedSupport({ checkKey: supportCheckKey, support: CHECKING_WEBM_SUPPORT });
    void Promise.resolve(detectWebmSupport({ resolution, fps }, supportProbe)).then((result) => {
      const currentProject = runtime.editor.getProject();
      if (
        !current ||
        !runtime.editor.isCurrentSession(boundSessionToken) ||
        (currentProject !== null && currentProject.uri !== project.uri)
      ) return;
      setDetectedSupport({ checkKey: supportCheckKey, support: result });
    });
    return () => {
      current = false;
    };
  }, [
    boundSessionToken,
    fps,
    project.uri,
    resolution,
    runtime.editor,
    supportCheckKey,
    supportOverride,
    supportProbe,
  ]);

  const isWorkspaceSessionCurrent = (token?: ExportOperationToken) => {
    const current = runtime.editor.getProject();
    const sessionGeneration = token?.sessionGeneration ?? boundSessionToken;
    const uri = token?.uri ?? project.uri;
    return runtime.editor.isCurrentSession(sessionGeneration) &&
      (current === null || current.uri === uri);
  };

  const staleTaskError = () => new PreviewExportError('cancelled', '项目会话已变更，导出已取消');

  const isOperationOwner = (token: ExportOperationToken) =>
    activeOperationRef.current?.operationGeneration === token.operationGeneration;

  const isOperationCurrent = (token: ExportOperationToken) => {
    if (!mountedRef.current || !isOperationOwner(token) || !isWorkspaceSessionCurrent(token)) return false;
    if (token.kind !== 'plugin') return true;
    if (
      (exporterRegistrationGenerationsRef.current.get(token.pluginId!) ?? 0) !==
      token.exporterRegistrationGeneration
    ) return false;
    return runtime.host.contributions.getExporters().some(
      (exporter) => exporter.id === token.exporterId && exporter.pluginId === token.pluginId,
    );
  };

  const assertOperationCurrent = (token: ExportOperationToken) => {
    if (!isOperationCurrent(token)) throw staleTaskError();
  };

  const beginOperation = (
    kind: ExportOperationKind,
    initiator: HTMLButtonElement,
    exporter?: { id: string; pluginId: string },
  ): ExportOperationToken | null => {
    if (!mountedRef.current || activeOperationRef.current || !isWorkspaceSessionCurrent()) return null;
    if (focusTimerRef.current !== null) {
      globalThis.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    pendingFocusOriginRef.current = null;
    const token: ExportOperationToken = {
      uri: project.uri,
      sessionGeneration: boundSessionToken,
      operationGeneration: operationGenerationRef.current + 1,
      kind,
      initiator,
      ...(exporter ? {
        exporterId: exporter.id,
        pluginId: exporter.pluginId,
        exporterRegistrationGeneration:
          exporterRegistrationGenerationsRef.current.get(exporter.pluginId) ?? 0,
      } : {}),
    };
    operationGenerationRef.current = token.operationGeneration;
    activeOperationRef.current = token;
    setActiveOperation(token);
    return token;
  };

  const completeOperation = (token: ExportOperationToken, nextStatus?: ExportStatus) => {
    if (!isOperationOwner(token)) return;
    if (nextStatus?.kind === 'cancelled' || nextStatus?.kind === 'error') {
      pendingFocusOriginRef.current = token.initiator;
    }
    activeOperationRef.current = null;
    if (!mountedRef.current) return;
    setActiveOperation(null);
    if (nextStatus) setStatus(nextStatus);
  };

  const invalidateActiveOperation = useCallback((nextStatus?: ExportStatus) => {
    const operation = activeOperationRef.current;
    if (operation && (nextStatus?.kind === 'cancelled' || nextStatus?.kind === 'error')) {
      pendingFocusOriginRef.current = operation.initiator;
    }
    operationGenerationRef.current += 1;
    activeOperationRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    if (!mountedRef.current) return;
    setActiveOperation(null);
    if (nextStatus) setStatus(nextStatus);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    closeRef.current?.focus();
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      activeOperationRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      if (focusTimerRef.current !== null) globalThis.clearTimeout(focusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (status.kind !== 'cancelled' && status.kind !== 'error') {
      if (focusTimerRef.current !== null) {
        globalThis.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      pendingFocusOriginRef.current = null;
      return;
    }
    if (focusTimerRef.current !== null) globalThis.clearTimeout(focusTimerRef.current);
    const focusGeneration = operationGenerationRef.current;
    focusTimerRef.current = globalThis.setTimeout(() => {
      focusTimerRef.current = null;
      if (!mountedRef.current || operationGenerationRef.current !== focusGeneration) return;
      const origin = pendingFocusOriginRef.current;
      pendingFocusOriginRef.current = null;
      if (origin?.isConnected && !origin.disabled) {
        origin.focus();
        return;
      }
      const fallback = operationControlsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      (fallback ?? closeRef.current)?.focus();
    }, 0);
  }, [status]);

  useEffect(() => {
    const subscription = runtime.events.on('contribution:changed', ({ pluginId }) => {
      const generations = exporterRegistrationGenerationsRef.current;
      generations.set(pluginId, (generations.get(pluginId) ?? 0) + 1);
      const operation = activeOperationRef.current;
      if (operation?.kind === 'plugin' && operation.pluginId === pluginId) {
        invalidateActiveOperation({ kind: 'cancelled', message: '插件导出器已变更，导出已取消' });
      }
    });
    return () => {
      void subscription.dispose();
    };
  }, [runtime.events, invalidateActiveOperation]);

  const selectedShotIds = useMemo(
    () => (range === 'all' ? project.shots.map((shot) => shot.id) : [range]),
    [project.shots, range],
  );
  const selectedShots = useMemo(() => {
    const selected = new Set(selectedShotIds);
    return project.shots.filter((shot) => selected.has(shot.id));
  }, [project.shots, selectedShotIds]);
  const selectedDuration = selectedShots.reduce(
    (total, shot) => total + Math.max(0, shot.endTime - shot.startTime),
    0,
  );
  const exporters = runtime.host.contributions.getExporters();
  const busy = activeOperation !== null;
  const running = activeOperation?.kind === 'webm';
  const aspect = project.settings.aspect[0] / project.settings.aspect[1];

  const exportManifest = (initiator: HTMLButtonElement) => {
    const token = beginOperation('manifest', initiator);
    if (!token) return;
    let nextStatus: ExportStatus;
    try {
      assertOperationCurrent(token);
      const manifest = buildStoryboardManifest(project, selectedShotIds);
      assertOperationCurrent(token);
      downloadBlob(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
        `${safeFilename(project.name)}-storyboard.json`,
      );
      assertOperationCurrent(token);
      nextStatus = { kind: 'success', message: '分镜清单已导出' };
    } catch (error) {
      nextStatus = error instanceof PreviewExportError && error.code === 'cancelled'
        ? { kind: 'cancelled', message: error.message }
        : { kind: 'error', message: `清单导出失败：${resultMessage(error)}` };
    } finally {
      completeOperation(token, nextStatus!);
    }
  };

  const exportPng = async (shot: ShotClipData, initiator: HTMLButtonElement) => {
    if (!isWorkspaceSessionCurrent()) {
      setStatus({ kind: 'cancelled', message: '项目会话已变更，导出已取消' });
      return;
    }
    if (session.state.recording) {
      setStatus({ kind: 'error', message: '请先结束时间线录制再导出画面' });
      return;
    }
    if (!isActiveSceneCamera(project, shot.cameraObjectId)) {
      setStatus({ kind: 'error', message: `分镜「${shot.name}」未绑定活动场景中的有效机位` });
      return;
    }
    const token = beginOperation('png', initiator);
    if (!token) return;
    const previousTime = session.timeline.getTime();
    let nextStatus: ExportStatus;
    try {
      assertOperationCurrent(token);
      session.pause();
      await Promise.resolve();
      assertOperationCurrent(token);
      session.seek((shot.startTime + shot.endTime) / 2, false);
      await Promise.resolve();
      assertOperationCurrent(token);
      const canvas = document.createElement('canvas');
      const size = RESOLUTION_SIZE[resolution];
      const rendered = exportFrameRef.current?.(shot.cameraObjectId!, canvas, { ...size, aspect }) ?? false;
      await Promise.resolve();
      assertOperationCurrent(token);
      if (!rendered) {
        throw new Error('无法渲染指定分辨率画面');
      }
      const dataUrl = canvas.toDataURL('image/png');
      assertOperationCurrent(token);
      clickDownload(dataUrl, `${safeFilename(project.name)}-${safeFilename(shot.name)}.png`);
      await Promise.resolve();
      assertOperationCurrent(token);
      nextStatus = { kind: 'success', message: `已导出「${shot.name}」PNG` };
    } catch (error) {
      if (error instanceof PreviewExportError && error.code === 'cancelled') {
        nextStatus = { kind: 'cancelled', message: error.message };
      } else {
        nextStatus = { kind: 'error', message: `PNG 导出失败：${resultMessage(error)}` };
      }
    } finally {
      if (isOperationCurrent(token)) {
        session.seek(previousTime, false);
        await Promise.resolve();
        if (!isOperationCurrent(token)) {
          nextStatus = { kind: 'cancelled', message: '项目会话已变更，导出已取消' };
        }
      }
      completeOperation(token, nextStatus!);
    }
  };

  const exportWebm = async (initiator: HTMLButtonElement) => {
    if (!support.supported || activeOperationRef.current) return;
    if (!isWorkspaceSessionCurrent()) {
      setStatus({ kind: 'cancelled', message: '项目会话已变更，导出已取消' });
      return;
    }
    if (session.state.recording) {
      setStatus({ kind: 'error', message: '请先结束时间线录制再导出画面' });
      return;
    }
    const result = createPreviewExportPlan(project, {
      shotIds: selectedShotIds,
      resolution,
      fps,
      mimeType: support.mimeType,
    });
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.message });
      return;
    }
    if (!exportFrameRef.current) {
      setStatus({ kind: 'error', message: '3D 画面尚未就绪，无法开始导出' });
      return;
    }

    const token = beginOperation('webm', initiator);
    if (!token) return;
    const previousTime = session.timeline.getTime();
    const controller = new AbortController();
    abortRef.current = controller;
    let nextStatus: ExportStatus;
    try {
      assertOperationCurrent(token);
      session.pause();
      assertOperationCurrent(token);
      setProgress(0);
      setStatus({ kind: 'running', message: '正在导出 0%' });
      const blob = await recordPreviewWebm(
        result.plan,
        async ({ canvas, shot, sourceTime, width, height }) => {
          assertOperationCurrent(token);
          session.seek(sourceTime, false);
          await Promise.resolve();
          assertOperationCurrent(token);
          const rendered = exportFrameRef.current?.(shot.cameraObjectId!, canvas, { width, height, aspect }) ?? false;
          await Promise.resolve();
          assertOperationCurrent(token);
          return rendered;
        },
        {
          signal: controller.signal,
          isOperationCurrent: () => isOperationCurrent(token),
          dependencies: recordingDependencies,
          onProgress: (event) => {
            if (!isOperationCurrent(token)) return;
            const percentage = Math.round(event.ratio * 100);
            setProgress(percentage);
            setStatus({ kind: 'running', message: `正在导出 ${percentage}% · ${event.shotName}` });
          },
        },
      );
      assertOperationCurrent(token);
      downloadBlob(blob, `${safeFilename(project.name)}-${resolution}-${fps}fps.webm`);
      await Promise.resolve();
      assertOperationCurrent(token);
      setProgress(100);
      nextStatus = { kind: 'success', message: '导出完成' };
    } catch (error) {
      if (error instanceof PreviewExportError && error.code === 'cancelled') {
        nextStatus = { kind: 'cancelled', message: '导出已取消' };
      } else {
        nextStatus = { kind: 'error', message: `WebM 导出失败：${resultMessage(error)}` };
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (isOperationCurrent(token)) {
        session.pause();
        await Promise.resolve();
        if (isOperationCurrent(token)) {
          session.seek(previousTime, false);
          await Promise.resolve();
          if (!isOperationCurrent(token)) {
            nextStatus = { kind: 'cancelled', message: '项目会话已变更，导出已取消' };
          }
        } else {
          nextStatus = { kind: 'cancelled', message: '项目会话已变更，导出已取消' };
        }
      }
      completeOperation(token, nextStatus!);
    }
  };

  const runPluginExporter = async (
    exporter: (typeof exporters)[number],
    initiator: HTMLButtonElement,
  ) => {
    if (activeOperationRef.current) return;
    if (!isWorkspaceSessionCurrent()) {
      setStatus({ kind: 'cancelled', message: '项目会话已变更，导出已取消' });
      return;
    }
    const token = beginOperation('plugin', initiator, exporter);
    if (!token) return;
    let nextStatus: ExportStatus;
    setStatus({ kind: 'running', message: `正在运行 ${exporter.name}` });
    try {
      const result = await exporter.export(project);
      assertOperationCurrent(token);
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.fileName !== 'string' ||
        typeof result.mime !== 'string' ||
        typeof result.data !== 'string'
      ) {
        throw new Error('导出器返回了无效结果');
      }
      assertOperationCurrent(token);
      downloadBlob(new Blob([result.data], { type: result.mime }), safeFilename(result.fileName));
      assertOperationCurrent(token);
      nextStatus = { kind: 'success', message: `${exporter.name}导出完成` };
    } catch (error) {
      if (error instanceof PreviewExportError && error.code === 'cancelled') {
        nextStatus = { kind: 'cancelled', message: error.message };
      } else {
        nextStatus = { kind: 'error', message: `${exporter.name}失败：${resultMessage(error)}` };
      }
    } finally {
      completeOperation(token, nextStatus!);
    }
  };

  return (
    <section className="lumora-export" data-testid="export-workspace">
      <header className="lumora-export__header">
        <div>
          <h2>导出</h2>
          <p data-testid="export-summary">
            {selectedShots.length} 个分镜 · {selectedDuration.toFixed(2)} 秒
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="lumora-button"
          disabled={running}
          onClick={() => {
            invalidateActiveOperation();
            onClose();
          }}
        >
          关闭导出
        </button>
      </header>

      <div className="lumora-export__layout">
        <div className="lumora-export__settings">
          <div
            ref={operationControlsRef}
            className="lumora-export__operation-controls"
            data-testid="export-operation-controls"
            aria-busy={busy}
          >
          <h3>预览视频</h3>
          <label>
            <span>导出范围</span>
            <select
              aria-label="导出范围"
              value={range}
              disabled={busy}
              onChange={(event) => setRange(event.target.value)}
            >
              <option value="all">全部分镜</option>
              {project.shots.map((shot) => (
                <option key={shot.id} value={shot.id}>{shot.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>分辨率</span>
            <select
              aria-label="分辨率"
              value={resolution}
              disabled={busy}
              onChange={(event) => setResolution(event.target.value as PreviewResolution)}
            >
              <option value="720p">1280 × 720</option>
              <option value="480p">854 × 480</option>
            </select>
          </label>
          <label>
            <span>帧率</span>
            <select
              aria-label="帧率"
              value={String(fps)}
              disabled={busy}
              onChange={(event) => setFps(Number(event.target.value) as PreviewFrameRate)}
            >
              <option value="24">24 fps</option>
              <option value="30">30 fps</option>
            </select>
          </label>

          {!support.supported && (
            <p className="lumora-export__notice" role={support.checking ? 'status' : 'alert'}>
              {support.reason}
            </p>
          )}
          {support.supported && (
            <p className="lumora-export__codec">WebM · {support.mimeType.includes('vp9') ? 'VP9' : support.mimeType.includes('vp8') ? 'VP8' : '浏览器默认'}</p>
          )}

          {running && (
            <progress className="lumora-export__progress" max={100} value={progress} aria-label="导出进度">
              {progress}%
            </progress>
          )}
          <div className="lumora-export__actions">
            <button
              ref={primaryRef}
              type="button"
              className="lumora-button lumora-button--active"
              disabled={
                !support.supported ||
                !captureReady ||
                busy ||
                session.state.recording ||
                selectedShots.length === 0
              }
              onClick={(event) => void exportWebm(event.currentTarget)}
            >
              导出 WebM
            </button>
            {running && (
              <button
                type="button"
                className="lumora-button lumora-button--danger"
                onClick={() => abortRef.current?.abort()}
              >
                取消导出
              </button>
            )}
            <button
              type="button"
              className="lumora-button"
              disabled={busy || selectedShots.length === 0}
              onClick={(event) => exportManifest(event.currentTarget)}
            >
              导出清单
            </button>
          </div>

          {exporters.length > 0 && (
            <div className="lumora-export__plugins">
              <h3>插件导出器</h3>
              {exporters.map((exporter) => (
                <button
                  key={exporter.id}
                  type="button"
                  className="lumora-button"
                  disabled={busy}
                  onClick={(event) => void runPluginExporter(exporter, event.currentTarget)}
                >
                  {activeOperation?.kind === 'plugin' && activeOperation.exporterId === exporter.id
                    ? `正在运行 ${exporter.name}`
                    : `运行 ${exporter.name}`}
                </button>
              ))}
            </div>
          )}
          </div>

          {status.kind !== 'idle' && (
            <p
              className={`lumora-export__status lumora-export__status--${status.kind}`}
              role={status.kind === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </p>
          )}
        </div>

        <div className="lumora-export__shots">
          <div className="lumora-export__shots-heading">
            <h3>分镜图</h3>
            <span>{project.shots.length}</span>
          </div>
          <ol>
            {project.shots.map((shot, index) => (
              <li key={shot.id} className={selectedShotIds.includes(shot.id) ? 'is-selected' : undefined}>
                <div>
                  <span className="lumora-export__shot-index">{String(index + 1).padStart(2, '0')}</span>
                  <strong>{shot.name}</strong>
                  <span>{(shot.endTime - shot.startTime).toFixed(2)} 秒</span>
                </div>
                <button
                  type="button"
                  className="lumora-button"
                  disabled={busy || session.state.recording || !captureReady || !shot.cameraObjectId}
                  aria-label={`导出 ${shot.name} PNG`}
                  onClick={(event) => void exportPng(shot, event.currentTarget)}
                >
                  PNG
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
