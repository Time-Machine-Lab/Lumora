/**
 * 统一时间引擎会话（TML-52）：每实例一个 TimelineController + TimelineRecorder。
 * - rAF 驱动：播放时 tick 推进；录制时先保证时间容量（1 秒分块扩容，约 1Hz
 *   节流 —— 而非每帧 setDuration，避免时长/会话高频变化），再采样机位节点
 * - 失焦保护（AC2）：window blur / 页面隐藏 → 录制与播放一并暂停，不自动恢复
 * - 停止录制：各通道样本 RDP 抽稀 → 一次原子批量提交（commitRecordingTracks）
 * - 会话对象稳定：实例持有 useRef 对象，仅 state 字段随渲染原地更新 ——
 *   下游 effect（相机驾驶/回放订阅）不因状态变化重建，录制中按键输入不被
 *   会话重建打断（TML-52 审查第 1 项）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TimelineController,
  createTrack,
  getProjectDuration,
  simplifySamples,
} from '@lumora/core';
import type { SceneEditor, TrackData, TrackKeyframeData, TrackTargetPath } from '@lumora/core';
import { TimelineRecorder } from '../components/editor/timeline-recorder';
import type { CaptureSource } from '../components/editor/timeline-recorder';
import { showToast } from '../components/editor/toasts';

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
  /** 结束录制：抽稀并原子提交各通道轨道 */
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

  const pendingRecordingRef = useRef<{ sessionToken: number; cameraId: string } | null>(null);
  /** 本 hook 观察中的项目会话令牌：project:changed 里据此判定「会话切换」
   *  （打开/重开/重置）。与 recordedSessionTokenRef 分离 —— 后者仅录制时非空，
   *  不能作为会话变化依据（从未录制时不得把每次编辑误判为切换） */
  const currentSessionTokenRef = useRef<number | null>(null);
  /** 录制绑定身份：项目会话令牌 + uri + 机位 id。会话令牌随项目打开/重开/重置
   *  递增 —— 同 URI 重开被判定为不同会话，录制与覆盖确认一并作废，不得把
   *  旧会话状态带到新项目（TML-52 复审阻断 3：仅绑定 uri 会把同 URI 重开
   *  误判为同一会话） */
  const recordedSessionTokenRef = useRef<number | null>(null);
  const recordedProjectUriRef = useRef<string | null>(null);

  /** 项目变更：新开/关闭项目重置播放头；时长随轨道/分镜变化收敛（录制中除外）。
   *  录制中的项目身份变化（直接切换项目/重开）或绑定机位被删除 → 取消录制并
   *  丢弃本轮样本（避免旧采样写入新项目或静默悬空） */
  useEffect(() => {
    // 挂载时已有项目（会话重建/测试）：事件订阅晚于 openProject，直接补齐时长与 fps。
    // 镜像订阅在此 effect 之后才注册，settings:changed 事件无人接收，须同步写 state
    currentSessionTokenRef.current = editor.getSessionToken();
    const open = editor.getProject();
    if (open) {
      const fps = open.settings?.fps;
      const duration = getProjectDuration(open);
      if (typeof fps === 'number' && fps > 0) timeline.setFps(fps);
      timeline.setDuration(duration);
      setState((s) => ({ ...s, duration, fps: typeof fps === 'number' && fps > 0 ? fps : s.fps }));
    }
    const cancelRecording = () => {
      if (!recorder.active) return;
      recorder.stop();
      recordedSessionTokenRef.current = null;
      recordedProjectUriRef.current = null;
      setState((s) => ({ ...s, recording: false, recordingPaused: false }));
    };
    const subs = [
      editor.events.on('project:changed', ({ project }) => {
        const sessionToken = editor.getSessionToken();
        // 会话令牌变化（打开/重开/重置项目）→ 覆盖确认作废：新项目的同 ID
        // 相机不得在旧确认下误启动录制（复审阻断 3）
        if (
          pendingRecordingRef.current &&
          pendingRecordingRef.current.sessionToken !== sessionToken
        ) {
          pendingRecordingRef.current = null;
          setState((s) => ({ ...s, overwritePending: false }));
        }
        if (project === null) {
          cancelRecording();
          timeline.pause();
          timeline.setDuration(0);
          timeline.seek(0);
          return;
        }
        const fps = project.settings?.fps;
        if (typeof fps === 'number' && fps > 0) timeline.setFps(fps);
        // 会话切换（A→B 直接打开 / 同 URI 重开 / 关闭后重开）：无条件停止录制、
        // 暂停并回零 —— 不得只在「上一项目为 null」时回零，否则播放头带着旧
        // 项目的时刻直接进入新项目（复审阻断 3）
        const sessionChanged =
          currentSessionTokenRef.current !== null && sessionToken !== currentSessionTokenRef.current;
        currentSessionTokenRef.current = sessionToken;
        if (sessionChanged) {
          if (recorder.active) cancelRecording();
          timeline.pause();
          timeline.seek(0);
          timeline.setDuration(getProjectDuration(project));
          return;
        }
        if (!recorder.active) timeline.setDuration(getProjectDuration(project));
        else if (!project.objects.some((o) => o.id === recorder.recordingCameraId)) {
          // 录制中绑定机位被删除/撤销：采样源已失效，取消录制并把时长收敛回
          // 项目时长（录制扩容出的时长不得残留，复审阻断 3）
          cancelRecording();
          timeline.pause();
          timeline.setDuration(getProjectDuration(project));
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

  /** 主循环：播放推进 + 录制采样（采样仅发生在时间前进且录制未暂停时）。
   *  时间容量保证：录制中播放头领先时长时按整秒分块扩容（ceil(time+1)，
   *  ~1Hz 一次，非每帧），loop 不会绕回、loop 关闭不会到点自停；起始
   *  duration=0 时先扩容再强制播放（审查第 1 项：分块扩容/节流） */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = timelineRef.current!;
      const r = recorderRef.current!;
      if (r.active && !r.isPaused) {
        if (t.getTime() + 1 > t.getDuration()) t.setDuration(Math.ceil(t.getTime() + 1));
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
      const project = editor.getProject();
      const projectUri = project?.uri ?? null;
      const sessionToken = editor.getSessionToken();
      // 绑定身份后再采样：项目切换/重开/相机删除时按身份取消（审查第 7 项；
      // 复审阻断 3：会话令牌参与绑定，同 URI 重开不视为同一会话）
      recorder.start(cameraObjectId, projectUri);
      recordedSessionTokenRef.current = sessionToken;
      recordedProjectUriRef.current = projectUri;
      timeline.play();
      setState((s) => ({ ...s, recording: true, recordingPaused: false }));
    },
    [editor, recorder, timeline],
  );

  /** 覆盖确认时重验：等待期间目标可能已被删除或会话已切换（审查第 7 项；
   *  复审阻断 3：pending 携带会话令牌，切换后已被 project:changed 作废）。
   *  isCurrentSession 兜底更早注册的 listener 在 project:changed 同步阶段调用
   *  confirmOverwrite 的竞态 —— 彼时令牌已递增，旧 pending 不得在新会话启动录制 */
  const confirmOverwrite = useCallback(() => {
    const pending = pendingRecordingRef.current;
    pendingRecordingRef.current = null;
    setState((s) => ({ ...s, overwritePending: false }));
    if (!pending) return;
    if (!editor.isCurrentSession(pending.sessionToken)) return;
    const project = editor.getProject();
    const camera = project?.objects.find((o) => o.id === pending.cameraId);
    if (!camera || camera.type !== 'camera') {
      showToast('目标机位已不存在，无法录制', 'error');
      return;
    }
    beginRecording(pending.cameraId);
  }, [beginRecording, editor]);

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
        pendingRecordingRef.current = {
          sessionToken: editor.getSessionToken(),
          cameraId: cameraObjectId,
        };
        setState((s) => ({ ...s, overwritePending: true }));
        return;
      }
      beginRecording(cameraObjectId);
    },
    [editor, recorder, timeline, beginRecording],
  );

  const cancelOverwrite = useCallback(() => {
    pendingRecordingRef.current = null;
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
    // 录制绑定会话令牌已过期（项目切换/重开，含同 URI 重开）→ 仅停止并丢弃
    // 样本：更早注册的 listener 在 project:changed 同步阶段触达 stopRecording
    // 时，本 hook 的取消分支尚未执行，此检查兜底旧会话样本不进入新项目
    // （复审阻断 3）
    const recordedToken = recordedSessionTokenRef.current;
    if (recordedToken === null || !editor.isCurrentSession(recordedToken)) {
      recorder.stop();
      recordedSessionTokenRef.current = null;
      recordedProjectUriRef.current = null;
      setState((s) => ({ ...s, recording: false, recordingPaused: false }));
      timeline.pause();
      return;
    }
    const cameraObjectId = recorder.recordingCameraId;
    const projectUri = recorder.boundProjectUri;
    const channels = recorder.stop();
    recordedSessionTokenRef.current = null;
    recordedProjectUriRef.current = null;
    setState((s) => ({ ...s, recording: false, recordingPaused: false }));
    // 停止时重验绑定身份：项目已切换或相机已删除 → 丢弃样本，不提交
    const project = editor.getProject();
    const camera =
      channels && project && project.uri === projectUri && cameraObjectId
        ? (project.objects.find((o) => o.id === cameraObjectId) ?? null)
        : null;
    if (camera && channels && cameraObjectId) {
      const label = camera.name;
      const tracks: TrackData[] = [];
      for (const channel of ['position', 'rotation', 'focalLength'] as const) {
        const samples = channels[channel];
        if (!samples || samples.length === 0) continue;
        // 通道语义传给抽稀：rotation 按 slerp 角距离判定（与回放求值同源，
        // 复审阻断 1）；position 欧氏距离、focalLength 绝对值
        const keyframes = simplifySamples(samples, { channel }) as TrackKeyframeData[];
        if (keyframes.length === 0) continue;
        tracks.push(
          createTrack(cameraObjectId, channel as TrackTargetPath, `录制${label}·${CHANNEL_LABELS[channel]}`, keyframes),
        );
      }
      if (tracks.length > 0) {
        // 一次原子批量提交：三通道同生共死，失败不留下半提交（审查第 7 项）
        const result = editor.commitRecordingTracks(tracks, '录制关键帧');
        if (!result.ok) showToast(result.error.message, 'error');
      }
    }
    timeline.pause();
    const current = editor.getProject();
    if (current) timeline.setDuration(getProjectDuration(current));
    timeline.seek(0);
  }, [editor, recorder, timeline]);

  /** 会话对象稳定：仅 state 字段随渲染原地更新。下游 effect 以整个 session 为
   *  依赖（相机驾驶/回放订阅），身份稳定则录制期间不重建 —— 修复录制后段
   *  每帧 drive.stop() 清空按键输入（TML-52 审查第 1 项）。回调均以稳定引用
   *  持有（useCallback deps 只含 ref 实例），首次创建后无需重建。 */
  const sessionRef = useRef<TimelineSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = {
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
    };
  }
  sessionRef.current.state = state;

  return sessionRef.current;
}
