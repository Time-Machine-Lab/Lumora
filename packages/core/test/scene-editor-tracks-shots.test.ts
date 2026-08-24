import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import { createCameraObject, createGroupObject, createShotClip, createTrack } from '../src/scene/create';
import type { ShotClipData, TrackData, TrackKeyframeData, TrackKeyframeValue } from '../src/scene/types';

function makeEditor(): SceneEditor {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value as T;
}

function positionTrack(objectId = 'sample-camera'): TrackData {
  return createTrack(objectId, 'position', '推镜', [
    { time: 0, value: [0, 0, 0] },
    { time: 2, value: [0, 0, 2] },
  ]);
}

describe('SceneEditor 轨道写入口', () => {
  it('addTrack：绑定对象必须存在；track id 重复拒绝', () => {
    const editor = makeEditor();
    const id = ok(editor.addTrack(positionTrack()));
    expect(editor.getProject()!.tracks.some((t) => t.id === id)).toBe(true);
    expect(editor.addTrack({ ...positionTrack(), objectId: 'ghost' }).ok).toBe(false);
    const existing = editor.getProject()!.tracks.find((t) => t.id === id)!;
    expect(editor.addTrack({ ...existing }).ok).toBe(false);
  });

  it('updateTrack：id/绑定对象/通道不可修改，其余可撤销更新', () => {
    const editor = makeEditor();
    const id = ok(editor.addTrack(positionTrack()));
    expect(editor.updateTrack(id, (t) => ({ ...t, id: 'renamed' }), 'x').ok).toBe(false);
    expect(editor.updateTrack(id, (t) => ({ ...t, objectId: 'sample-cube' }), 'x').ok).toBe(false);
    expect(editor.updateTrack(id, (t) => ({ ...t, targetPath: 'rotation' }), 'x').ok).toBe(false);
    ok(editor.updateTrack(id, (t) => ({ ...t, disabled: true, name: '禁用' }), '禁用轨道'));
    const stored = editor.getProject()!.tracks.find((t) => t.id === id)!;
    expect(stored.disabled).toBe(true);
    expect(stored.name).toBe('禁用');
    ok(editor.undo());
    expect(editor.getProject()!.tracks.find((t) => t.id === id)!.disabled).toBeUndefined();
  });

  it('deleteTrack：删除轨道不删绑定对象；可撤销', () => {
    const editor = makeEditor();
    const id = ok(editor.addTrack(positionTrack()));
    const objectCount = editor.getProject()!.objects.length;
    ok(editor.deleteTrack(id));
    expect(editor.getProject()!.tracks.some((t) => t.id === id)).toBe(false);
    expect(editor.getProject()!.objects.length).toBe(objectCount);
    expect(editor.deleteTrack(id).ok).toBe(false);
    ok(editor.undo());
    expect(editor.getProject()!.tracks.some((t) => t.id === id)).toBe(true);
  });

  it('setTrackKeyframes：整体替换关键帧；校验升序/非负有限时间/值类型', () => {
    const editor = makeEditor();
    const id = ok(editor.addTrack(positionTrack()));
    ok(editor.setTrackKeyframes(id, [
      { time: 0.5, value: [1, 2, 3], interpolation: 'smooth' },
      { time: 3, value: [4, 5, 6] },
    ]));
    let stored = editor.getProject()!.tracks.find((t) => t.id === id)!;
    expect(stored.keyframes.map((k) => k.time)).toEqual([0.5, 3]);
    expect(editor.setTrackKeyframes(id, [{ time: 2, value: [0, 0, 0] }, { time: 1, value: [0, 0, 0] }]).ok).toBe(false);
    expect(editor.setTrackKeyframes(id, [{ time: -1, value: [0, 0, 0] }]).ok).toBe(false);
    const malformed: TrackKeyframeData = { time: 0, value: [0, 0] as unknown as TrackKeyframeValue };
    expect(editor.setTrackKeyframes(id, [malformed]).ok).toBe(false);
    expect(editor.setTrackKeyframes(id, [{ time: 0, value: [NaN, 0, 0] }]).ok).toBe(false);
    ok(editor.undo());
    stored = editor.getProject()!.tracks.find((t) => t.id === id)!;
    expect(stored.keyframes).toHaveLength(2);
  });

  it('setTrackKeyframes：标量通道（focalLength）只接受有限 number', () => {
    const editor = makeEditor();
    const id = ok(editor.addTrack(createTrack('sample-camera', 'focalLength', '变焦')));
    ok(editor.setTrackKeyframes(id, [
      { time: 0, value: 50 },
      { time: 2, value: 35 },
    ]));
    expect(editor.setTrackKeyframes(id, [{ time: 0, value: [1, 2, 3] }]).ok).toBe(false);
    expect(editor.setTrackKeyframes(id, [{ time: 0, value: Infinity }]).ok).toBe(false);
  });

  it('删除绑定对象：绑定轨道级联删除（TML-88 语义延续）', () => {
    const editor = makeEditor();
    const objectId = ok(editor.addObject(createCameraObject('要删的机位')));
    const trackId = ok(editor.addTrack(positionTrack(objectId)));
    editor.setSelection([objectId]);
    ok(editor.deleteSelection());
    expect(editor.getProject()!.tracks.some((t) => t.id === trackId)).toBe(false);
  });
});

describe('SceneEditor 分镜写入口', () => {
  it('addShot：机位引用必须存在；区段要求 endTime > startTime 且时间有限', () => {
    const editor = makeEditor();
    const id = ok(editor.addShot(createShotClip('sample-camera', '开场', { startTime: 0, endTime: 2 })));
    const shot = editor.getProject()!.shots.find((s) => s.id === id)!;
    expect(shot.cameraObjectId).toBe('sample-camera');
    expect(editor.addShot(createShotClip('ghost-camera', '坏机位')).ok).toBe(false);
    expect(editor.addShot(createShotClip(null, '未绑定', { startTime: 2, endTime: 1 })).ok).toBe(false);
    expect(editor.addShot(createShotClip(null, 'NaN 区段', { startTime: 0, endTime: NaN })).ok).toBe(false);
    expect(editor.addShot({ ...createShotClip(null, '无名'), name: '' }).ok).toBe(false);
  });

  it('updateShot：id 不可修改；可改名/换绑机位/调区段；可撤销', () => {
    const editor = makeEditor();
    const id = ok(editor.addShot(createShotClip('sample-camera', '开场', { startTime: 0, endTime: 2 })));
    expect(editor.updateShot(id, (s) => ({ ...s, id: 'renamed' }), 'x').ok).toBe(false);
    expect(editor.updateShot(id, (s) => ({ ...s, cameraObjectId: 'ghost' }), 'x').ok).toBe(false);
    ok(editor.updateShot(id, (s) => ({ ...s, cameraObjectId: null, name: '未绑定开场' }), '解绑机位'));
    let stored = editor.getProject()!.shots.find((s) => s.id === id)!;
    expect(stored.cameraObjectId).toBeNull();
    expect(stored.name).toBe('未绑定开场');
    ok(editor.undo());
    stored = editor.getProject()!.shots.find((s) => s.id === id)!;
    expect(stored.cameraObjectId).toBe('sample-camera');
  });

  it('deleteShot：删除分镜不影响机位对象；可撤销', () => {
    const editor = makeEditor();
    const id = ok(editor.addShot(createShotClip('sample-camera', '开场')));
    const camera = editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!;
    ok(editor.deleteShot(id));
    expect(editor.getProject()!.shots.some((s) => s.id === id)).toBe(false);
    expect(editor.getProject()!.objects.some((o) => o.id === camera.id)).toBe(true);
    ok(editor.undo());
    expect(editor.getProject()!.shots.some((s) => s.id === id)).toBe(true);
  });

  it('删除机位对象：绑定分镜保留但解除机位绑定（不悬空引用）', () => {
    const editor = makeEditor();
    const cameraId = ok(editor.addObject(createCameraObject('临时机位')));
    const shotId = ok(editor.addShot(createShotClip(cameraId, '临时分镜', { startTime: 0, endTime: 2 })));
    editor.setSelection([cameraId]);
    ok(editor.deleteSelection());
    const shot = editor.getProject()!.shots.find((s) => s.id === shotId)!;
    expect(shot.cameraObjectId).toBeNull();
    expect(shot.name).toBe('临时分镜');
  });

  it('reorderShots：排列重排持久化；非排列拒绝；同序 no-op', () => {
    const editor = makeEditor();
    const shots = editor.getProject()!.shots.map((s) => s.id);
    expect(shots).toHaveLength(3);
    const reversed = [...shots].reverse();
    ok(editor.reorderShots(reversed));
    expect(editor.getProject()!.shots.map((s) => s.id)).toEqual(reversed);
    expect(editor.reorderShots([shots[0]!, shots[0]!, shots[1]!]).ok).toBe(false);
    expect(editor.reorderShots([shots[0]!]).ok).toBe(false);
    expect(editor.reorderShots(['ghost', ...shots.slice(1)]).ok).toBe(false);
    // 同序：返回 ok 且不发历史
    const historyBefore = editor.getHistoryState();
    ok(editor.reorderShots(reversed));
    const historyAfter = editor.getHistoryState();
    expect(historyAfter.canUndo).toBe(historyBefore.canUndo);
    expect(historyAfter.canRedo).toBe(historyBefore.canRedo);
    ok(editor.undo());
    expect(editor.getProject()!.shots.map((s) => s.id)).toEqual(shots);
  });

  it('分镜排序在 openProject 往返后保持一致（AC4：重排并保存 → 重开一致）', () => {
    const editor = makeEditor();
    const shots = editor.getProject()!.shots.map((s) => s.id);
    const reordered = [shots[2]!, shots[0]!, shots[1]!];
    ok(editor.reorderShots(reordered));
    const persisted = editor.getProject()!;
    const reopened = new SceneEditor();
    reopened.openProject(structuredClone(persisted));
    expect(reopened.getProject()!.shots.map((s) => s.id)).toEqual(reordered);
    expect(reopened.getProject()!.shots).toEqual(persisted.shots);
  });
});

describe('SceneEditor 分镜与轨道深度冻结（R6 语义延续）', () => {
  it('addShot 后调用方改入参嵌套字段：编辑器状态不受影响', () => {
    const editor = makeEditor();
    const shot = createShotClip('sample-camera', '开场', { startTime: 0, endTime: 2 });
    ok(editor.addShot(shot));
    shot.name = '事后改名';
    const stored = editor.getProject()!.shots.find((s) => s.id === shot.id)!;
    expect(stored.name).toBe('开场');
  });

  it('reorderShots 参数数组被调用方事后修改：编辑器顺序不受影响', () => {
    const editor = makeEditor();
    const shots = editor.getProject()!.shots.map((s) => s.id);
    const ordered = [...shots].reverse();
    ok(editor.reorderShots(ordered));
    ordered.push('ghost');
    expect(editor.getProject()!.shots.map((s) => s.id)).toEqual([...shots].reverse());
  });
});
