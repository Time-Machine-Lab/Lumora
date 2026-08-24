import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor, TimelineController, createCameraObject, createTrack } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { RefObject } from 'react';
import { TIMELINE_LABEL_WIDTH, TimelinePanel } from '../src/components/editor/TimelinePanel';
import { TimelineRecorder } from '../src/components/editor/timeline-recorder';
import type { TimelineSession, TimelineSessionState } from '../src/hooks/use-timeline-session';

function makeProject(): Project {
  return {
    uri: 'lumora://panel',
    name: '面板',
    schemaVersion: 4,
    createdAt: '2026-08-20T00:00:00.000Z',
    revision: 0,
    settings: { fps: 24, aspect: [16, 9] },
    activeSceneId: 's1',
    scenes: [{ id: 's1', name: '主场景', rootObjectIds: ['cam'], activeCameraId: 'cam' }],
    objects: [{ ...createCameraObject(), id: 'cam', name: '主相机' }],
    tracks: [
      createTrack('cam', 'position', '主相机·位置', [
        { time: 0, value: [0, 0, 0] },
        { time: 1, value: [1, 0, 0] },
      ]),
    ],
    shots: [
      { id: 's1', name: '开篇', startTime: 0, endTime: 1, cameraObjectId: 'cam' },
      { id: 's2', name: '中段', startTime: 1, endTime: 2, cameraObjectId: 'cam' },
      { id: 's3', name: '收尾', startTime: 2, endTime: 3, cameraObjectId: null },
    ],
    assets: [],
  };
}

function baseState(): TimelineSessionState {
  return {
    playing: false,
    recording: false,
    recordingPaused: false,
    overwritePending: false,
    duration: 3,
    fps: 24,
    zoom: new TimelineController().getZoom(),
    snapEnabled: true,
    loopEnabled: true,
  };
}

/** 每次调用独立挂载；同一测试内多个场景必须先 unmount() 上一棵再挂载（screen 查询作用于最新渲染树） */
function mountPanel(overrides: Partial<TimelineSession> = {}, selection: string[] = [], captureReady = false) {
  const editor = new SceneEditor();
  const project = makeProject();
  editor.openProject(project);
  const timeline = new TimelineController();
  timeline.setDuration(3);
  const recorder = new TimelineRecorder();
  const session: TimelineSession = {
    timeline,
    recorder,
    state: { ...baseState(), ...(overrides.state ?? {}) },
    togglePlay: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    zoomBy: vi.fn(),
    setZoom: vi.fn(),
    setSnap: vi.fn(),
    setLoop: vi.fn(),
    setCaptureSource: vi.fn(),
    startRecording: vi.fn(),
    confirmOverwrite: vi.fn(),
    cancelOverwrite: vi.fn(),
    resumeRecording: vi.fn(),
    stopRecording: vi.fn(),
    ...overrides,
  };
  const captureRef = { current: null } as RefObject<(() => string | null) | null>;
  const view = render(
    <TimelinePanel
      session={session}
      editor={editor}
      project={project}
      selection={selection}
      captureRef={captureRef}
      captureReady={captureReady}
    />,
  );
  return { ...view, session, editor, project, timeline, captureRef };
}

describe('TimelinePanel：运输控制、标尺、泳道与分镜', () => {
  it('渲染运输控制与时间/帧显示，无选中机位时录制禁用', () => {
    const { project } = mountPanel();
    expect(screen.getByTestId('timeline-time').textContent).toBe('00:00.00');
    expect(screen.getByTestId('timeline-frame').textContent).toContain('0');
    expect(screen.getByText('24 fps')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-play')).toBeEnabled();
    expect(screen.getByTestId('timeline-record')).toBeDisabled();
    expect(screen.getByTestId(`track-lane-${project.tracks[0]!.id}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^shot-block-/)).toHaveLength(3);
  });

  it('播放按钮触发 togglePlay；选中机位后录制可用并传给 startRecording', () => {
    const first = mountPanel();
    fireEvent.click(screen.getByTestId('timeline-play'));
    expect(first.session.togglePlay).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = mountPanel({}, ['cam']);
    expect(screen.getByTestId('timeline-record')).toBeEnabled();
    fireEvent.click(screen.getByTestId('timeline-record'));
    expect(second.session.startRecording).toHaveBeenCalledWith('cam');
  });

  it('录制中：播放键显示 ■，点击停止录制；录制暂停态点击继续', () => {
    const stop = mountPanel({ state: { ...baseState(), recording: true } });
    expect(screen.getByTestId('timeline-record').textContent).toBe('■');
    fireEvent.click(screen.getByTestId('timeline-record'));
    expect(stop.session.stopRecording).toHaveBeenCalledTimes(1);
    stop.unmount();

    const resume = mountPanel({ state: { ...baseState(), recording: true, recordingPaused: true } });
    expect(screen.getByTestId('timeline-record').textContent).toBe('▶');
    fireEvent.click(screen.getByTestId('timeline-record'));
    expect(resume.session.resumeRecording).toHaveBeenCalledTimes(1);
  });

  it('标尺拖拽 seek：按下定位、拖动跟随、抬起释放（吸附由控制器决定）', () => {
    const { session, timeline } = mountPanel();
    const zoom = timeline.getZoom();
    const ruler = screen.getByTestId('timeline-ruler');
    fireEvent.pointerDown(ruler, { clientX: 1 * zoom, button: 0, pointerId: 1 });
    expect(session.seek).toHaveBeenLastCalledWith(1);
    fireEvent.pointerMove(ruler, { clientX: 2 * zoom, pointerId: 1 });
    expect(session.seek).toHaveBeenLastCalledWith(2);
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: 3 * zoom, pointerId: 1 });
    expect(session.seek).toHaveBeenCalledTimes(2); // 抬起后不再跟手
  });

  it('播放头随真实 seek 移动并更新时间显示（共享坐标系：标签列右侧定位）', () => {
    const { timeline } = mountPanel();
    act(() => timeline.seek(0.5));
    // 播放头在共享时间坐标系中定位：标签列 + time * zoom（审查第 5 项）
    expect(screen.getByTestId('timeline-playhead').style.left).toBe(
      `${TIMELINE_LABEL_WIDTH + 0.5 * timeline.getZoom()}px`,
    );
    expect(screen.getByTestId('timeline-time').textContent).toBe('00:00.50');
  });

  it('关键帧与标尺刻度位于同一时间坐标系（时间画布内 time * zoom）', () => {
    const { timeline, project } = mountPanel();
    const zoom = timeline.getZoom();
    const trackId = project.tracks[0]!.id;
    expect(screen.getByTestId(`keyframe-${trackId}-1`).style.left).toBe(`${zoom}px`);
    expect(screen.getByTestId(`shot-block-s2`).style.left).toBe(`${zoom}px`);
  });

  it('关键帧菱形点击定位到该帧时间', () => {
    const { session, project } = mountPanel();
    const trackId = project.tracks[0]!.id;
    fireEvent.click(screen.getByTestId(`keyframe-${trackId}-1`));
    expect(session.seek).toHaveBeenCalledWith(1);
  });

  it('分镜：点击区块定位起点；‹› 重排提交 reorderShots（AC4：视觉/时间顺序同变）', () => {
    const view = mountPanel();
    fireEvent.click(screen.getByTestId('shot-block-s2'));
    expect(view.session.seek).toHaveBeenCalledWith(1);

    expect(screen.getByTestId('shot-move-left-s1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('shot-move-right-s1'));
    const shots = view.editor.getProject()!.shots;
    expect(shots.map((s) => s.id)).toEqual(['s2', 's1', 's3']); // 数组顺序
    // 原子重算区段时间：重排后按新顺序连续占槽（审查第 3 项 —— 仅改数组顺序
    // 而区块仍按旧 startTime 绝对定位，视觉顺序不变）
    expect(shots.map((s) => s.startTime)).toEqual([0, 1, 2]);
    expect(shots.map((s) => s.endTime)).toEqual([1, 2, 3]);
    // 面板以 project 属性渲染；重排提交后父级（LumoraStudio 同款行为）携新项目重渲染
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.editor.getProject()!}
        selection={[]}
        captureRef={view.captureRef}
      />,
    );
    expect(screen.getByTestId('shot-block-s2').style.left).toBe('0px'); // s2 移到最前
    expect(screen.getByTestId('shot-move-right-s3')).toBeDisabled();
  });

  it('禁用开关写入轨道 disabled；点击泳道行选中机位', () => {
    const { editor, project } = mountPanel();
    const trackId = project.tracks[0]!.id;
    fireEvent.click(screen.getByTestId(`track-disabled-${trackId}`));
    expect(editor.getProject()!.tracks[0]!.disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`track-lane-${trackId}`));
    expect(editor.getSelection()).toEqual(['cam']);
  });

  it('覆盖确认模态：确认/取消分别回调', () => {
    const confirm = mountPanel({ state: { ...baseState(), overwritePending: true } });
    expect(screen.getByTestId('overwrite-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByText('覆盖录制'));
    expect(confirm.session.confirmOverwrite).toHaveBeenCalledTimes(1);
    confirm.unmount();

    const cancel = mountPanel({ state: { ...baseState(), overwritePending: true } });
    fireEvent.click(screen.getByText('取消'));
    expect(cancel.session.cancelOverwrite).toHaveBeenCalledTimes(1);
  });

  it('覆盖确认模态：真模态语义（role/aria、焦点圈、Escape、Delete 拦截）', () => {
    const first = mountPanel({ state: { ...baseState(), overwritePending: true } });
    const dialog = screen.getByTestId('overwrite-confirm');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // 打开后焦点进入对话框内的首个可聚焦项（焦点圈起点，不再聚焦容器 ——
    // 容器持焦点时 Shift+Tab 直接逃出对话框，复审一般项 6）
    expect(screen.getByText('覆盖录制')).toHaveFocus();
    // 对话框内 Escape → 取消覆盖
    fireEvent.keyDown(screen.getByText('覆盖录制'), { key: 'Escape' });
    expect(first.session.cancelOverwrite).toHaveBeenCalledTimes(1);
    first.unmount();

    // 模态外按键被模态 capture 拦截：模拟 LumoraStudio 全局删除处理器（bubble
    // 层）注册在模态监听之后 —— stopImmediatePropagation 使其不触发（审查一般
    // 项：底层全局 Delete 不得穿透模态）
    const second = mountPanel({ state: { ...baseState(), overwritePending: true } });
    let globalSeen = false;
    const onGlobalKeyDown = () => {
      globalSeen = true;
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    window.removeEventListener('keydown', onGlobalKeyDown);
    expect(globalSeen).toBe(false);
    expect(second.session.cancelOverwrite).not.toHaveBeenCalled();
    second.unmount();
  });

  it('覆盖确认模态：Tab/Shift+Tab 焦点圈闭环，焦点逃逸到对话框外也拉回（复审一般项 6）', () => {
    mountPanel({ state: { ...baseState(), overwritePending: true } });
    const confirm = screen.getByText('覆盖录制');
    const cancel = screen.getByText('取消');
    expect(confirm).toHaveFocus();
    // 首个可聚焦项上 Shift+Tab：回环到末项（修复前逃逸出对话框）
    fireEvent.keyDown(confirm, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    // 末项上 Tab：回环到首项
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(confirm).toHaveFocus();
    // 焦点已在对话框外（模拟浏览器默认移动）→ Tab 拉回首项
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(confirm).toHaveFocus();
  });

  it('覆盖确认模态：对话框内应用快捷键被拦、空格放行原生激活；背景 inert（复审一般项 6）', () => {
    const view = mountPanel({ state: { ...baseState(), overwritePending: true } });
    const confirm = screen.getByText('覆盖录制');
    let globalSeen = false;
    const onGlobal = () => {
      globalSeen = true;
    };
    window.addEventListener('keydown', onGlobal);
    // 对话框内：应用快捷键拦截（Delete/Backspace/1/2/3、Ctrl/Cmd+K/Z/Y/D）
    fireEvent.keyDown(confirm, { key: 'Delete' });
    fireEvent.keyDown(confirm, { key: '1' });
    fireEvent.keyDown(confirm, { key: 'd', ctrlKey: true });
    fireEvent.keyDown(confirm, { key: 'k', metaKey: true });
    expect(globalSeen).toBe(false);
    // 对话框内空格：只阻断全局冒泡、不 preventDefault（保留按钮原生激活）
    fireEvent.keyDown(confirm, { key: ' ' });
    expect(globalSeen).toBe(false);
    expect(view.session.cancelOverwrite).not.toHaveBeenCalled();
    expect(view.session.confirmOverwrite).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onGlobal);
    // 背景 inert：模态打开时运输栏整体不可达（aria 语义）
    expect(screen.getByTestId('lumora-timeline').querySelector('.lumora-timeline__content')).toHaveAttribute('inert');
  });

  it('覆盖确认模态：关闭后焦点还原到触发按钮（复审一般项 6）', () => {
    // 选中机位使录制按钮可用 —— jsdom 对 disabled 元素调用 focus() 是空操作
    const view = mountPanel({}, ['cam']);
    const record = screen.getByTestId('timeline-record');
    record.focus();
    view.session.state = { ...baseState(), overwritePending: true };
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.project}
        selection={['cam']}
        captureRef={view.captureRef}
      />,
    );
    expect(screen.getByText('覆盖录制')).toHaveFocus();
    fireEvent.keyDown(screen.getByText('覆盖录制'), { key: 'Escape' });
    expect(view.session.cancelOverwrite).toHaveBeenCalledTimes(1);
    view.session.state = { ...baseState(), overwritePending: false };
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.project}
        selection={['cam']}
        captureRef={view.captureRef}
      />,
    );
    expect(record).toHaveFocus();
  });

  it('无截图通道时缩略图安全降级：显示机位名而非 img', () => {
    mountPanel();
    const shot = screen.getByTestId('shot-block-s1');
    expect(shot.querySelector('.lumora-timeline__shot-camera')?.textContent).toBe('主相机');
    expect(shot.querySelector('img')).toBeNull();
  });

  it('截图通道就绪 + 非空 capture → 缺失分镜缩略图补齐（复审阻断 2）', async () => {
    // jsdom 无真实 rAF 帧回调：同步执行回调，让截图链在一个微任务批次内完成
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    const view = mountPanel({}, [], false);
    // 通道就绪前（captureReady 缺省 false）：即便 capture 非空也不截取
    expect(screen.getByTestId('shot-block-s1').querySelector('img')).toBeNull();
    const capture = vi.fn(() => 'data:image/png;base64,abc');
    view.captureRef.current = capture; // 模拟 FrameCaptureBridge 挂载：仅改稳定 ref
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.project}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
      />,
    );
    await act(async () => {});
    raf.mockRestore();
    expect(capture).toHaveBeenCalledTimes(3);
    for (const shotId of ['s1', 's2', 's3']) {
      expect(screen.getByTestId(`shot-block-${shotId}`).querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,abc',
      );
    }
  });

  it('缩略图缓存键含会话令牌与分镜内容身份：项目切换/分镜改动后重新截取（复审阻断 2）', async () => {
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    let counter = 0;
    const capture = vi.fn(() => `data:image/png;base64,img-${(counter += 1)}`);
    const view = mountPanel({}, [], false);
    view.captureRef.current = capture;
    // captureReady 翻转（模拟 FrameCaptureBridge 挂载完成）→ 依赖变化触发效应重跑
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.project}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
      />,
    );
    await act(async () => {});
    expect(counter).toBe(3);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-1',
    );

    // 同 URI 重开（会话令牌递增，shot.id 相同）→ 旧键全部失效，重新截取
    act(() => view.editor.openProject(makeProject()));
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.editor.getProject()!}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
      />,
    );
    await act(async () => {});
    expect(counter).toBe(6);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-4',
    );

    // 分镜绑定变化（cameraObjectId 改空）→ 该分镜键失效，单独重截
    view.rerender(
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={{
          ...view.editor.getProject()!,
          shots: view.editor.getProject()!.shots.map((s, i) => (i === 1 ? { ...s, cameraObjectId: null } : s)),
        }}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
      />,
    );
    await act(async () => {});
    expect(counter).toBe(7); // 仅 s2 重截
    expect(screen.getByTestId('shot-block-s2').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-7',
    );
    raf.mockRestore();
  });
});
