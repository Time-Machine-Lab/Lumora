import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor, TimelineController, createCameraObject, createTrack } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { RefObject } from 'react';
import { TimelinePanel } from '../src/components/editor/TimelinePanel';
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
function mountPanel(overrides: Partial<TimelineSession> = {}, selection: string[] = []) {
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
    <TimelinePanel session={session} editor={editor} project={project} selection={selection} captureRef={captureRef} />,
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

  it('播放头随真实 seek 移动并更新时间显示', () => {
    const { timeline } = mountPanel();
    act(() => timeline.seek(0.5));
    expect(screen.getByTestId('timeline-playhead').style.left).toBe(`${0.5 * timeline.getZoom()}px`);
    expect(screen.getByTestId('timeline-time').textContent).toBe('00:00.50');
  });

  it('关键帧菱形点击定位到该帧时间', () => {
    const { session, project } = mountPanel();
    const trackId = project.tracks[0]!.id;
    fireEvent.click(screen.getByTestId(`keyframe-${trackId}-1`));
    expect(session.seek).toHaveBeenCalledWith(1);
  });

  it('分镜：点击区块定位起点；‹› 重排提交 reorderShots（AC4）', () => {
    const { session, editor } = mountPanel();
    fireEvent.click(screen.getByTestId('shot-block-s2'));
    expect(session.seek).toHaveBeenCalledWith(1);

    expect(screen.getByTestId('shot-move-left-s1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('shot-move-right-s1'));
    expect(editor.getProject()!.shots.map((s) => s.id)).toEqual(['s2', 's1', 's3']); // AC4 顺序持久
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

  it('无截图通道时缩略图安全降级：显示机位名而非 img', () => {
    mountPanel();
    const shot = screen.getByTestId('shot-block-s1');
    expect(shot.querySelector('.lumora-timeline__shot-camera')?.textContent).toBe('主相机');
    expect(shot.querySelector('img')).toBeNull();
  });
});
