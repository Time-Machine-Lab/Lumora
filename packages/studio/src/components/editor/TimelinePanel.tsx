/**
 * 时间线面板（TML-52）：运输控制（播放/暂停、录制/停止、帧显示、fps、吸附/
 * 循环开关、缩放）、标尺播放头（拖拽 seek）、轨道泳道（禁用开关、关键帧菱形
 * 点击定位）与分镜泳道（区块定位、‹› 重排、缩略图）。播放头时刻高频变化，
 * 面板本地订阅 time:changed，避免驱动整棵 Studio 树每帧重渲染。
 *
 * 共享时间坐标系（TML-52 审查第 5 项）：单一横向滚动容器（__body）承载
 * 标尺/轨道/分镜所有行，每行 = 固定宽度 sticky 标签列（__label，宽
 * TIMELINE_LABEL_WIDTH）+ 时间画布（__time-area）。标尺刻度、关键帧、分镜
 * 区块与播放头全部以 `time * zoom` 在同一坐标内定位，滚动同步、无 186px 错位。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM } from '@lumora/core';
import type { Project, SceneEditor } from '@lumora/core';
import { findObject } from '@lumora/core';
import type { TimelineSession } from '../../hooks/use-timeline-session';

/** 标签列宽度：标尺/轨道/分镜共用，测试与坐标换算引用此常量 */
export const TIMELINE_LABEL_WIDTH = 186;

export interface TimelinePanelProps {
  session: TimelineSession;
  editor: SceneEditor;
  project: Project;
  selection: string[];
  /** 视口截图通道（FrameCaptureBridge 注册）；null = 不可截图（测试/无 Canvas） */
  captureRef: React.RefObject<(() => string | null) | null>;
}

const CHANNEL_LABELS: Record<string, string> = {
  position: '位置',
  rotation: '旋转',
  scale: '缩放',
  focalLength: '焦距',
};

/** 面板本地播放头订阅：tick 频率的时间镜像，不经过全局状态 */
function usePlayheadTime(session: TimelineSession): number {
  const [time, setTime] = useState(() => session.timeline.getTime());
  useEffect(() => {
    setTime(session.timeline.getTime());
    const sub = session.timeline.events.on('time:changed', ({ time: next }) => setTime(next));
    return () => {
      sub.dispose();
    };
  }, [session.timeline]);
  return time;
}

function formatTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const secs = clamped - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

export function TimelinePanel({ session, editor, project, selection, captureRef }: TimelinePanelProps) {
  const { timeline, state } = session;
  const time = usePlayheadTime(session);
  const zoom = state.zoom;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const selectedCamera = useMemo(() => {
    if (selection.length !== 1) return null;
    const object = findObject(project, selection[0]!);
    return object && object.type === 'camera' ? object : null;
  }, [project, selection]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerCanvasRef = useRef<HTMLDivElement>(null);
  const [dragSeeking, setDragSeeking] = useState(false);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = rulerCanvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      session.seek((clientX - rect.left) / zoomRef.current);
    },
    [session],
  );

  const handleRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const el = rulerRef.current;
    if (!el) return;
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // 无指针捕获能力的环境（测试/旧浏览器）：拖拽跟随仍可用
    }
    setDragSeeking(true);
    seekFromEvent(event.clientX);
  };

  const handleRulerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragSeeking) seekFromEvent(event.clientX);
  };

  const handleRulerPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragSeeking) return;
    setDragSeeking(false);
    elRulerRelease(event);
  };

  const fitZoom = useCallback(() => {
    const viewport = bodyRef.current?.clientWidth ?? 800;
    const width = Math.max(50, viewport - TIMELINE_LABEL_WIDTH);
    const duration = Math.max(0.1, state.duration);
    session.setZoom(Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, width / duration)));
  }, [session, state.duration]);

  // 缩略图：串行截取缺失分镜（一次 seek → 双 RAF → capture → 下一分镜），
  // 链尾统一恢复播放头；播放/录制开始、外部 seek、项目切换或卸载 → 取消链，
  // 不再有陈旧 previous 互踩（TML-52 审查第 4 项）。
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const thumbChainRef = useRef<{ cancelled: boolean; seeking: boolean } | null>(null);

  useEffect(() => {
    const capture = captureRef.current;
    if (!capture || timeline.isPlaying() || state.recording) return;
    const chain: { cancelled: boolean; seeking: boolean; lastSeek: number | null } = {
      cancelled: false,
      seeking: false,
      lastSeek: null,
    };
    thumbChainRef.current = chain;
    const missing = project.shots.filter((shot) => thumbs[shot.id] === undefined);
    if (missing.length === 0) return;
    const previous = timeline.getTime();
    let moved = false;

    // 外部 seek（用户点击/回放推进）说明播放头已被他人接管 → 放弃本链
    const onTimeChanged = () => {
      if (!chain.seeking) chain.cancelled = true;
    };
    const onStateChanged = ({ playing }: { playing: boolean }) => {
      if (playing) chain.cancelled = true;
    };
    const subs = [
      timeline.events.on('time:changed', onTimeChanged),
      timeline.events.on('state:changed', onStateChanged),
    ];

    let cancelled = false;
    void (async () => {
      for (const shot of missing) {
        if (chain.cancelled || timeline.isPlaying() || state.recording) break;
        const current = timeline.getTime();
        if (Math.abs(current - shot.startTime) > 1e-6) {
          chain.seeking = true;
          timeline.seek(shot.startTime, false);
          chain.seeking = false;
          chain.lastSeek = shot.startTime;
          moved = true;
        }
        const url = await new Promise<string | null>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(capture())));
        });
        if (chain.cancelled) break;
        setThumbs((m) => ({ ...m, [shot.id]: url }));
      }
      // 链未被外部打断且确实移动过播放头 → 统一恢复一次（审查第 4 项）
      if (!chain.cancelled && moved) timeline.seek(previous, false);
      cancelled = true;
    })().catch(() => {
      cancelled = true;
    });

    return () => {
      chain.cancelled = true;
      // 链被后继重跑或录制开始打断时：若播放头仍停在本链最后一次 seek 的位置
      // （未被外部 seek 接管）或录制已接管播放头，恢复链前位置 —— 否则播放头
      // 滞留分镜起点：录制从错误时刻开始、停止后的 seek(0) 被覆盖（AC1 e2e
      // 确定性失败：停止后时间卡在 00:03.00）
      if (moved && chain.lastSeek !== null) {
        const atLastSeek = timeline.getTime() === chain.lastSeek;
        if ((atLastSeek && !timeline.isPlaying()) || session.recorder.active) {
          timeline.seek(previous, false);
        }
      }
      for (const sub of subs) sub.dispose();
      void cancelled;
    };
    // 播放态翻转后重新补缺（暂停时截图、播放中跳过）；thumbs 增量触发补齐剩余
    // eslint-disable-next-line react-hooks/exhaustive-deps -- missing 由 deps 覆盖推导
  }, [project.shots, thumbs, timeline, captureRef, state.playing, state.recording]);

  const moveShot = useCallback(
    (index: number, direction: -1 | 1) => {
      const ids = project.shots.map((s) => s.id);
      const swapIndex = index + direction;
      if (swapIndex < 0 || swapIndex >= ids.length) return;
      const swapped = [...ids];
      [swapped[index]!, swapped[swapIndex]!] = [swapped[swapIndex]!, swapped[index]!];
      editor.reorderShots(swapped);
    },
    [editor, project.shots],
  );

  const toggleTrackDisabled = useCallback(
    (trackId: string, disabled: boolean) => {
      editor.updateTrack(trackId, (t) => ({ ...t, disabled }), disabled ? '禁用轨道' : '启用轨道');
    },
    [editor],
  );

  const recordClick = () => {
    if (state.recording) {
      if (state.recordingPaused) session.resumeRecording();
      else session.stopRecording();
      return;
    }
    if (selectedCamera) session.startRecording(selectedCamera.id);
  };

  // 覆盖确认模态：真模态语义（role/aria/焦点圈/Escape）+ 拦截全局 Delete 穿透
  // （LumoraStudio 全局处理器在 capture 之后才运行，capture 中 preventDefault
  // 即止步 —— 该处理器先检查 event.defaultPrevented）
  const overwriteModalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.overwritePending) return;
    const dialog = overwriteModalRef.current;
    if (!dialog) return;
    dialog.focus();
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace' || event.key === ' ') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        session.cancelOverwrite();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => window.removeEventListener('keydown', onKeyDownCapture, true);
  }, [state.overwritePending, session]);

  const ticks = useMemo(() => {
    const minorStep = zoom >= 600 ? 0.25 : zoom >= 300 ? 0.5 : 1;
    const total = Math.max(0.1, state.duration);
    const list: Array<{ time: number; major: boolean }> = [];
    for (let t = 0; t <= total + 1e-6; t += minorStep) {
      list.push({ time: t, major: Math.abs(t - Math.round(t)) < 1e-6 });
    }
    return list;
  }, [zoom, state.duration]);

  const playheadX = TIMELINE_LABEL_WIDTH + time * zoom;

  return (
    <div className="lumora-timeline" data-testid="lumora-timeline">
      <div className="lumora-timeline__transport">
        <button
          type="button"
          className="lumora-timeline__play"
          data-testid="timeline-play"
          title={state.playing ? '暂停（空格）' : '播放（空格）'}
          disabled={state.duration <= 0 && !state.recording}
          onClick={() => session.togglePlay()}
        >
          {state.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className={`lumora-timeline__record${state.recording ? ' lumora-timeline__record--on' : ''}`}
          data-testid="timeline-record"
          title={
            !selectedCamera && !state.recording
              ? '选中一个机位后开始录制'
              : state.recordingPaused
                ? '继续录制'
                : state.recording
                  ? '停止录制'
                  : '录制机位运动'
          }
          disabled={!selectedCamera && !state.recording}
          onClick={recordClick}
        >
          {state.recordingPaused ? '▶' : state.recording ? '■' : '●'}
        </button>
        <span className="lumora-timeline__time" data-testid="timeline-time">
          {formatTime(time)}
        </span>
        <span className="lumora-timeline__frame" data-testid="timeline-frame">
          帧 {timeline.getFrame()}
        </span>
        <span className="lumora-timeline__fps">{state.fps} fps</span>
        <span className="lumora-timeline__spacer" />
        <label className="lumora-check lumora-timeline__check">
          <input
            type="checkbox"
            checked={state.snapEnabled}
            data-testid="timeline-snap"
            onChange={(e) => session.setSnap(e.target.checked)}
          />
          吸附
        </label>
        <label className="lumora-check lumora-timeline__check">
          <input
            type="checkbox"
            checked={state.loopEnabled}
            data-testid="timeline-loop"
            onChange={(e) => session.setLoop(e.target.checked)}
          />
          循环
        </label>
        <button type="button" className="lumora-timeline__zoom" title="缩小" onClick={() => session.zoomBy(1 / 1.5)}>
          −
        </button>
        <button type="button" className="lumora-timeline__zoom" title="适配时长" onClick={fitZoom}>
          适配
        </button>
        <button type="button" className="lumora-timeline__zoom" title="放大" onClick={() => session.zoomBy(1.5)}>
          ＋
        </button>
      </div>
      <div className="lumora-timeline__body" data-testid="timeline-body" ref={bodyRef}>
        <div
          className="lumora-timeline__canvas"
          style={{ width: TIMELINE_LABEL_WIDTH + Math.max(0, state.duration * zoom) }}
        >
          <div
            className="lumora-timeline__row lumora-timeline__row--ruler"
            data-testid="timeline-ruler"
            ref={rulerRef}
            onPointerDown={handleRulerPointerDown}
            onPointerMove={handleRulerPointerMove}
            onPointerUp={handleRulerPointerUp}
            onPointerCancel={handleRulerPointerUp}
          >
            <div className="lumora-timeline__label lumora-timeline__label--ruler" aria-hidden />
            <div className="lumora-timeline__time-area" ref={rulerCanvasRef}>
              <div className="lumora-timeline__ticks">
                {ticks.map((tick) => (
                  <div
                    key={tick.time}
                    className={`lumora-timeline__tick${tick.major ? ' lumora-timeline__tick--major' : ''}`}
                    style={{ left: tick.time * zoom }}
                  />
                ))}
              </div>
            </div>
          </div>
          {project.tracks.length === 0 ? (
            <div className="lumora-timeline__empty">尚无轨道 —— 选中一个机位后点击 ● 录制</div>
          ) : (
            project.tracks.map((track) => (
              <div
                key={track.id}
                className={`lumora-timeline__row lumora-timeline__lane${track.disabled ? ' lumora-timeline__lane--disabled' : ''}`}
                data-testid={`track-lane-${track.id}`}
                onClick={() => editor.setSelection([track.objectId])}
                title={track.disabled ? '已禁用' : undefined}
              >
                <div className="lumora-timeline__label">
                  <span className="lumora-timeline__lane-name">{track.name}</span>
                  <span className="lumora-timeline__lane-channel">{CHANNEL_LABELS[track.targetPath] ?? track.targetPath}</span>
                  <label className="lumora-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!!track.disabled}
                      data-testid={`track-disabled-${track.id}`}
                      onChange={(e) => toggleTrackDisabled(track.id, e.target.checked)}
                    />
                    禁用
                  </label>
                </div>
                <div className="lumora-timeline__time-area">
                  {track.keyframes.map((kf) => (
                    <button
                      key={kf.time}
                      type="button"
                      className="lumora-timeline__keyframe"
                      style={{ left: kf.time * zoom }}
                      data-testid={`keyframe-${track.id}-${kf.time}`}
                      title={`${formatTime(kf.time)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        session.seek(kf.time);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
          {project.shots.length === 0 ? (
            <div className="lumora-timeline__empty">尚无分镜</div>
          ) : (
            <div className="lumora-timeline__row lumora-timeline__row--shots" data-testid="timeline-shots">
              <div className="lumora-timeline__label lumora-timeline__label--shots">分镜</div>
              <div className="lumora-timeline__time-area">
                {project.shots.map((shot, index) => {
                  const camera = shot.cameraObjectId ? findObject(project, shot.cameraObjectId) : null;
                  const width = Math.max(3, (shot.endTime - shot.startTime) * zoom);
                  return (
                    <div
                      key={shot.id}
                      className="lumora-timeline__shot"
                      style={{ left: shot.startTime * zoom, width }}
                      data-testid={`shot-block-${shot.id}`}
                      onClick={() => session.seek(shot.startTime)}
                      title={camera ? `机位：${camera.name}` : '未绑定机位'}
                    >
                      <button
                        type="button"
                        className="lumora-timeline__shot-move"
                        disabled={index === 0}
                        data-testid={`shot-move-left-${shot.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveShot(index, -1);
                        }}
                      >
                        ‹
                      </button>
                      <span className="lumora-timeline__shot-name">{shot.name}</span>
                      <button
                        type="button"
                        className="lumora-timeline__shot-move"
                        disabled={index >= project.shots.length - 1}
                        data-testid={`shot-move-right-${shot.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveShot(index, 1);
                        }}
                      >
                        ›
                      </button>
                      {thumbs[shot.id] ? (
                        <img className="lumora-timeline__shot-thumb" src={thumbs[shot.id]!} alt="" draggable={false} />
                      ) : (
                        <span className="lumora-timeline__shot-camera">{camera ? camera.name : '未绑定'}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="lumora-timeline__playhead" style={{ left: playheadX }} data-testid="timeline-playhead" />
        </div>
      </div>
      {state.overwritePending && (
        <div
          className="lumora-timeline__overlay"
          data-testid="overwrite-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="overwrite-confirm-title"
        >
          <div className="lumora-timeline__modal" ref={overwriteModalRef} tabIndex={-1}>
            <p id="overwrite-confirm-title">该机位已有录制轨道，覆盖现有关键帧？</p>
            <div className="lumora-timeline__modal-actions">
              <button type="button" className="lumora-button lumora-button--danger" onClick={session.confirmOverwrite}>
                覆盖录制
              </button>
              <button type="button" className="lumora-button" onClick={session.cancelOverwrite}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** pointer capture 释放（与 onPointerUp/onPointerCancel 共用） */
function elRulerRelease(event: React.PointerEvent<HTMLDivElement>) {
  const el = event.currentTarget;
  try {
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  } catch {
    // 无指针捕获能力的环境（测试/旧浏览器）：拖拽跟随仍可用
  }
}
