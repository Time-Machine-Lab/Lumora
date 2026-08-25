import { render } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SceneEditor,
  TimelineController,
  createCameraObject,
  createTrack,
  focalLengthToFovDeg,
} from '@lumora/core';
import type { Project, SceneObjectData } from '@lumora/core';
import { PlaybackDriver } from '../src/components/editor/PlaybackDriver';
import { TimelineRecorder } from '../src/components/editor/timeline-recorder';
import { buildScene, findNode } from '../src/components/editor/scene-builder';
import type { TimelineSession } from '../src/hooks/use-timeline-session';
import type { RefObject } from 'react';

function cameraObject(): SceneObjectData {
  return {
    ...createCameraObject(),
    id: 'cam',
    name: '主相机',
    transform: { position: [0, 1.6, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
}

function makeProject(withFocal = false): Project {
  return {
    uri: 'lumora://playback',
    name: '回放',
    schemaVersion: 4,
    createdAt: '2026-08-20T00:00:00.000Z',
    revision: 0,
    settings: { fps: 24, aspect: [16, 9] },
    activeSceneId: 's1',
    scenes: [{ id: 's1', name: '主场景', rootObjectIds: ['cam'], activeCameraId: 'cam' }],
    objects: [cameraObject()],
    tracks: [
      createTrack('cam', 'position', '主相机·位置', [
        { time: 0, value: [0, 1, 2] },
        { time: 2, value: [4, 1, 2] },
      ]),
      ...(withFocal
        ? [
            createTrack('cam', 'focalLength', '主相机·焦距', [
              { time: 0, value: 50 },
              { time: 2, value: 100 },
            ]),
          ]
        : []),
    ],
    shots: [],
    assets: [],
  };
}

function makeSession(timeline: TimelineController, recorder: TimelineRecorder): TimelineSession {
  return {
    timeline,
    recorder,
    state: {
      playing: false,
      recording: false,
      recordingPaused: false,
      overwritePending: false,
      duration: timeline.getDuration(),
      fps: timeline.getFps(),
      zoom: timeline.getZoom(),
      snapEnabled: timeline.isSnapEnabled(),
      loopEnabled: timeline.isLoopEnabled(),
    },
    togglePlay: () => {},
    pause: () => {},
    seek: (t: number) => timeline.seek(t),
    zoomBy: () => {},
    setZoom: () => {},
    setSnap: () => {},
    setLoop: () => {},
    setCaptureSource: () => {},
    startRecording: () => {},
    confirmOverwrite: () => {},
    cancelOverwrite: () => {},
    resumeRecording: () => {},
    stopRecording: () => {},
  };
}

function harness(project: Project) {
  const editor = new SceneEditor();
  editor.openProject(project);
  const timeline = new TimelineController();
  // 时长必须显式给定：seek 夹取在 [0, duration]，时长 0 时 seek 是 no-op
  timeline.setDuration(3);
  const recorder = new TimelineRecorder();
  const root = buildScene(project, 16 / 9);
  const rootRef = { current: root } as RefObject<THREE.Group | null>;
  const skipIdsRef = { current: null } as RefObject<Set<string> | null>;
  const session = makeSession(timeline, recorder);
  const rendered = render(
    <PlaybackDriver session={session} editor={editor} rootRef={rootRef} skipIdsRef={skipIdsRef} />,
  );
  const node = findNode(root, 'cam')!;
  return { editor, timeline, recorder, session, node, unmount: rendered.unmount };
}

describe('PlaybackDriver：时间引擎驱动的场景回放', () => {
  it('seek 应用线性插值（AC3：两个关键帧 + Linear → 确定性时间插值）', () => {
    const { timeline, node } = harness(makeProject());
    act(() => timeline.seek(1));
    expect(node.position.x).toBeCloseTo(2);
    expect(node.position.y).toBeCloseTo(1);
    expect(node.position.z).toBeCloseTo(2);
    act(() => timeline.seek(0.5));
    expect(node.position.x).toBeCloseTo(1);
    act(() => timeline.seek(0));
    expect(node.position.x).toBeCloseTo(0);
  });

  it('暂停（state:changed false）保留当前帧画面，与播放头时间一致', () => {
    const { timeline, node } = harness(makeProject());
    act(() => timeline.seek(1));
    expect(node.position.x).toBeCloseTo(2);
    timeline.setDuration(2);
    act(() => timeline.play());
    act(() => timeline.pause());
    // 暂停不还原静态位姿：画面停在播放头时刻的求值结果（审查第 2 项）
    expect(timeline.getTime()).toBe(1);
    expect(node.position.x).toBeCloseTo(2);
    expect(node.position.y).toBeCloseTo(1);
    expect(node.position.z).toBeCloseTo(2);
  });

  it('非循环到末尾自停：画面停在末尾求值而非静态位姿', () => {
    const { timeline, node } = harness(makeProject());
    timeline.setLoop(false);
    act(() => timeline.play());
    act(() => timeline.tick(5)); // 越过 3s 时长 → 停在 3s 并自停
    expect(timeline.getTime()).toBe(3);
    expect(node.position.x).toBeCloseTo(4); // 3s 越界收敛到末关键帧值，非静态位姿 0
  });

  it('显式退出时间线（驱动卸载）才还原静态位姿', () => {
    const { timeline, node, unmount } = harness(makeProject());
    act(() => timeline.seek(1));
    expect(node.position.x).toBeCloseTo(2);
    act(() => unmount());
    expect(node.position.x).toBeCloseTo(0);
    expect(node.position.y).toBeCloseTo(1.6);
    expect(node.position.z).toBeCloseTo(6);
  });

  it('禁用轨道不参与回放，节点保持静态位姿', () => {
    const { editor, timeline, node } = harness(makeProject());
    const trackId = editor.getProject()!.tracks[0]!.id;
    act(() => editor.updateTrack(trackId, (t) => ({ ...t, disabled: true }), '禁用'));
    act(() => timeline.seek(1));
    expect(node.position.x).toBeCloseTo(0);
    expect(node.position.y).toBeCloseTo(1.6);
  });

  it('录制机位由驾驶接管：录制期间不应用也不还原', () => {
    const { timeline, recorder, node } = harness(makeProject());
    act(() => timeline.seek(1));
    expect(node.position.x).toBeCloseTo(2);
    recorder.start('cam', 'lumora://playback');
    act(() => timeline.seek(2));
    expect(node.position.x).toBeCloseTo(2); // 跳过轨道值，保留驾驶位姿
    act(() => timeline.pause());
    expect(node.position.x).toBeCloseTo(2); // 还原同样跳过录制机位
    recorder.stop();
    // 时间已停在 2s（同值 seek 不发事件），用 2.5s 触发回放：越界保持端点值
    act(() => timeline.seek(2.5));
    expect(node.position.x).toBeCloseTo(4); // 停止后恢复驱动
  });

  it('focalLength 轨道回放应用到相机 fov（userData 标记）', () => {
    const { timeline, node } = harness(makeProject(true));
    act(() => timeline.seek(1));
    expect(node.userData.focalLength).toBe(75);
    expect((node as unknown as THREE.PerspectiveCamera).fov).toBeCloseTo(focalLengthToFovDeg(75), 6);
  });
});
