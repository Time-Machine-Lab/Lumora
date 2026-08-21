// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { CameraData, Project, SceneObjectData } from '../src/scene/types';

/**
 * R9-M3 #5 对抗测试（TML-57 第九轮 M3，修复前必须失败）：
 * camera.aspect 校验是两条分离条件（类型 + <= 0），NaN/±Infinity 同时通过
 * （NaN <= 0 为 false、Infinity <= 0 为 false）→ openProject 与 updateObjectProps
 * 均接受非有限画幅，投影矩阵与画幅计算产出 NaN（R8-12 只堵了 0/负）。
 * 修复：aspect 非 null 必须 typeof number && Number.isFinite && > 0
 * （'camera.aspect 非法（需为正有限数）'）。三层边界：
 * T1 openProject（validateProjectSchema 原子拒绝）、T2 核心更新（updateObjectProps
 * 拒绝且不留历史）；UI 提交层见 properties-panel-round9.test.tsx。
 */

function withCamera(project: Project, mutate: (camera: CameraData) => void): Project {
  return {
    ...project,
    objects: project.objects.map((o) =>
      o.type === 'camera' && o.camera
        ? { ...o, camera: { ...o.camera, ...snapshotOf(o, mutate) } }
        : o,
    ),
  };
}

function snapshotOf(o: SceneObjectData, mutate: (camera: CameraData) => void): CameraData {
  const snapshot: CameraData = structuredClone(o.camera!);
  mutate(snapshot);
  return snapshot;
}

describe('R9-M3 #5 camera.aspect 有限正数（openProject 层）', () => {
  it.each([NaN, Infinity, -Infinity])('R9-5-T1 aspect=%s：openProject 原子拒绝', (aspect) => {
    const editor = new SceneEditor();
    const bad = withCamera(createSampleProject(), (c) => {
      c.aspect = aspect;
    });
    // RED：现 HEAD 两条分离条件放行 NaN/Infinity（NaN/∞ <= 0 均为 false）；
    // -Infinity 已被「非正」分支拒绝，属防护用例
    expect(() => editor.openProject(bad)).toThrow(/aspect 非法/);
  });

  it('R9-5-T2 aspect 合法值（正有限数与 null 跟随项目）：打开通过', () => {
    for (const aspect of [0.5, 1.5, 1e300, 0.0001]) {
      const editor = new SceneEditor();
      const good = withCamera(createSampleProject(), (c) => {
        c.aspect = aspect;
      });
      expect(() => editor.openProject(good), `aspect=${aspect}`).not.toThrow();
    }
    const nullAspect = withCamera(createSampleProject(), (c) => {
      c.aspect = null;
    });
    expect(() => new SceneEditor().openProject(nullAspect)).not.toThrow();
  });
});

describe('R9-M3 #5 camera.aspect 有限正数（核心更新层，UI 提交同一通道）', () => {
  it.each([NaN, Infinity, -Infinity])(
    'R9-5-T3 updateObjectProps 提交 aspect=%s：拒绝且不留历史、数据不变',
    (aspect) => {
      const editor = new SceneEditor();
      editor.openProject(createSampleProject());
      const before = structuredClone(
        editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!,
      );

      const result = editor.updateObjectProps(
        'sample-camera',
        (o) => ({ ...o, camera: { ...o.camera!, aspect } }),
        '改画幅',
      );

      // RED：现 HEAD 放行 NaN/Infinity 直接入库；-Infinity 已被「非正」分支拒绝（防护）
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('属性值非法');
      const camera = editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!;
      expect(camera.aspect).toBe(before.aspect);
      expect(editor.getHistoryState().canUndo).toBe(false);
    },
  );

  it('R9-5-T4 updateObjectProps 提交合法 aspect：正常入库并生成历史', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    const result = editor.updateObjectProps(
      'sample-camera',
      (o) => ({ ...o, camera: { ...o.camera!, aspect: 2.35 } }),
      '改画幅',
    );

    expect(result.ok).toBe(true);
    const camera = editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!;
    expect(camera.aspect).toBe(2.35);
    expect(editor.getHistoryState().canUndo).toBe(true);
  });
});
