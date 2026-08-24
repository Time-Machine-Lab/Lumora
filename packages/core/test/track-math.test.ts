import { describe, expect, it } from 'vitest';
import {
  evaluateTrack,
  getProjectDuration,
  getShotDuration,
  getTrackDuration,
  isSortedKeyframes,
  segmentInterpolation,
  simplifySamples,
} from '../src/scene/track-math';
import { createSampleProject } from '../src/scene/sample-project';
import { createTrack } from '../src/scene/create';
import type { TrackSample } from '../src/scene/track-math';
import type { Project, TrackData } from '../src/scene/types';

/** 线性轨道：0s [0,0,0] → 2s [2,0,0] → 4s [2,4,0] */
function linearPositionTrack(): TrackData {
  return createTrack('sample-camera', 'position', '推镜', [
    { time: 0, value: [0, 0, 0] },
    { time: 2, value: [2, 0, 0] },
    { time: 4, value: [2, 4, 0] },
  ]);
}

describe('segmentInterpolation / isSortedKeyframes', () => {
  it('缺省插值线性；显式 step/smooth 原样返回', () => {
    expect(segmentInterpolation({ time: 0, value: 0 })).toBe('linear');
    expect(segmentInterpolation({ time: 0, value: 0, interpolation: 'step' })).toBe('step');
    expect(segmentInterpolation({ time: 0, value: 0, interpolation: 'smooth' })).toBe('smooth');
  });

  it('升序判定：严格单调升序为真，等时/降序为假', () => {
    expect(
      isSortedKeyframes([
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ]),
    ).toBe(true);
    expect(
      isSortedKeyframes([
        { time: 1, value: 1 },
        { time: 1, value: 2 },
      ]),
    ).toBe(false);
    expect(
      isSortedKeyframes([
        { time: 2, value: 2 },
        { time: 1, value: 1 },
      ]),
    ).toBe(false);
  });
});

describe('evaluateTrack：确定性时间插值（AC3）', () => {
  it('线性插值：同一时刻恒得同一值，中点恰为两端均值', () => {
    const track = linearPositionTrack();
    const a = evaluateTrack(track, 1);
    const b = evaluateTrack(track, 1);
    expect(a).toEqual(b);
    expect(a!.value).toEqual([1, 0, 0]);
    expect(a!.span).toEqual([0, 1]);
  });

  it('两段线性：跨段连续，时刻单调推进值单调变化', () => {
    const track = linearPositionTrack();
    const at1 = evaluateTrack(track, 1)!.value as number[];
    const at3 = evaluateTrack(track, 3)!.value as number[];
    expect(at1).toEqual([1, 0, 0]);
    expect(at3).toEqual([2, 2, 0]);
  });

  it('越界保持端点值（首帧前/末帧后）', () => {
    const track = linearPositionTrack();
    expect(evaluateTrack(track, -5)!.value).toEqual([0, 0, 0]);
    expect(evaluateTrack(track, 100)!.value).toEqual([2, 4, 0]);
    expect(evaluateTrack(track, -5)!.time).toBe(0);
    expect(evaluateTrack(track, 100)!.time).toBe(4);
  });

  it('step 插值：段内保持左端点值到下一关键帧', () => {
    const track = createTrack('sample-camera', 'position', 'step', [
      { time: 0, value: [0, 0, 0], interpolation: 'step' },
      { time: 1, value: [1, 1, 1], interpolation: 'step' },
      { time: 2, value: [2, 2, 2], interpolation: 'step' },
    ]);
    expect(evaluateTrack(track, 0.5)!.value).toEqual([0, 0, 0]);
    expect(evaluateTrack(track, 1)!.value).toEqual([1, 1, 1]);
    expect(evaluateTrack(track, 1.9)!.value).toEqual([1, 1, 1]);
  });

  it('smooth 插值：经过全部关键帧点（端点插值精确通过）', () => {
    const track = createTrack('sample-camera', 'position', 'smooth', [
      { time: 0, value: [0, 0, 0], interpolation: 'smooth' },
      { time: 1, value: [1, 2, 0], interpolation: 'smooth' },
      { time: 2, value: [2, 0, 0], interpolation: 'smooth' },
    ]);
    expect(evaluateTrack(track, 0)!.value).toEqual([0, 0, 0]);
    expect(evaluateTrack(track, 1)!.value).toEqual([1, 2, 0]);
    expect(evaluateTrack(track, 2)!.value).toEqual([2, 0, 0]);
    // 中点位于两端值之间（平滑不越界穿越）
    const mid = evaluateTrack(track, 0.5)!.value as number[];
    expect(mid[0]).toBeGreaterThan(0);
    expect(mid[0]).toBeLessThan(1);
  });

  it('标量通道（focalLength）：number 值线性插值', () => {
    const track = createTrack('sample-camera', 'focalLength', '变焦', [
      { time: 0, value: 50 },
      { time: 4, value: 30 },
    ]);
    expect(evaluateTrack(track, 2)!.value).toBe(40);
  });

  it('禁用轨道/空轨道/乱序轨道：求值为 null', () => {
    const disabled = { ...linearPositionTrack(), disabled: true };
    expect(evaluateTrack(disabled, 1)).toBeNull();
    expect(evaluateTrack(createTrack('sample-camera', 'position'), 1)).toBeNull();
    const unsorted = createTrack('sample-camera', 'position', 'x', [
      { time: 2, value: [0, 0, 0] },
      { time: 1, value: [1, 1, 1] },
    ]);
    expect(evaluateTrack(unsorted, 1)).toBeNull();
  });

  it('单关键帧轨道：任意时刻取该帧值', () => {
    const track = createTrack('sample-camera', 'position', '单帧', [{ time: 3, value: [9, 9, 9] }]);
    expect(evaluateTrack(track, 0)!.value).toEqual([9, 9, 9]);
    expect(evaluateTrack(track, 10)!.value).toEqual([9, 9, 9]);
  });
});

describe('getTrackDuration / getProjectDuration / getShotDuration（有效时长）', () => {
  it('轨道有效时长 = 末关键帧时刻；空轨道为 0', () => {
    expect(getTrackDuration(linearPositionTrack())).toBe(4);
    expect(getTrackDuration(createTrack('sample-camera', 'position'))).toBe(0);
  });

  it('项目有效时长取启用轨道末帧与分镜区段终点最大值；禁用轨道不计', () => {
    const project: Project = {
      ...createSampleProject(),
      tracks: [
        { ...linearPositionTrack(), id: 't1' },
        { ...linearPositionTrack(), id: 't-disabled', disabled: true, keyframes: [{ time: 100, value: [0, 0, 0] }] },
      ],
      shots: [{ id: 's1', name: 'S', cameraObjectId: null, startTime: 0, endTime: 6 }],
    };
    expect(getProjectDuration(project)).toBe(6);
  });

  it('空项目（无轨道无分镜）有效时长为 0', () => {
    expect(getProjectDuration({ ...createSampleProject(), tracks: [], shots: [] })).toBe(0);
  });

  it('分镜有效时长 = endTime - startTime，负差收敛为 0', () => {
    expect(getShotDuration({ startTime: 1, endTime: 3 })).toBe(2);
    expect(getShotDuration({ startTime: 5, endTime: 2 })).toBe(0);
  });
});

describe('simplifySamples：采样简化（RDP 抽稀）', () => {
  /** 直线路径上的点：全部可剔除（偏差 0） */
  function straightLineSamples(): TrackSample[] {
    const samples: TrackSample[] = [];
    for (let i = 0; i <= 60; i += 1) {
      samples.push({ time: i / 60, value: [i / 60, 0, 0] });
    }
    return samples;
  }

  it('共线样本全量抽稀：仅保留首尾', () => {
    const simplified = simplifySamples(straightLineSamples());
    expect(simplified).toHaveLength(2);
    expect(simplified[0]!.time).toBe(0);
    expect(simplified[1]!.time).toBe(1);
  });

  it('超过容差的离群点保留（折线凸点，两侧共线）', () => {
    const samples: TrackSample[] = [
      { time: 0, value: [0, 0, 0] },
      { time: 0.25, value: [0.25, 0.15, 0] }, // 与凸点前段共线
      { time: 0.5, value: [0.5, 0.3, 0] }, // 凸点：偏离两端连线 0.3 > 0.01
      { time: 0.75, value: [0.75, 0.15, 0] }, // 与凸点后段共线
      { time: 1, value: [1, 0, 0] },
    ];
    const simplified = simplifySamples(samples);
    expect(simplified).toHaveLength(3);
    expect(simplified.map((s) => s.time)).toEqual([0, 0.5, 1]);
  });

  it('容差内抖动剔除：epsilon 内偏差不保留', () => {
    const samples = straightLineSamples();
    samples[30] = { time: 0.5, value: [0.5, 0.005, 0] }; // 0.005 < 0.01
    expect(simplifySamples(samples)).toHaveLength(2);
  });

  it('标量通道按 scalarEpsilon 判定', () => {
    const samples: TrackSample[] = [
      { time: 0, value: 50 },
      { time: 1, value: 50.02 },
      { time: 2, value: 50 },
    ];
    expect(simplifySamples(samples)).toHaveLength(2); // 0.02 < 0.1
    expect(simplifySamples(samples, { scalarEpsilon: 0.01 })).toHaveLength(3); // 0.02 > 0.01
  });

  it('少于 3 个样本原样返回；乱序输入防御性原样返回', () => {
    const two = straightLineSamples().slice(0, 2);
    expect(simplifySamples(two)).toHaveLength(2);
    const unsorted: TrackSample[] = [
      { time: 2, value: [0, 0, 0] },
      { time: 1, value: [1, 1, 1] },
      { time: 0, value: [2, 2, 2] },
    ];
    expect(simplifySamples(unsorted)).toHaveLength(3);
  });
});
