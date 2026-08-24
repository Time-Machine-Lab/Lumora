import { describe, expect, it, vi } from 'vitest';
import type { CaptureNodeSample } from '../src/components/editor/camera-drive';
import type { CaptureSource } from '../src/components/editor/timeline-recorder';
import { TimelineRecorder } from '../src/components/editor/timeline-recorder';

function fixedSource(sample: CaptureNodeSample): CaptureSource {
  return vi.fn(() => sample);
}

const FIXED: CaptureNodeSample = { position: [1, 2, 3], rotation: [0, 0, 0], focalLength: 35 };

describe('TimelineRecorder：采样采集器', () => {
  it('start 后 active 且绑定机位；sample 逐帧采集三通道', () => {
    const recorder = new TimelineRecorder();
    const source = fixedSource(FIXED);
    recorder.setCaptureSource(source);
    recorder.start('cam', 'lumora://test');
    expect(recorder.active).toBe(true);
    expect(recorder.isPaused).toBe(false);
    expect(recorder.recordingCameraId).toBe('cam');
    expect(recorder.boundProjectUri).toBe('lumora://test');

    expect(recorder.sample(0)).toBe(true);
    expect(recorder.sample(1.5)).toBe(true);
    const channels = recorder.stop()!;
    expect(channels.position).toHaveLength(2);
    expect(channels.position![0]).toEqual({ time: 0, value: [1, 2, 3] });
    expect(channels.position![1]).toEqual({ time: 1.5, value: [1, 2, 3] });
    expect(channels.rotation).toHaveLength(2);
    expect(channels.focalLength).toHaveLength(2);
  });

  it('未 start 时 sample/stop 均为 no-op', () => {
    const recorder = new TimelineRecorder();
    recorder.setCaptureSource(fixedSource(FIXED));
    expect(recorder.sample(1)).toBe(false);
    expect(recorder.stop()).toBeNull();
  });

  it('无采集源时不产生采样，stop 返回空通道；无焦距采样时焦距通道为 null（相机节点缺失保护）', () => {
    const recorder = new TimelineRecorder();
    recorder.start('cam', 'lumora://test');
    expect(recorder.sample(0)).toBe(false); // 无源 → 不采集
    const empty = recorder.stop();
    expect(empty).not.toBeNull();
    expect(empty!.position).toHaveLength(0);

    recorder.start('cam', 'lumora://test');
    recorder.setCaptureSource(
      vi.fn((): CaptureNodeSample => ({ position: [0, 0, 0], rotation: [0, 0, 0], focalLength: null })),
    );
    expect(recorder.sample(0)).toBe(true);
    const channels = recorder.stop()!;
    expect(channels.position).toHaveLength(1);
    expect(channels.focalLength).toBeNull();
  });

  it('pause 期间 sample 为 no-op，resume 后恢复采集', () => {
    const recorder = new TimelineRecorder();
    const source = fixedSource(FIXED);
    recorder.setCaptureSource(source);
    recorder.start('cam', 'lumora://test');
    recorder.sample(0);
    recorder.pause();
    expect(recorder.isPaused).toBe(true);
    expect(recorder.sample(0.5)).toBe(false);
    expect(recorder.sample(1)).toBe(false);
    recorder.resume();
    expect(recorder.isPaused).toBe(false);
    expect(recorder.sample(2)).toBe(true);
    const channels = recorder.stop();
    // 暂停段不产生采样：只有 0 与 2
    expect(channels!.position!.map((s) => s.time)).toEqual([0, 2]);
  });

  it('stop 返回通道后清空状态（再次 stop 为 null）', () => {
    const recorder = new TimelineRecorder();
    recorder.setCaptureSource(fixedSource(FIXED));
    recorder.start('cam', 'lumora://test');
    recorder.sample(0);
    const first = recorder.stop();
    expect(first).not.toBeNull();
    expect(recorder.active).toBe(false);
    expect(recorder.recordingCameraId).toBeNull();
    expect(recorder.stop()).toBeNull();
  });
});
