import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneEditor, createSampleProject, getProjectDuration } from '@lumora/core';
import type { RenderHookResult } from '@testing-library/react';
import type { CaptureNodeSample } from '../src/components/editor/camera-drive';
import { useTimelineSession } from '../src/hooks/use-timeline-session';
import type { TimelineSession } from '../src/hooks/use-timeline-session';

let editor: SceneEditor;
let unmount: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  // 假定时器下 performance.now 不与 rAF 同步推进（sinon 用独立时间基）：
  // 改借假 Date.now 作时间源，随 advanceTimersByTime 一起走，dt 为真实的 16ms/帧
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  editor = new SceneEditor();
  editor.openProject(createSampleProject());
});

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type HookRef = RenderHookResult<TimelineSession, unknown>;
/** result.current 是活动渲染的实时引用；会话对象每次状态变更都会重建，必须实时读取 */
let hook: HookRef;
function live(): TimelineSession {
  return hook.result.current;
}

function mount() {
  hook = renderHook(() => useTimelineSession(editor));
  unmount = hook.unmount;
}

describe('useTimelineSession：录制/回放会话（AC1 数据链路 + AC2 失焦保护）', () => {
  it('初始状态：时长/帧率/缩放取自项目与控制器，未播放未录制', () => {
    mount();
    expect(live().state.playing).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.overwritePending).toBe(false);
    expect(live().state.duration).toBeCloseTo(getProjectDuration(editor.getProject()!), 6);
    expect(live().state.fps).toBe(24);
    expect(live().state.snapEnabled).toBe(true);
    expect(live().state.loopEnabled).toBe(true);
  });

  it('togglePlay 切换播放状态', () => {
    mount();
    act(() => live().togglePlay());
    expect(live().state.playing).toBe(true);
    expect(live().timeline.isPlaying()).toBe(true);
    act(() => live().togglePlay());
    expect(live().state.playing).toBe(false);
  });

  it('目标机位已有录制轨道 → 覆盖确认；取消不录制，确认后开始', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    expect(live().state.overwritePending).toBe(true);
    expect(live().state.recording).toBe(false);
    act(() => live().cancelOverwrite());
    expect(live().state.overwritePending).toBe(false);
    expect(live().recorder.active).toBe(false);

    act(() => live().startRecording('sample-camera'));
    expect(live().state.overwritePending).toBe(true);
    act(() => live().confirmOverwrite());
    expect(live().state.overwritePending).toBe(false);
    expect(live().state.recording).toBe(true);
    expect(live().recorder.recordingCameraId).toBe('sample-camera');
  });

  it('AC1：模拟 5 秒量级录制 → 各通道样本抽稀为升序关键帧写入轨道，停止后时长收敛并回到 0s', () => {
    mount();
    let tick = 0;
    const source = vi.fn((): CaptureNodeSample => {
      tick += 1;
      return { position: [tick, 0, 0], rotation: [0, 0, 0], focalLength: 35 };
    });
    act(() => live().setCaptureSource(source));
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(2000));
    expect(source.mock.calls.length).toBeGreaterThan(100); // 采样器实时采样

    act(() => live().stopRecording());
    const project = editor.getProject()!;
    const tracks = project.tracks.filter((t) => t.objectId === 'sample-camera');
    expect(tracks.map((t) => t.targetPath).sort()).toEqual(['focalLength', 'position', 'rotation']);
    for (const track of tracks) {
      expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
      expect(track.keyframes.length).toBeLessThanOrEqual(3); // 直线样本抽稀到端点
      for (let i = 1; i < track.keyframes.length; i += 1) {
        expect(track.keyframes[i]!.time).toBeGreaterThan(track.keyframes[i - 1]!.time);
      }
      // 直线样本抽稀到首尾两端：首帧落在 0s 附近（首个 rAF 帧 dt=0），末帧约 2s；
      // 关键帧数 ≤3 同时证明旧轨道（项目自带的 4+ 帧）确实被录制结果覆盖
      expect(track.keyframes[0]!.time).toBeLessThan(0.05);
      expect(track.keyframes[track.keyframes.length - 1]!.time).toBeCloseTo(2, 1);
    }
    expect(live().state.recording).toBe(false);
    // 时长收敛到项目时长（含示例项目其它轨道）
    expect(live().state.duration).toBeCloseTo(getProjectDuration(editor.getProject()!), 6);
    expect(live().timeline.getTime()).toBe(0); // 播放头回到起点
  });

  it('AC2：录制中页面失焦 → 录制与播放暂停且不再采样；恢复后继续', () => {
    mount();
    const source = vi.fn((): CaptureNodeSample => ({ position: [0, 0, 0], rotation: [0, 0, 0], focalLength: 35 }));
    act(() => live().setCaptureSource(source));
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(200));
    const beforeBlur = source.mock.calls.length;
    expect(beforeBlur).toBeGreaterThan(10);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(live().state.recordingPaused).toBe(true);
    expect(live().state.playing).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(source.mock.calls.length).toBe(beforeBlur); // 暂停期间零采样

    act(() => live().resumeRecording());
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.playing).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(source.mock.calls.length).toBeGreaterThan(beforeBlur); // 恢复采样
    act(() => live().stopRecording());
  });

  it('录制中播放键 = 暂停/恢复录制；关闭项目重置会话', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => live().togglePlay());
    expect(live().state.recordingPaused).toBe(true);
    expect(live().state.playing).toBe(false);
    act(() => live().togglePlay());
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.playing).toBe(true);
    act(() => live().stopRecording());

    // 关闭项目（reset 发出 project:changed(null)）：时长归零、播放头归位
    act(() => {
      editor.reset();
    });
    expect(live().state.duration).toBe(0);
    expect(live().timeline.getTime()).toBe(0);
    expect(live().state.recording).toBe(false);
  });
});
