/**
 * 统一时间引擎会话（TML-52）：每实例一个 TimelineController + TimelineRecorder。
 * - rAF 驱动：播放时 tick 推进；录制时先保证时间容量（时长随播放头增长，
 *   避免 loop 绕回/到点自停），再采样机位节点
 * - 失焦保护（AC2）：window blur / 页面隐藏 → 录制与播放一并暂停，不自动恢复
 * - 停止录制：各通道样本 RDP 抽稀 → 覆盖写入/新建轨道 → 恢复时长并回到 0s
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TimelineController,
  createTrack,
  getProjectDuration,
  simplifySamples,
} from '@lumora/core';
import type { SceneEditor, TrackKeyframeData, TrackTargetPath } from '@lumora/core';
import { TimelineRecorder } from '../components/editor/timeline-recorder';
import type { CaptureSource } from '../components/editor/timeline-recorder';

export type RecorderChannel = 'position' | 'rotation' | 'focalLength';

const CHANNEL_LABELS: Record<RecorderChannel, string> = {
  position: '位置',
  rotation: '旋转',
  focalLength: '焦距',
};

export interface TimelineSessionState {
  playing: boolean;
  /** 录制进行中（含失焦/手动暂停后的挂起态） */
  recording: boolean;
  /** 录制已暂停（失焦或手动暂停），等待恢复或停止 */
  recordingPaused: boolean;
  /** 目标机位已有录制轨道：等待覆盖确认 */
  overwritePending: boolean;
  duration: number;
  fps: number;
  zoom: number;
  snapEnabled: boolean;
  loopEnabled: boolean;
}

export interface TimelineSession {
  timeline: TimelineController;
  recorder: TimelineRecorder;
  state: TimelineSessionState;
  togglePlay(): void;
  pause(): void;
  seek(time: number, snapOverride?: boolean): void;
  zoomBy(factor: number): void;
  setZoom(zoom: number): void;
  setSnap(enabled: boolean): void;
  setLoop(enabled: boolean): void;
  setCaptureSource(source: CaptureSource | null): void;
  /** 开始录制指定机位；已有录制轨道时进入覆盖确认 */
  startRecording(cameraObjectId: string): void;
  confirmOverwrite(): void;
  cancelOverwrite(): void;
  /** 恢复暂停中的录制（同时恢复播放） */
  resumeRecording(): void;
  /** 结束录制：抽稀并提交各通道轨道 */
  stopRecording(): void;
}

export function useTimelineSession(editor: SceneEditor): TimelineSession {
  const timelineRef = useRef<TimelineController | null>(null);
  if (!timelineRef.current) timelineRef.current = new TimelineController();
  const timeline = timelineRef.current;
  const recorderRef = useRef<TimelineRecorder | null>(null);
  if (!recorderRef.current) recorderRef.current = new TimelineRecorder();
  const recorder = recorderRef.current;

  const [state, setState] = useState<TimelineSessionState>(() => ({
    playing: timeline.isPlaying(),
    recording: false,
    recordingPaused: false,
    overwritePending: false,
    duration: timeline.getDuration(),
    fps: timeline.getFps(),
    zoom: timeline.getZoom(),
    snapEnabled: timeline.isSnapEnabled(),
    loopEnabled: timeline.isLoopEnabled(),
  }));

  const pendingCameraRef = useRef<string | null>(null);
  const wasNullRef = useRef(true);

  /** 项目变更：新开/关闭项目重置播放头；时长随轨道/分镜变化收敛（录制中除外） */
  useEffect(() => {
    // 挂载时已有项目（会话重建/测试）：事件订阅晚于 openProject，直接补齐时长与 fps。
    // 镜像订阅在此 effect 之后才注册，settings:changed 事件无人接收，须同步写 state
    const open = editor.getProject();
    if (open) {
      const fps = open.settings?.fps;
      const duration = getProjectDuration(open);
      if (typeof fps === 'number' && fps > 0) timeline.setFps(fps);
      timeline.setDuration(duration);
      setState((s) => ({ ...s, duration, fps: typeof fps === 'number' && fps > 0 ? fps : s.fps }));
      wasNullRef.current = false;
    }
    const subs = [
      editor.events.on('project:changed', ({ project }) => {
        if (project === null) {
          if (recorder.active) {
            recorder.stop();
            setState((s) => ({ ...s, recording: false, recordingPaused: false }));
          }
          timeline.pause();
          timeline.setDuration(0);
          timeline.seek(0);
          wasNullRef.current = true;
          return;
        }
        const fps = project.settings?.fps;
        if (typeof fps === 'number' && fps > 0) timeline.setFps(fps);
        if (!recorder.active) timeline.setDuration(getProjectDuration(project));
        if (wasNullRef.current) {
          timeline.seek(0);
          wasNullRef.current = false;
        }
      }),
    ];
    return () => {
      for (const sub of subs) sub.dispose();
    };
  }, [editor, timeline, recorder]);

  /** 控制器事件镜像到 React 状态（time:changed 高频事件由面板自行订阅，不经过此处） */
  useEffect(() => {
    const subs = [
      timeline.events.on('state:changed', ({ playing }) => setState((s) => ({ ...s, playing }))),
      timeline.events.on('settings:changed', ({ fps, zoom, snap, loop, duration }) =>
        setState((s) => ({ ...s, fps, zoom, snapEnabled: snap, loopEnabled: loop, duration })),
      ),
    ];
    return () => {
      for (const sub of subs) sub.dispose();
    };
  }, [timeline]);

  /** 主循环：播放推进 + 录制采样（采样仅发生在时间前进且录制未暂停时） */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = timelineRef.current!;
      const r = recorderRef.current!;
      if (r.active && !r.isPaused) {
        // 时间容量保证：播放头始终领先时长至少 1 秒，loop 不会绕回、loop 关闭
        // 不会到点自停；起始 duration=0 时 play 被阻塞，先扩容再强制播放
        if (t.getTime() + 1 > t.getDuration()) t.setDuration(t.getTime() + 1);
        if (!t.isPlaying()) t.play();
      }
      if (t.isPlaying()) t.tick(dt);
      if (r.active && !r.isPaused && t.isPlaying()) r.sample(t.getTime());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** 失焦保护（AC2）：blur/页面隐藏 → 录制与播放暂停，不自动恢复 */
  useEffect(() => {
    const pauseOnHidden = () => {
      const r = recorderRef.current!;
      if (r.active && !r.isPaused) {
        r.pause();
        timelineRef.current!.pause();
        setState((s) => ({ ...s, recordingPaused: true, playing: false }));
      } else if (timelineRef.current!.isPlaying()) {
        timelineRef.current!.pause();
      }
    };
    window.addEventListener('blur', pauseOnHidden);
    document.addEventListener('visibilitychange', pauseOnHidden);
    return () => {
      window.removeEventListener('blur', pauseOnHidden);
      document.removeEventListener('visibilitychange', pauseOnHidden);
    };
  }, []);

  const togglePlay = useCallback(() => {
    if (recorder.active) {
      // 录制期间播放键 = 暂停/恢复录制（采样随播放头一起停）
      if (recorder.isPaused) {
        recorder.resume();
        timeline.play();
        setState((s) => ({ ...s, recordingPaused: false, playing: true }));
      } else {
        recorder.pause();
        timeline.pause();
        setState((s) => ({ ...s, recordingPaused: true, playing: false }));
      }
      return;
    }
    timeline.togglePlay();
  }, [recorder, timeline]);

  const pause = useCallback(() => {
    if (recorder.active) {
      recorder.pause();
      setState((s) => ({ ...s, recordingPaused: true, playing: false }));
    }
    timeline.pause();
  }, [recorder, timeline]);

  const seek = useCallback(
    (time: number, snapOverride?: boolean) => timeline.seek(time, snapOverride),
    [timeline],
  );

  const zoomBy = useCallback((factor: number) => timeline.zoomBy(factor), [timeline]);

  const setZoom = useCallback((zoom: number) => timeline.setZoom(zoom), [timeline]);

  const setSnap = useCallback((enabled: boolean) => timeline.setSnap(enabled), [timeline]);

  const setLoop = useCallback((enabled: boolean) => timeline.setLoop(enabled), [timeline]);

  const setCaptureSource = useCallback(
    (source: CaptureSource | null) => recorder.setCaptureSource(source),
    [recorder],
  );

  const beginRecording = useCallback(
    (cameraObjectId: string) => {
      recorder.start(cameraObjectId);
      timeline.play();
      setState((s) => ({ ...s, recording: true, recordingPaused: false }));
    },
    [recorder, timeline],
  );

  const startRecording = useCallback(
    (cameraObjectId: string) => {
      if (recorder.active) {
        if (recorder.isPaused) {
          recorder.resume();
          timeline.play();
          setState((s) => ({ ...s, recordingPaused: false, playing: true }));
        }
        return;
      }
      const project = editor.getProject();
      if (!project) return;
      const camera = project.objects.find((o) => o.id === cameraObjectId);
      if (!camera || camera.type !== 'camera') return;
      const hasRecorded = project.tracks.some(
        (t) => t.objectId === cameraObjectId && t.keyframes.length > 0,
      );
      if (hasRecorded) {
        pendingCameraRef.current = cameraObjectId;
        setState((s) => ({ ...s, overwritePending: true }));
        return;
      }
      beginRecording(cameraObjectId);
    },
    [editor, recorder, timeline, beginRecording],
  );

  const confirmOverwrite = useCallback(() => {
    const cameraId = pendingCameraRef.current;
    pendingCameraRef.current = null;
    setState((s) => ({ ...s, overwritePending: false }));
    if (cameraId) beginRecording(cameraId);
  }, [beginRecording]);

  const cancelOverwrite = useCallback(() => {
    pendingCameraRef.current = null;
    setState((s) => ({ ...s, overwritePending: false }));
  }, []);

  const resumeRecording = useCallback(() => {
    if (recorder.active && recorder.isPaused) {
      recorder.resume();
      timeline.play();
      setState((s) => ({ ...s, recordingPaused: false, playing: true }));
    }
  }, [recorder, timeline]);

  const stopRecording = useCallback(() => {
    if (!recorder.active) return;
    const cameraObjectId = recorder.recordingCameraId;
    const channels = recorder.stop();
    setState((s) => ({ ...s, recording: false, recordingPaused: false }));
    const project = editor.getProject();
    if (channels && project) {
      const camera = project.objects.find((o) => o.id === cameraObjectId) ?? null;
      const label = camera?.name ?? '机位';
      for (const channel of ['position', 'rotation', 'focalLength'] as const) {
        const samples = channels[channel];
        if (!samples || samples.length === 0) continue;
        const keyframes = simplifySamples(samples) as TrackKeyframeData[];
        if (keyframes.length === 0) continue;
        const existing = project.tracks.find(
          (t) => t.objectId === cameraObjectId && t.targetPath === channel,
        );
        const trackLabel = `录制${label}·${CHANNEL_LABELS[channel]}`;
        if (existing) {
          editor.setTrackKeyframes(existing.id, keyframes, trackLabel);
        } else {
          const track = createTrack(
            cameraObjectId!,
            channel as TrackTargetPath,
            trackLabel,
            keyframes,
          );
          editor.addTrack(track);
        }
      }
    }
    timeline.pause();
    const current = editor.getProject();
    if (current) timeline.setDuration(getProjectDuration(current));
    timeline.seek(0);
  }, [editor, recorder, timeline]);

  const session = useMemo<TimelineSession>(
    () => ({
      timeline,
      recorder,
      state,
      togglePlay,
      pause,
      seek,
      zoomBy,
      setZoom,
      setSnap,
      setLoop,
      setCaptureSource,
      startRecording,
      confirmOverwrite,
      cancelOverwrite,
      resumeRecording,
      stopRecording,
    }),
    [
      timeline,
      recorder,
      state,
      togglePlay,
      pause,
      seek,
      zoomBy,
      setZoom,
      setSnap,
      setLoop,
      setCaptureSource,
      startRecording,
      confirmOverwrite,
      cancelOverwrite,
      resumeRecording,
      stopRecording,
    ],
  );

  return session;
}
