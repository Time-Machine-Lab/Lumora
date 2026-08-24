import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createBlankProject } from '../src/project/create-project';
import { createSampleProject } from '../src/scene/sample-project';
import { validateProjectSchema } from '../src/scene/validate';
import type { Project, TrackData } from '../src/scene/types';

/** 合法轨道夹具：引用示例项目的立方体 */
function trackFixture(overrides: Partial<TrackData> = {}): TrackData {
  return {
    id: 'track-1',
    name: '立方体位移动画',
    objectId: 'sample-cube',
    targetPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0.5, 0] },
      { time: 2, value: [1, 0.5, 0], interpolation: 'step' },
    ],
    ...overrides,
  };
}

/** 携带一条合法轨道（引用 sample-cube）的 v3 项目 */
function projectWithTrack(track: TrackData = trackFixture()): Project {
  const sample = createSampleProject();
  return { ...sample, tracks: [track] };
}

describe('轨道 schema 校验（TML-88）', () => {
  it('合法轨道通过完整校验（targetPath/keyframes/引用对象）', () => {
    expect(validateProjectSchema(projectWithTrack())).toBeNull();
  });

  it('tracks 缺失 → 明确错误（v3 必填字段）', () => {
    const project = createSampleProject();
    const { tracks: _tracks, ...without } = project;
    expect(validateProjectSchema(without)).toContain('tracks');
  });

  it('轨道 id 缺失/重复 → 拒绝', () => {
    expect(validateProjectSchema(projectWithTrack(trackFixture({ id: '' })))).toContain('轨道 id');
    const project = projectWithTrack();
    expect(validateProjectSchema({ ...project, tracks: [trackFixture(), trackFixture()] })).toContain(
      '轨道 id',
    );
  });

  it('targetPath 不属于通道全集 → 拒绝', () => {
    const bad = trackFixture({ targetPath: 'visible' as never });
    expect(validateProjectSchema(projectWithTrack(bad))).toContain('targetPath');
  });

  it('objectId 非字符串 → 拒绝', () => {
    const bad = trackFixture({ objectId: '' });
    expect(validateProjectSchema(projectWithTrack(bad))).toContain('objectId');
  });

  it('轨道引用不存在的对象 → 拒绝（交叉引用）', () => {
    const bad = trackFixture({ objectId: 'ghost-object' });
    expect(validateProjectSchema(projectWithTrack(bad))).toContain('引用不存在的对象');
  });

  it('keyframes 缺失/非数组 → 拒绝', () => {
    const bad = trackFixture({ keyframes: undefined as never });
    expect(validateProjectSchema(projectWithTrack(bad))).toContain('keyframes');
  });

  it('关键帧 time 非负有限数约束：NaN/Infinity/负数 → 拒绝', () => {
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      const bad = trackFixture({ keyframes: [{ time, value: [0, 0, 0] }] });
      expect(validateProjectSchema(projectWithTrack(bad))).toContain('time');
    }
  });

  it('关键帧 time 未按升序排列或重复 → 拒绝（插值语义需严格递增）', () => {
    const unsorted = trackFixture({
      keyframes: [
        { time: 2, value: [1, 0, 0] },
        { time: 0, value: [0, 0, 0] },
      ],
    });
    expect(validateProjectSchema(projectWithTrack(unsorted))).toContain('未按升序');
    const duplicate = trackFixture({
      keyframes: [
        { time: 0, value: [0, 0, 0] },
        { time: 0, value: [1, 0, 0] },
      ],
    });
    expect(validateProjectSchema(projectWithTrack(duplicate))).toContain('未按升序');
  });

  it('关键帧 value 非有限 Vec3 → 拒绝', () => {
    const bad = trackFixture({ keyframes: [{ time: 0, value: [Number.NaN, 0, 0] }] });
    expect(validateProjectSchema(projectWithTrack(bad))).toContain('value');
  });

  it('interpolation 不属于线性/阶跃全集 → 拒绝；缺省合法', () => {
    const bad = trackFixture({ keyframes: [{ time: 0, value: [0, 0, 0], interpolation: 'ease' as never }] });
    expect(validateProjectSchema(projectWithTrack(bad))).toContain('interpolation');
  });
});

describe('轨道与编辑器/工程包集成（TML-88）', () => {
  it('SceneEditor 打开含轨道的 v3 项目：轨道原样保留（deepFreeze 后读回一致）', () => {
    const editor = new SceneEditor();
    editor.openProject(projectWithTrack());
    expect(editor.getProject()!.tracks).toEqual(projectWithTrack().tracks);
  });

  it('空白项目默认空轨道（可迁移到 v3 的旧数据在创建端补默认值）', () => {
    const project = createBlankProject('lumora://project/blank', '空白');
    expect(project.schemaVersion).toBe(3);
    expect(project.tracks).toEqual([]);
    expect(validateProjectSchema(project)).toBeNull();
  });

  it('示例项目携带引用模型的轨道且通过完整校验（e2e AC1 数据源）', () => {
    const sample = createSampleProject();
    expect(sample.tracks.length).toBeGreaterThan(0);
    expect(validateProjectSchema(sample)).toBeNull();
    for (const track of sample.tracks) {
      expect(sample.objects.some((o) => o.id === track.objectId)).toBe(true);
    }
  });
});
