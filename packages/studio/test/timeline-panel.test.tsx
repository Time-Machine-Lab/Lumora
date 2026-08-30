import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor, TimelineController, createCameraObject, createTrack } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { RefObject } from 'react';
import {
  TIMELINE_LABEL_WIDTH,
  TimelinePanel,
} from '../src/components/editor/TimelinePanel';
import { projectContentFingerprint } from '../src/components/editor/timeline-thumbnail-cache';
import { TimelineRecorder } from '../src/components/editor/timeline-recorder';
import { DEFAULT_CAMERA_DRIVE_SETTINGS } from '../src/components/editor/camera-drive';
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
    cameraControls: { ...DEFAULT_CAMERA_DRIVE_SETTINGS },
  };
}

/** 每次调用独立挂载；同一测试内多个场景必须先 unmount() 上一棵再挂载（screen 查询作用于最新渲染树） */
function mountPanel(
  overrides: Partial<TimelineSession> = {},
  selection: string[] = [],
  captureReady = false,
  initialProject = makeProject(),
) {
  const editor = new SceneEditor();
  const project = initialProject;
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
    setCameraControlSettings: vi.fn(),
    startRecording: vi.fn(),
    confirmOverwrite: vi.fn(),
    cancelOverwrite: vi.fn(),
    resumeRecording: vi.fn(),
    stopRecording: vi.fn(),
    ...overrides,
  };
  const captureRef = { current: null } as RefObject<((cameraObjectId?: string | null) => string | null) | null>;
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

  it('录制前可选择操控模式并调整速度、短按步长和鼠标灵敏度', () => {
    const view = mountPanel({}, ['cam']);
    const keyboardMouse = screen.getByRole('button', { name: '键盘移动 + 鼠标视角' });
    const keyboardOnly = screen.getByRole('button', { name: '纯键盘操控' });

    expect(keyboardMouse).toHaveAttribute('aria-pressed', 'true');
    expect(keyboardOnly).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(keyboardOnly);
    expect(view.session.setCameraControlSettings).toHaveBeenCalledWith({ mode: 'keyboard-only' });

    const speed = screen.getByLabelText('连续移动速度');
    const tapStep = screen.getByLabelText('短按移动步长');
    const sensitivity = screen.getByLabelText('鼠标视角灵敏度');
    expect(speed).toHaveAttribute('type', 'range');
    expect(tapStep).toHaveAttribute('type', 'range');
    expect(sensitivity).toHaveAttribute('type', 'range');
    fireEvent.change(speed, { target: { value: '4.5' } });
    fireEvent.change(tapStep, { target: { value: '0.2' } });
    fireEvent.change(sensitivity, { target: { value: '1.4' } });

    expect(view.session.setCameraControlSettings).toHaveBeenCalledWith({ speed: 4.5 });
    expect(view.session.setCameraControlSettings).toHaveBeenCalledWith({ tapStep: 0.2 });
    expect(view.session.setCameraControlSettings).toHaveBeenCalledWith({ mouseSensitivity: 1.4 });
  });

  it('录制中显示停止动作，点击停止录制；录制暂停态点击继续', () => {
    const stop = mountPanel({ state: { ...baseState(), recording: true } });
    expect(screen.getByTestId('timeline-record')).toHaveAccessibleName('停止录制');
    fireEvent.click(screen.getByTestId('timeline-record'));
    expect(stop.session.stopRecording).toHaveBeenCalledTimes(1);
    stop.unmount();

    const resume = mountPanel({ state: { ...baseState(), recording: true, recordingPaused: true } });
    expect(screen.getByTestId('timeline-record')).toHaveAccessibleName('继续录制');
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

  it('标尺提供 slider 语义并支持 Arrow/Page/Home/End 键定位', () => {
    const { session } = mountPanel();
    const ruler = screen.getByTestId('timeline-ruler');
    expect(ruler).toHaveAttribute('role', 'slider');
    expect(ruler).toHaveAccessibleName('时间线播放头');
    expect(ruler).toHaveAttribute('aria-valuemin', '0');
    expect(ruler).toHaveAttribute('aria-valuemax', '3');

    fireEvent.keyDown(ruler, { key: 'ArrowRight' });
    fireEvent.keyDown(ruler, { key: 'PageUp' });
    fireEvent.keyDown(ruler, { key: 'PageDown' });
    fireEvent.keyDown(ruler, { key: 'End' });
    fireEvent.keyDown(ruler, { key: 'Home' });
    expect(session.seek).toHaveBeenNthCalledWith(1, 1 / 24);
    expect(session.seek).toHaveBeenNthCalledWith(2, 1);
    expect(session.seek).toHaveBeenNthCalledWith(3, 0);
    expect(session.seek).toHaveBeenNthCalledWith(4, 3);
    expect(session.seek).toHaveBeenNthCalledWith(5, 0);
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

  it('适配缩放只按可用时间区宽度与总时长计算，不被短分镜放大', () => {
    const project = makeProject();
    project.shots[0] = { ...project.shots[0]!, endTime: 0.1 };
    const view = mountPanel({}, [], false, project);
    const body = screen.getByTestId('timeline-body');
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 375 });

    fireEvent.click(screen.getByTitle('适配时长'));

    expect(view.session.setZoom).toHaveBeenCalledWith((375 - TIMELINE_LABEL_WIDTH) / 3);
  });

  it('分镜比例区块只负责选中，选中分镜的跳转与重排动作固定在标签列', () => {
    const view = mountPanel();
    fireEvent.click(screen.getByTestId('shot-block-s2'));

    const shot = screen.getByTestId('shot-block-s2');
    const actions = screen.getByTestId('selected-shot-actions');
    expect(shot.tagName).toBe('BUTTON');
    expect(shot.querySelector('button')).toBeNull();
    expect(actions).toContainElement(screen.getByTestId('shot-move-left-s2'));
    expect(actions).toContainElement(screen.getByTestId('shot-jump-s2'));
    expect(actions).toContainElement(screen.getByTestId('shot-move-right-s2'));

    fireEvent.click(screen.getByTestId('shot-move-left-s2'));
    expect(view.editor.getProject()!.shots.map((shot) => shot.id)).toEqual(['s2', 's1', 's3']);
  });

  it('60fps 相邻关键帧分配到不重叠的命中行', () => {
    const project = makeProject();
    project.settings.fps = 60;
    project.tracks[0] = {
      ...project.tracks[0]!,
      keyframes: [
        { time: 1, value: [0, 0, 0] },
        { time: 1 + 1 / 60, value: [1, 0, 0] },
      ],
    };
    const view = mountPanel({ state: { ...baseState(), fps: 60, zoom: 240 } }, [], false, project);
    const trackId = project.tracks[0]!.id;
    const first = screen.getByTestId(`keyframe-${trackId}-1`);
    const second = screen.getByTestId(`keyframe-${trackId}-${1 + 1 / 60}`);

    expect(first.style.top).not.toBe(second.style.top);
    expect(screen.getByTestId(`track-row-${trackId}`).style.height).toBe('88px');
    expect(view.session.seek).not.toHaveBeenCalled();
  });

  it('60fps 密集轨道保持两行内，并可从聚合目标循环访问每个关键帧', () => {
    const project = makeProject();
    project.settings.fps = 60;
    const keyframes = Array.from({ length: 60 }, (_, index) => ({
      time: 1 + index / 60,
      value: [index, 0, 0] as [number, number, number],
    }));
    project.tracks[0] = { ...project.tracks[0]!, keyframes };

    for (const zoom of [240, 30]) {
      const view = mountPanel({ state: { ...baseState(), fps: 60, zoom } }, [], false, project);
      const trackId = project.tracks[0]!.id;
      const row = screen.getByTestId(`track-row-${trackId}`);
      const clusters = screen.getAllByTestId(new RegExp(`^keyframe-cluster-${trackId}-`));

      expect(Number.parseFloat(row.style.height)).toBeLessThanOrEqual(88);
      expect(screen.getByTestId(`track-lane-${trackId}`)).toBeInTheDocument();
      expect(screen.getByTestId('timeline-shots')).toBeInTheDocument();
      expect(clusters.length).toBeGreaterThan(0);

      if (zoom === 30) {
        expect(clusters).toHaveLength(1);
        expect(clusters[0]).toHaveAttribute('data-keyframe-count', '60');
        vi.mocked(view.session.seek).mockClear();
        keyframes.forEach(() => fireEvent.click(clusters[0]!));
        expect(vi.mocked(view.session.seek).mock.calls.map(([time]) => time)).toEqual(
          keyframes.map(({ time }) => time),
        );
      }
      view.unmount();
    }
  });

  it('分镜：固定动作栏定位起点；‹› 重排提交 reorderShots（AC4：视觉/时间顺序同变）', () => {
    const view = mountPanel();
    fireEvent.click(screen.getByTestId('shot-block-s2'));
    expect(view.session.seek).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByTestId('shot-block-s1'));
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
    fireEvent.click(screen.getByTestId('shot-block-s3'));
    expect(screen.getByTestId('shot-move-right-s3')).toBeDisabled();
  });

  it('轨道与分镜比例区块使用有名称的原生按钮，固定动作栏提供跳转', () => {
    const view = mountPanel();
    const trackId = view.project.tracks[0]!.id;
    const track = screen.getByTestId(`track-lane-${trackId}`);
    const shot = screen.getByRole('button', { name: '选择分镜：中段' });
    expect(track.tagName).toBe('BUTTON');
    expect(track).toHaveAccessibleName('选择轨道：主相机·位置');
    expect(track.querySelector('input, button')).toBeNull();
    expect(shot.querySelector('button')).toBeNull();

    fireEvent.click(track);
    fireEvent.click(shot);
    fireEvent.click(screen.getByRole('button', { name: '跳转至分镜：中段' }));
    expect(view.editor.getSelection()).toEqual(['cam']);
    expect(view.session.seek).toHaveBeenCalledWith(1);
  });

  it('禁用开关写入轨道 disabled；点击泳道行选中机位', () => {
    const { editor, project } = mountPanel();
    const trackId = project.tracks[0]!.id;
    fireEvent.click(screen.getByTestId(`track-disabled-${trackId}`));
    expect(editor.getProject()!.tracks[0]!.disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`track-lane-${trackId}`));
    expect(editor.getSelection()).toEqual(['cam']);
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

    // 分镜绑定变化（cameraObjectId 改空）→ 内容指纹换代 → 全量重截（旧代键淘汰，
    // 不残留上代 data URI；复审阻断 2：编辑后必须重截而非复用旧键）
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
    expect(counter).toBe(9); // 指纹换代：3 个分镜全部重截
    expect(screen.getByTestId('shot-block-s2').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-8',
    );
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-7',
    );
    raf.mockRestore();
  });

  it('对象变换编辑换代：全量重截且 capture 携带分镜绑定机位（复审阻断 2 反例）', async () => {
    // 反例：仅改对象位移（不触及 shots/tracks 结构）后，旧实现键不变 → 3 张
    // data URI 逐字节保留、编辑不生效；修复后指纹换代 → 旧键淘汰、全部重截
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    const seen: Array<string | null | undefined> = [];
    const capture = vi.fn((cameraObjectId?: string | null) => {
      seen.push(cameraObjectId);
      return `data:image/png;base64,img-${seen.length}`;
    });
    const view = mountPanel({}, [], false);
    view.captureRef.current = capture;
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
    expect(capture).toHaveBeenCalledTimes(3);
    // 每次截图显式携带分镜绑定机位（s3 未绑定 → null = 当前相机）
    expect(seen).toEqual(['cam', 'cam', null]);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-1',
    );

    act(() =>
      view.editor.commitTransform('cam', { position: [2.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    );
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
    expect(capture).toHaveBeenCalledTimes(6);
    expect(seen.slice(3)).toEqual(['cam', 'cam', null]);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,img-4',
    );
    raf.mockRestore();
  });

  it('same-session active-scene switch and render-content settlement each invalidate every thumbnail', async () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const project = {
      ...makeProject(),
      scenes: [
        ...makeProject().scenes,
        { id: 'scene-2', name: 'Scene 2', rootObjectIds: [], activeCameraId: null },
      ],
    };
    let count = 0;
    const capture = vi.fn(() => `data:image/png;base64,generation-${(count += 1)}`);
    const view = mountPanel({}, [], false, project);
    view.captureRef.current = capture;
    const renderPanel = (captureGeneration: number) => (
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.editor.getProject()!}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
        captureGeneration={captureGeneration}
      />
    );

    view.rerender(renderPanel(0));
    await act(async () => {});
    expect(capture).toHaveBeenCalledTimes(3);

    act(() => view.editor.setActiveScene('scene-2'));
    view.rerender(renderPanel(0));
    await act(async () => {});
    expect(capture).toHaveBeenCalledTimes(6);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,generation-4',
    );

    view.rerender(renderPanel(1));
    await act(async () => {});
    expect(capture).toHaveBeenCalledTimes(9);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,generation-7',
    );
    raf.mockRestore();
  });

  it('does not cache transient null captures and retries after a later render generation', async () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const capture = vi.fn<() => string | null>(() => null);
    const view = mountPanel();
    view.captureRef.current = capture;
    const renderPanel = (captureGeneration: number) => (
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={view.project}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
        captureGeneration={captureGeneration}
      />
    );

    view.rerender(renderPanel(0));
    await act(async () => {});
    expect(capture).toHaveBeenCalledTimes(9);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')).toBeNull();

    capture.mockImplementation(() => 'data:image/png;base64,recovered');
    view.rerender(renderPanel(1));
    await act(async () => {});
    expect(capture).toHaveBeenCalledTimes(12);
    expect(screen.getByTestId('shot-block-s1').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,recovered',
    );
    raf.mockRestore();
  });

  it('limits an always-failing shot to three attempts while sibling thumbnails succeed', async () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const project = {
      ...makeProject(),
      scenes: makeProject().scenes.map((scene) => ({
        ...scene,
        rootObjectIds: [...scene.rootObjectIds, 'cam-fail', 'cam-success'],
      })),
      objects: [
        ...makeProject().objects,
        { ...createCameraObject(), id: 'cam-fail', name: 'Failing camera' },
        { ...createCameraObject(), id: 'cam-success', name: 'Successful camera' },
      ],
      shots: [
        { ...makeProject().shots[0]!, cameraObjectId: 'cam-fail' },
        { ...makeProject().shots[1]!, cameraObjectId: 'cam-success' },
        { ...makeProject().shots[2]!, cameraObjectId: null },
      ],
    };
    const capture = vi.fn((cameraObjectId?: string | null) =>
      cameraObjectId === 'cam-fail' ? null : `data:image/png;base64,${cameraObjectId ?? 'director'}`,
    );
    const view = mountPanel({}, [], false, project);
    view.captureRef.current = capture;
    const renderPanel = (captureGeneration: number) => (
      <TimelinePanel
        session={view.session}
        editor={view.editor}
        project={project}
        selection={[]}
        captureRef={view.captureRef}
        captureReady
        captureGeneration={captureGeneration}
      />
    );

    view.rerender(renderPanel(0));
    await act(async () => {});
    expect(capture.mock.calls.filter(([cameraId]) => cameraId === 'cam-fail')).toHaveLength(3);
    expect(screen.getByTestId('shot-block-s2').querySelector('img')).not.toBeNull();
    expect(screen.getByTestId('shot-block-s3').querySelector('img')).not.toBeNull();

    view.rerender(renderPanel(0));
    await act(async () => {});
    expect(capture.mock.calls.filter(([cameraId]) => cameraId === 'cam-fail')).toHaveLength(3);

    view.rerender(renderPanel(1));
    await act(async () => {});
    expect(capture.mock.calls.filter(([cameraId]) => cameraId === 'cam-fail')).toHaveLength(6);
    raf.mockRestore();
  });
});

describe('projectContentFingerprint：缩略图失效代', () => {
  it('影响画面的编辑改变指纹；资源载荷字节与运行期 storageRef 不计入', () => {
    const project = makeProject();
    const edited = {
      ...project,
      objects: project.objects.map((o, i) =>
        i === 0 ? { ...o, transform: { ...o.transform, position: [2.5, 0, 0] as [number, number, number] } } : o,
      ),
    };
    const trackEdited = { ...project, tracks: project.tracks.map((t) => ({ ...t, keyframes: [...t.keyframes] })) };
    const shotEdited = { ...project, shots: project.shots.map((s, i) => (i === 1 ? { ...s, endTime: 2.5 } : s)) };
    const assetPayload = {
      ...project,
      assets: [
        {
          id: 'a1',
          kind: 'gltf' as const,
          name: '车',
          mime: 'model/gltf+json',
          hash: 'h',
          size: 1,
          source: 'file' as const,
          storageRef: 'blob:tmp',
          payload: 'AAAA',
          createdAt: '2026-08-20T00:00:00.000Z',
        },
      ],
    };
    const storageRefOnly = {
      ...assetPayload,
      assets: [{ ...assetPayload.assets[0]!, payload: 'BBBB', storageRef: 'blob:other' }],
    };
    expect(projectContentFingerprint(edited)).not.toBe(projectContentFingerprint(project));
    // 仅 keyframes 数组引用变化、内容未变 → 指纹稳定
    expect(projectContentFingerprint(trackEdited)).toBe(projectContentFingerprint(project));
    expect(projectContentFingerprint(shotEdited)).not.toBe(projectContentFingerprint(project));
    expect(projectContentFingerprint(assetPayload)).not.toBe(projectContentFingerprint(project));
    // payload/storageRef 不计入 → 同内容不同载荷/引用指纹一致
    expect(projectContentFingerprint(storageRefOnly)).toBe(projectContentFingerprint(assetPayload));
  });

  it('includes activeSceneId even when every scene and object record is unchanged', () => {
    const project = {
      ...makeProject(),
      scenes: [
        ...makeProject().scenes,
        { id: 'scene-2', name: 'Scene 2', rootObjectIds: [], activeCameraId: null },
      ],
    };
    const switched = { ...project, activeSceneId: 'scene-2' };
    expect(projectContentFingerprint(switched)).not.toBe(projectContentFingerprint(project));
  });
});
