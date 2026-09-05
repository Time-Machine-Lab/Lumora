import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneEditor, createGroupObject, createSampleProject, getProjectDuration } from '@lumora/core';
import type { RenderHookResult } from '@testing-library/react';
import type { CaptureNodeSample } from '../src/components/editor/camera-drive';
import { CAMERA_DRIVE_LIMITS } from '../src/components/editor/camera-drive';
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
    expect(live().state.cameraControls.mode).toBe('keyboard-mouse');
    expect(live().state.cameraControls.invertMouseY).toBe(false);
  });

  it('机位操控参数按会话保存、过滤非有限值并夹取范围，切换项目后保持', () => {
    mount();
    act(() => live().setCameraControlSettings({
      mode: 'keyboard-only',
      speed: 99,
      tapStep: -1,
      mouseSensitivity: Number.NaN,
      invertMouseY: true,
    }));

    expect(live().state.cameraControls).toMatchObject({
      mode: 'keyboard-only',
      speed: CAMERA_DRIVE_LIMITS.speed.max,
      tapStep: CAMERA_DRIVE_LIMITS.tapStep.min,
      mouseSensitivity: 1,
      invertMouseY: true,
    });

    act(() => editor.openProject({ ...createSampleProject(), uri: 'lumora://camera-controls-next' }));
    expect(live().state.cameraControls).toMatchObject({
      mode: 'keyboard-only',
      speed: CAMERA_DRIVE_LIMITS.speed.max,
      tapStep: CAMERA_DRIVE_LIMITS.tapStep.min,
      mouseSensitivity: 1,
      invertMouseY: true,
    });

    act(() => live().setCameraControlSettings({ invertMouseY: false }));
    expect(live().state.cameraControls.invertMouseY).toBe(false);
  });

  it('重新挂载编辑器会话后，鼠标垂直反转随其他机位参数恢复默认值', () => {
    mount();
    act(() => live().setCameraControlSettings({ invertMouseY: true }));
    expect(live().state.cameraControls.invertMouseY).toBe(true);

    unmount?.();
    unmount = null;
    mount();

    expect(live().state.cameraControls.invertMouseY).toBe(false);
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

  it('录制提交失败时保留暂停样本并允许重试，不把失败伪装成已停止', () => {
    mount();
    act(() => live().setCaptureSource(() => ({ position: [1, 0, 0], rotation: [0, 0, 0], focalLength: 35 })));
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(300));
    const commit = vi.spyOn(editor, 'commitRecordingTracks').mockReturnValue({
      ok: false,
      error: new Error('模拟录制提交失败'),
    });

    let failed: ReturnType<TimelineSession['stopRecording']>;
    act(() => {
      failed = live().stopRecording();
    });
    expect(failed!).toEqual({ ok: false, message: '模拟录制提交失败' });
    expect(live().recorder.active).toBe(true);
    expect(live().recorder.isPaused).toBe(true);
    expect(live().state.recording).toBe(true);
    expect(live().state.recordingPaused).toBe(true);

    commit.mockRestore();
    let retried: ReturnType<TimelineSession['stopRecording']>;
    act(() => {
      retried = live().stopRecording();
    });
    expect(retried!).toEqual({ ok: true });
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
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

  it('begin recording drops its stale state write when play synchronously opens project B', () => {
    const sample = createSampleProject();
    editor.openProject({ ...sample, uri: 'lumora://recording-begin-a', tracks: [] });
    mount();
    const projectB = { ...sample, uri: 'lumora://recording-begin-b', tracks: [] };
    const sub = live().timeline.events.on('state:changed', ({ playing }) => {
      if (playing && editor.getProject()?.uri !== projectB.uri) editor.openProject(projectB);
    });

    act(() => live().startRecording('sample-camera'));

    expect(editor.getProject()?.uri).toBe(projectB.uri);
    expect(live().recorder.active).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.playing).toBe(false);
    sub.dispose();
  });

  it('resume recording drops its stale state write when play synchronously opens project B', () => {
    const sample = createSampleProject();
    editor.openProject({ ...sample, uri: 'lumora://recording-resume-a', tracks: [] });
    mount();
    act(() => {
      live().startRecording('sample-camera');
      live().pause();
    });
    expect(live().recorder.isPaused).toBe(true);
    const projectB = { ...sample, uri: 'lumora://recording-resume-b', tracks: [] };
    const sub = live().timeline.events.on('state:changed', ({ playing }) => {
      if (playing && editor.getProject()?.uri !== projectB.uri) editor.openProject(projectB);
    });

    act(() => live().resumeRecording());

    expect(editor.getProject()?.uri).toBe(projectB.uri);
    expect(live().recorder.active).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.playing).toBe(false);
    sub.dispose();
  });

  it('pause recording drops its stale state write when pause synchronously opens project B', () => {
    const sample = createSampleProject();
    editor.openProject({ ...sample, uri: 'lumora://recording-pause-a', tracks: [] });
    mount();
    act(() => live().startRecording('sample-camera'));
    const projectB = { ...sample, uri: 'lumora://recording-pause-b', tracks: [] };
    const sub = live().timeline.events.on('state:changed', ({ playing }) => {
      if (!playing && editor.getProject()?.uri !== projectB.uri) editor.openProject(projectB);
    });

    act(() => live().togglePlay());

    expect(editor.getProject()?.uri).toBe(projectB.uri);
    expect(live().recorder.active).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.playing).toBe(false);
    sub.dispose();
  });

  it('blur pause drops its stale state write when pause synchronously opens project B', () => {
    const sample = createSampleProject();
    editor.openProject({ ...sample, uri: 'lumora://recording-blur-a', tracks: [] });
    mount();
    act(() => live().startRecording('sample-camera'));
    const projectB = { ...sample, uri: 'lumora://recording-blur-b', tracks: [] };
    const sub = live().timeline.events.on('state:changed', ({ playing }) => {
      if (!playing && editor.getProject()?.uri !== projectB.uri) editor.openProject(projectB);
    });

    act(() => window.dispatchEvent(new Event('blur')));

    expect(editor.getProject()?.uri).toBe(projectB.uri);
    expect(live().recorder.active).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().state.recordingPaused).toBe(false);
    expect(live().state.playing).toBe(false);
    sub.dispose();
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

  it('同 URI 项目重开（会话令牌递增）→ 录制立即取消，样本不写入新项目（复审阻断 3）', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(300));
    expect(live().recorder.active).toBe(true);
    // 同 URI 重开：仅按 uri 判定会把旧会话误判为同一会话；会话令牌已变
    act(() => editor.openProject(createSampleProject()));
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    expect(editor.getProject()!.tracks.every((t) => !t.name.startsWith('录制'))).toBe(true);
  });

  it('覆盖确认绑定会话：同 URI 重开后 pending 作废，新项目同 ID 相机不误启动录制（复审阻断 3）', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    expect(live().state.overwritePending).toBe(true);
    // 新项目包含同 ID 相机（示例项目重开）；旧确认必须失效
    act(() => editor.openProject(createSampleProject()));
    expect(live().state.overwritePending).toBe(false);
    act(() => live().confirmOverwrite());
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
  });

  it('A→B 直接打开 / 同 URI 重开：无条件暂停并回零（复审阻断 3，不再只在项目从 null 打开时回零）', () => {
    mount();
    // 播放推进到中间时刻
    act(() => live().togglePlay());
    act(() => vi.advanceTimersByTime(1500));
    expect(live().timeline.getTime()).toBeGreaterThan(1);
    // A→B 直接打开：播放头必须暂停并回零，不得带着旧项目的时刻进入新项目
    act(() => editor.openProject({ ...createSampleProject(), uri: 'lumora://other-project' }));
    expect(live().timeline.isPlaying()).toBe(false);
    expect(live().timeline.getTime()).toBe(0);
    // 同 URI 重开：同样无条件暂停并回零
    act(() => live().togglePlay());
    act(() => vi.advanceTimersByTime(800));
    expect(live().timeline.getTime()).toBeGreaterThan(0.5);
    act(() => editor.openProject(createSampleProject()));
    expect(live().timeline.isPlaying()).toBe(false);
    expect(live().timeline.getTime()).toBe(0);
  });

  it('drops an outer project event when an earlier listener synchronously opens a newer session', () => {
    const projectB = {
      ...createSampleProject(),
      uri: 'lumora://project-b',
      settings: { ...createSampleProject().settings, fps: 24 },
    };
    const projectC = {
      ...createSampleProject(),
      uri: 'lumora://project-c',
      settings: { ...createSampleProject().settings, fps: 60 },
      tracks: [],
      shots: [],
    };
    const earlySub = editor.events.on('project:changed', ({ project }) => {
      if (project?.uri === projectB.uri) editor.openProject(projectC);
    });
    mount();

    act(() => editor.openProject(projectB));

    expect(editor.getProject()?.uri).toBe(projectC.uri);
    expect(live().timeline.getFps()).toBe(60);
    expect(live().timeline.getDuration()).toBe(0);
    expect(live().state.fps).toBe(60);
    expect(live().state.duration).toBe(0);
    earlySub.dispose();
  });

  it('converges on C when applying project B fps synchronously opens C from inside the hook', () => {
    const sample = createSampleProject();
    const projectB = {
      ...sample,
      uri: 'lumora://project-b',
      settings: { ...sample.settings, fps: 30 },
      tracks: [],
      shots: [{ ...sample.shots[0]!, startTime: 0, endTime: 4.5 }],
    };
    const projectC = {
      ...sample,
      uri: 'lumora://project-c',
      settings: { ...sample.settings, fps: 60 },
      tracks: [],
      shots: [{ ...sample.shots[0]!, startTime: 0, endTime: 8 }],
    };
    mount();
    const settingsSub = live().timeline.events.on('settings:changed', ({ fps }) => {
      if (fps === 30 && editor.getProject()?.uri === projectB.uri) editor.openProject(projectC);
    });

    act(() => editor.openProject(projectB));

    expect(editor.getProject()?.uri).toBe(projectC.uri);
    expect(live().timeline.getFps()).toBe(60);
    expect(live().timeline.getDuration()).toBe(8);
    expect(live().state.fps).toBe(60);
    expect(live().state.duration).toBe(8);

    // A same-session C edit must not be mistaken for another session switch.
    act(() => {
      live().timeline.seek(2, false);
      live().timeline.play();
      expect(editor.addObject(createGroupObject()).ok).toBe(true);
    });
    expect(live().timeline.getTime()).toBe(2);
    expect(live().timeline.isPlaying()).toBe(true);
    settingsSub.dispose();
  });

  it('keeps nested C playing when deleting the only shot re-enters setDuration through time changed', () => {
    const sample = createSampleProject();
    const onlyShot = { ...sample.shots[0]!, id: 'only-shot', startTime: 0, endTime: 10 };
    editor.openProject({
      ...sample,
      uri: 'lumora://duration-reentry',
      tracks: [],
      shots: [onlyShot],
    });
    mount();
    const sessionToken = editor.getSessionToken();
    act(() => {
      live().timeline.seek(5, false);
      live().timeline.play();
    });
    const settingsDurations: number[] = [];
    const settingsSub = live().timeline.events.on('settings:changed', ({ duration }) => {
      settingsDurations.push(duration);
    });
    let nested = false;
    const timeSub = live().timeline.events.on('time:changed', ({ time }) => {
      if (nested || time !== 0 || editor.getProject()?.shots.length !== 0) return;
      nested = true;
      expect(editor.addShot({ ...onlyShot, id: 'nested-shot', endTime: 8 }).ok).toBe(true);
    });

    act(() => {
      expect(editor.deleteShot(onlyShot.id).ok).toBe(true);
    });

    expect(nested).toBe(true);
    expect(editor.getSessionToken()).toBe(sessionToken);
    expect(editor.getProject()?.shots.map((shot) => shot.id)).toEqual(['nested-shot']);
    expect({
      controllerDuration: live().timeline.getDuration(),
      stateDuration: live().state.duration,
      controllerPlaying: live().timeline.isPlaying(),
      statePlaying: live().state.playing,
      settingsDurations,
    }).toEqual({
      controllerDuration: 8,
      stateDuration: 8,
      controllerPlaying: true,
      statePlaying: true,
      settingsDurations: [8],
    });
    timeSub.dispose();
    settingsSub.dispose();
  });

  it('更早注册的 project:changed listener 同步执行旧 confirm/stop → 入口自检拒绝，样本不写入新项目（复审阻断 3）', () => {
    // 先于 hook 内部 listener 注册：openProject 同步分发 project:changed 时本
    // listener 先执行，hook 的取消分支尚未运行 —— 只能靠 confirm/stop 入口的
    // isCurrentSession 自检兜底旧会话动作
    const staleCalls: string[] = [];
    const earlySub = editor.events.on('project:changed', () => {
      if (live().state.recording) staleCalls.push('stop');
      if (live().state.overwritePending) staleCalls.push('confirm');
      live().stopRecording();
      live().confirmOverwrite();
    });
    mount();
    // 覆盖确认挂起 → 同 URI 重开：旧 confirm 不得在新会话启动录制
    act(() => live().startRecording('sample-camera'));
    expect(live().state.overwritePending).toBe(true);
    act(() => editor.openProject(createSampleProject()));
    expect(live().state.overwritePending).toBe(false);
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
    // 录制中 → 同 URI 重开：旧 stop 不得把样本提交进新项目
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    act(() => vi.advanceTimersByTime(300));
    expect(live().recorder.active).toBe(true);
    act(() => editor.openProject(createSampleProject()));
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
    expect(live().timeline.isPlaying()).toBe(false);
    expect(editor.getProject()!.tracks.every((t) => !t.name.startsWith('录制'))).toBe(true);
    expect(staleCalls).toEqual(['confirm', 'stop']);
    earlySub.dispose();
  });

  it('录制扩容后绑定机位被删除 → 取消录制并把时长收敛回项目时长（复审阻断 3）', () => {
    mount();
    act(() => live().startRecording('sample-camera'));
    act(() => live().confirmOverwrite());
    // 录制超过示例项目时长（4.5s）→ 时长按整秒分块扩容
    act(() => vi.advanceTimersByTime(6000));
    expect(live().timeline.getDuration()).toBeGreaterThanOrEqual(6);
    act(() => {
      editor.setSelection(['sample-camera']);
      editor.deleteSelection();
    });
    expect(live().recorder.active).toBe(false);
    expect(live().state.recording).toBe(false);
    const converged = getProjectDuration(editor.getProject()!);
    expect(live().timeline.getDuration()).toBeCloseTo(converged, 6);
    expect(live().state.duration).toBeCloseTo(converged, 6);
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
