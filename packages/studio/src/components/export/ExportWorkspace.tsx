import { useEffect, useMemo, useRef, useState } from 'react';
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
  recordPreviewWebm,
} from '../../export/preview-export';
import type {
  PreviewFrameRate,
  PreviewRecordingDependencies,
  PreviewResolution,
  WebmSupport,
} from '../../export/preview-export';

export type ThumbnailCapture = (cameraObjectId?: string | null) => string | null;
export type ExportFrameCapture = ProjectFrameCapture;

export interface ExportWorkspaceProps {
  runtime: StudioRuntime;
  project: Project;
  session: TimelineSession;
  captureRef: RefObject<ThumbnailCapture | null>;
  exportFrameRef: RefObject<ExportFrameCapture | null>;
  captureReady?: boolean;
  onClose: () => void;
  support?: WebmSupport;
  recordingDependencies?: PreviewRecordingDependencies;
}

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'running'; message: string }
  | { kind: 'success'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string };

const RESOLUTION_SIZE: Record<PreviewResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

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
  session,
  exportFrameRef,
  captureReady = true,
  onClose,
  support: supportOverride,
  recordingDependencies,
}: ExportWorkspaceProps) {
  useEventRefresh(runtime.events, ['contribution:changed', 'plugin:state-changed']);
  const support = useMemo(() => supportOverride ?? detectWebmSupport(), [supportOverride]);
  const [range, setRange] = useState('all');
  const [resolution, setResolution] = useState<PreviewResolution>('720p');
  const [fps, setFps] = useState<PreviewFrameRate>(24);
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' });
  const [progress, setProgress] = useState(0);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

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
  const running = status.kind === 'running';
  const exporters = runtime.host.contributions.getExporters();
  const aspect = project.settings.aspect[0] / project.settings.aspect[1];

  const exportManifest = () => {
    try {
      const manifest = buildStoryboardManifest(project, selectedShotIds);
      downloadBlob(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
        `${safeFilename(project.name)}-storyboard.json`,
      );
      setStatus({ kind: 'success', message: '分镜清单已导出' });
    } catch (error) {
      setStatus({ kind: 'error', message: `清单导出失败：${resultMessage(error)}` });
    }
  };

  const exportPng = (shot: ShotClipData) => {
    if (session.state.recording) {
      setStatus({ kind: 'error', message: '请先结束时间线录制再导出画面' });
      return;
    }
    if (!shot.cameraObjectId) {
      setStatus({ kind: 'error', message: `分镜「${shot.name}」未绑定机位` });
      return;
    }
    const previousTime = session.timeline.getTime();
    session.pause();
    session.seek((shot.startTime + shot.endTime) / 2, false);
    try {
      const canvas = document.createElement('canvas');
      const size = RESOLUTION_SIZE[resolution];
      if (!exportFrameRef.current?.(shot.cameraObjectId, canvas, { ...size, aspect })) {
        throw new Error('无法渲染指定分辨率画面');
      }
      const dataUrl = canvas.toDataURL('image/png');
      clickDownload(dataUrl, `${safeFilename(project.name)}-${safeFilename(shot.name)}.png`);
      setStatus({ kind: 'success', message: `已导出「${shot.name}」PNG` });
    } catch (error) {
      setStatus({ kind: 'error', message: `PNG 导出失败：${resultMessage(error)}` });
    } finally {
      session.seek(previousTime, false);
    }
  };

  const exportWebm = async () => {
    if (!support.supported || running) return;
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

    const previousTime = session.timeline.getTime();
    const controller = new AbortController();
    abortRef.current = controller;
    session.pause();
    setProgress(0);
    setStatus({ kind: 'running', message: '正在导出 0%' });
    try {
      const blob = await recordPreviewWebm(
        result.plan,
        ({ canvas, shot, sourceTime, width, height }) => {
          session.seek(sourceTime, false);
          return exportFrameRef.current?.(shot.cameraObjectId!, canvas, { width, height, aspect }) ?? false;
        },
        {
          signal: controller.signal,
          dependencies: recordingDependencies,
          onProgress: (event) => {
            const percentage = Math.round(event.ratio * 100);
            setProgress(percentage);
            setStatus({ kind: 'running', message: `正在导出 ${percentage}% · ${event.shotName}` });
          },
        },
      );
      downloadBlob(blob, `${safeFilename(project.name)}-${resolution}-${fps}fps.webm`);
      setProgress(100);
      setStatus({ kind: 'success', message: '导出完成' });
    } catch (error) {
      if (error instanceof PreviewExportError && error.code === 'cancelled') {
        setStatus({ kind: 'cancelled', message: '导出已取消' });
      } else {
        setStatus({ kind: 'error', message: `WebM 导出失败：${resultMessage(error)}` });
      }
    } finally {
      abortRef.current = null;
      session.pause();
      session.seek(previousTime, false);
    }
  };

  const runPluginExporter = async (exporter: (typeof exporters)[number]) => {
    if (running || pluginBusy) return;
    setPluginBusy(exporter.id);
    setStatus({ kind: 'idle' });
    try {
      const result = await exporter.export(project);
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.fileName !== 'string' ||
        typeof result.mime !== 'string' ||
        typeof result.data !== 'string'
      ) {
        throw new Error('导出器返回了无效结果');
      }
      downloadBlob(new Blob([result.data], { type: result.mime }), safeFilename(result.fileName));
      setStatus({ kind: 'success', message: `${exporter.name}导出完成` });
    } catch (error) {
      setStatus({ kind: 'error', message: `${exporter.name}失败：${resultMessage(error)}` });
    } finally {
      setPluginBusy(null);
    }
  };

  return (
    <section className="lumora-export" data-testid="export-workspace" aria-busy={running}>
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
          onClick={onClose}
        >
          关闭导出
        </button>
      </header>

      <div className="lumora-export__layout">
        <div className="lumora-export__settings">
          <h3>预览视频</h3>
          <label>
            <span>导出范围</span>
            <select
              aria-label="导出范围"
              value={range}
              disabled={running}
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
              disabled={running}
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
              disabled={running}
              onChange={(event) => setFps(Number(event.target.value) as PreviewFrameRate)}
            >
              <option value="24">24 fps</option>
              <option value="30">30 fps</option>
            </select>
          </label>

          {!support.supported && <p className="lumora-export__notice" role="alert">{support.reason}</p>}
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
              type="button"
              className="lumora-button lumora-button--active"
              disabled={
                !support.supported ||
                !captureReady ||
                running ||
                session.state.recording ||
                selectedShots.length === 0
              }
              onClick={() => void exportWebm()}
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
              disabled={running || selectedShots.length === 0}
              onClick={exportManifest}
            >
              导出清单
            </button>
          </div>

          {status.kind !== 'idle' && (
            <p
              className={`lumora-export__status lumora-export__status--${status.kind}`}
              role={status.kind === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </p>
          )}

          {exporters.length > 0 && (
            <div className="lumora-export__plugins">
              <h3>插件导出器</h3>
              {exporters.map((exporter) => (
                <button
                  key={exporter.id}
                  type="button"
                  className="lumora-button"
                  disabled={running || pluginBusy !== null}
                  onClick={() => void runPluginExporter(exporter)}
                >
                  {pluginBusy === exporter.id ? `正在运行 ${exporter.name}` : `运行 ${exporter.name}`}
                </button>
              ))}
            </div>
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
                  disabled={running || session.state.recording || !captureReady || !shot.cameraObjectId}
                  aria-label={`导出 ${shot.name} PNG`}
                  onClick={() => exportPng(shot)}
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
