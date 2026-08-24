/**
 * 时间线面板（TML-52）：运输控制（播放/暂停、录制/停止、帧显示、fps、吸附/
 * 循环开关、缩放）、标尺播放头（拖拽 seek）、轨道泳道（禁用开关、关键帧菱形
 * 点击定位）与分镜泳道（区块定位、‹› 重排、缩略图）。播放头时刻高频变化，
 * 面板本地订阅 time:changed，避免驱动整棵 Studio 树每帧重渲染。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM } from '@lumora/core';
import type { Project, SceneEditor } from '@lumora/core';
import { findObject } from '@lumora/core';
import type { TimelineSession } from '../../hooks/use-timeline-session';

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

  const rulerRef = useRef<HTMLDivElement>(null);
  const [dragSeeking, setDragSeeking] = useState(false);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = rulerRef.current;
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
    const width = rulerRef.current?.clientWidth ?? 800;
    const duration = Math.max(0.1, state.duration);
    session.setZoom(Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, width / duration)));
  }, [session, state.duration]);

  // 缩略图：暂停时跳到分镜起点截图后还原（播放中不打断）
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const captureThumb = useCallback(
    (shotId: string, startTime: number) => {
      if (timeline.isPlaying()) return;
      const capture = captureRef.current;
      if (!capture) return;
      const previous = timeline.getTime();
      timeline.seek(startTime, false);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const url = capture();
          timeline.seek(previous, false);
          setThumbs((m) => ({ ...m, [shotId]: url }));
        }),
      );
    },
    [timeline, captureRef],
  );

  useEffect(() => {
    for (const shot of project.shots) {
      if (thumbs[shot.id] === undefined) captureThumb(shot.id, shot.startTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅补新出现分镜的缩略图
  }, [project.shots, captureThumb]);

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

  const ticks = useMemo(() => {
    const minorStep = zoom >= 600 ? 0.25 : zoom >= 300 ? 0.5 : 1;
    const total = Math.max(0.1, state.duration);
    const list: Array<{ time: number; major: boolean }> = [];
    for (let t = 0; t <= total + 1e-6; t += minorStep) {
      list.push({ time: t, major: Math.abs(t - Math.round(t)) < 1e-6 });
    }
    return list;
  }, [zoom, state.duration]);

  const playheadX = time * zoom;

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
      <div
        className="lumora-timeline__ruler"
        data-testid="timeline-ruler"
        ref={rulerRef}
        onPointerDown={handleRulerPointerDown}
        onPointerMove={handleRulerPointerMove}
        onPointerUp={handleRulerPointerUp}
        onPointerCancel={handleRulerPointerUp}
      >
        <div className="lumora-timeline__ticks" style={{ width: Math.max(100, state.duration * zoom) }}>
          {ticks.map((tick) => (
            <div
              key={tick.time}
              className={`lumora-timeline__tick${tick.major ? ' lumora-timeline__tick--major' : ''}`}
              style={{ left: tick.time * zoom }}
            />
          ))}
        </div>
        <div className="lumora-timeline__playhead" style={{ left: playheadX }} data-testid="timeline-playhead" />
      </div>
      <div className="lumora-timeline__lanes">
        {project.tracks.length === 0 ? (
          <div className="lumora-timeline__empty">尚无轨道 —— 选中一个机位后点击 ● 录制</div>
        ) : (
          project.tracks.map((track) => (
            <div
              key={track.id}
              className={`lumora-timeline__lane${track.disabled ? ' lumora-timeline__lane--disabled' : ''}`}
              data-testid={`track-lane-${track.id}`}
              onClick={() => editor.setSelection([track.objectId])}
              title={track.disabled ? '已禁用' : undefined}
            >
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
              <div className="lumora-timeline__lane-keyframes" style={{ width: Math.max(100, state.duration * zoom) }}>
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
      </div>
      <div className="lumora-timeline__shots" data-testid="timeline-shots">
        {project.shots.length === 0 ? (
          <div className="lumora-timeline__empty">尚无分镜</div>
        ) : (
          <div className="lumora-timeline__shots-inner" style={{ width: Math.max(100, state.duration * zoom) }}>
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
        )}
      </div>
      {state.overwritePending && (
        <div className="lumora-timeline__overlay" data-testid="overwrite-confirm">
          <div className="lumora-timeline__modal">
            <p>该机位已有录制轨道，覆盖现有关键帧？</p>
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
