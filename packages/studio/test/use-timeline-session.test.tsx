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
/** result.current 是活动渲染的实时引用；会话对象身份稳定（仅 state 字段原地
 *  更新 —— 修复审查第 1 项后不再随状态变更重建），必须实时读取 state */
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

  it('AC1：真实约 5s 持续输入录制 → 各通道样本抽稀为升序关键帧写入轨道，停止后时长收敛并回到 0s', () => {
    mount();
    let tick = 0;
    const source = vi.fn((): CaptureNodeSample => {
      tick += 1;
      return { position: [tick, 0, 0], rotation: [0, 0, 0], focalLength: 35 };
    });
    act(() => live().setCaptureSource(source));
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(5000));
    expect(source.mock.calls.length).toBeGreaterThan(250); // ~312 帧持续采样（60Hz）

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
      // 直线样本抽稀到首尾两端：首帧落在 0s 附近（首个 rAF 帧 dt=0），末帧约 5s；
      // 关键帧数 ≤3 同时证明旧轨道（项目自带的 4+ 帧）确实被录制结果覆盖
      expect(track.keyframes[0]!.time).toBeLessThan(0.05);
      expect(track.keyframes[track.keyframes.length - 1]!.time).toBeCloseTo(5, 1);
    }
    expect(live().state.recording).toBe(false);
    // 时长收敛到项目时长（含示例项目其它轨道）
    expect(live().state.duration).toBeCloseTo(getProjectDuration(editor.getProject()!), 6);
    expect(live().timeline.getTime()).toBe(0); // 播放头回到起点
  });

  it('B1 回归：约 5s 持续录制中会话对象身份稳定 —— 驾驶输入不再被会话重建清空', () => {
    mount();
    const session = live();
    const source = vi.fn((): CaptureNodeSample => ({ position: [1, 0, 0], rotation: [0, 0, 0], focalLength: 35 }));
    act(() => live().setCaptureSource(source));
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(5000));
    // 时长随录制分块扩容（1 秒块、约 1Hz），播放头持续推进不绕回
    expect(live().state.recording).toBe(true);
    expect(live().timeline.getTime()).toBeGreaterThan(4.5);
    // 审查第 1 项根因：每帧 setDuration → 状态更新 → 会话重建 → 驾驶 effect
    // cleanup 调 drive.stop()。修复后身份全程不变，下游 effect 不重建
    expect(live()).toBe(session);
    act(() => live().stopRecording());
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

  it('录制绑定项目身份：录制中切换到另一项目 → 立即取消，样本不写入新项目（审查第 7 项）', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(300));
    expect(live().recorder.active).toBe(true);
    const other = { ...createSampleProject(), uri: 'lumora://other-project' };
    act(() => editor.openProject(other));
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    // 新项目未混入旧项目的录制轨道（示例项目自带轨道无「录制」标签）
    expect(editor.getProject()!.tracks.every((t) => !t.name.startsWith('录制'))).toBe(true);
  });

  it('录制中绑定机位被删除 → 自动取消录制并丢弃样本（审查第 7 项）', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(300));
    expect(live().recorder.active).toBe(true);
    act(() => {
      editor.setSelection(['sample-camera']);
      editor.deleteSelection();
    });
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
  });

  it('覆盖确认期间目标机位被删除 → 确认不再开始录制（审查第 7 项重验）', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    expect(live().state.overwritePending).toBe(true);
    act(() => {
      editor.setSelection(['sample-camera']);
      editor.deleteSelection();
    });
    act(() => live().confirmOverwrite());
    expect(live().state.overwritePending).toBe(false);
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
  });

  it('停止录制时重验身份：相机已删除 → 丢弃样本不提交（审查第 7 项）', () => {
    mount();
    const source = vi.fn((): CaptureNodeSample => ({ position: [1, 0, 0], rotation: [0, 0, 0], focalLength: 35 }));
    act(() => live().setCaptureSource(source));
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(300));
    act(() => {
      editor.setSelection(['sample-camera']);
      editor.deleteSelection(); // 级联删除绑定轨道（本身即一步历史）
    });
    const historyBefore = editor.getHistoryState();
    act(() => live().stopRecording());
    expect(live().recorder.active).toBe(false);
    // 相机与轨道已整体删除；停止录制不再尝试提交（无新增历史）
    expect(editor.getHistoryState().canUndo).toBe(historyBefore.canUndo);
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
