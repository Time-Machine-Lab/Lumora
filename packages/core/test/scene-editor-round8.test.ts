import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { CameraData, Project, SceneObjectData } from '../src/scene/types';

/**
 * R8-12 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 摄像机/画幅 schema 接受破坏投影值（validate.ts 摄像机块 + settings.aspect）：
 * - camera.fov 可为 ≥180/≤0、near 可为负、far 可 ≤ near、焦距/传感器可为非正、
 *   camera.aspect 可为 0/负 —— 这些值会让 three.js 投影矩阵失效（fov=180 时
 *   tan(π/2) 发散、near≤0 时近平面穿模、aspect=0 时除零），当前只校验有限数；
 * - settings.aspect 只校验有限对，0/负画幅同样破坏画幅计算（EditorViewport 用
 *   宽高比做 letterbox/fitRect 除零）。
 * 修复：0 < fov < 180、焦距/传感器/near 为正、far > near、画幅（settings.aspect
 * 与 camera.aspect）为正。两层边界：openProject（validateProjectSchema 原子拒绝）
 * 与 updateObjectProps（UI 提交路径的同一 schema 拒绝）。
 */

function withCamera(project: Project, mutate: (camera: CameraData) => void): Project {
  return {
    ...project,
    objects: project.objects.map((o) =>
      o.type === 'camera' && o.camera ? { ...o, camera: { ...o.camera, ...makePatch(o, mutate) } } : o,
    ),
  };
}

/** 先取快照再套 mutate：直接展开 o.camera 再调用 mutate 即可，无需辅助 */
function makePatch(o: SceneObjectData, mutate: (camera: CameraData) => void): CameraData {
  const snapshot: CameraData = structuredClone(o.camera!);
  mutate(snapshot);
  return snapshot;
}

describe('R8-12 摄像机/画幅投影值边界（openProject 层）', () => {
  it('合法摄像机投影值：示例项目正常打开（对照组）', () => {
    const editor = new SceneEditor();
    expect(() => editor.openProject(createSampleProject())).not.toThrow();
    expect(editor.getProject()).not.toBeNull();
  });

  it('fov ≥ 180 / ≤ 0：原子拒绝，既有项目不变', () => {
    for (const fov of [180, 200, 0, -30]) {
      const editor = new SceneEditor();
      editor.openProject(createSampleProject());
      const bad = withCamera(createSampleProject(), (c) => {
        c.fov = fov;
      });
      expect(() => editor.openProject(bad), `fov=${fov}`).toThrow(/fov 非法/);
      expect(editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!.fov).toBeGreaterThan(0);
    }
  });

  it('焦距/传感器/near 非正：拒绝', () => {
    const cases: [keyof CameraData, number][] = [
      ['focalLength', 0],
      ['focalLength', -5],
      ['sensorWidth', 0],
      ['sensorHeight', -24],
      ['near', 0],
      ['near', -0.1],
    ];
    for (const [field, value] of cases) {
      const editor = new SceneEditor();
      const bad = withCamera(createSampleProject(), (c) => {
        (c as unknown as Record<string, unknown>)[field] = value;
      });
      expect(() => editor.openProject(bad), `${field}=${value}`).toThrow(new RegExp(`${field} 非法`));
    }
  });

  it('far ≤ near：拒绝；far > near 的合法组合：接受', () => {
    for (const [near, far] of [
      [0.1, 0.1],
      [0.1, 0.05],
      [5, 1],
    ]) {
      const editor = new SceneEditor();
      const bad = withCamera(createSampleProject(), (c) => {
        c.near = near;
        c.far = far;
      });
      expect(() => editor.openProject(bad), `near=${near} far=${far}`).toThrow(/far 非法/);
    }
    const editor = new SceneEditor();
    const good = withCamera(createSampleProject(), (c) => {
      c.near = 10;
      c.far = 100;
    });
    expect(() => editor.openProject(good)).not.toThrow();
  });

  it('camera.aspect 非正：拒绝', () => {
    for (const aspect of [0, -1.5]) {
      const editor = new SceneEditor();
      const bad = withCamera(createSampleProject(), (c) => {
        c.aspect = aspect;
      });
      expect(() => editor.openProject(bad), `aspect=${aspect}`).toThrow(/aspect 非法/);
    }
  });

  it('settings.aspect 含非正成员：拒绝', () => {
    for (const [w, h] of [
      [16, 0],
      [0, 9],
      [-16, 9],
    ]) {
      const editor = new SceneEditor();
      const bad = {
        ...createSampleProject(),
        settings: { ...createSampleProject().settings, aspect: [w, h] as [number, number] },
      };
      expect(() => editor.openProject(bad), `aspect=${w}:${h}`).toThrow(/aspect 非法/);
    }
  });
});

describe('R8-12 摄像机投影值边界（updateObjectProps 层，UI 提交同一路径）', () => {
  it('UI 提交路径：fov 越界 / near 非正 / far ≤ near 一律拒绝且不留历史', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    const attempt = (mutate: (camera: CameraData) => void) =>
      editor.updateObjectProps(
        'sample-camera',
        (o) => ({ ...o, camera: makePatch(o, mutate) }),
        '改摄像机参数',
      );

    const attempts = [
      attempt((c) => {
        c.fov = 200;
      }),
      attempt((c) => {
        c.near = 0;
      }),
      attempt((c) => {
        c.far = 0.05;
      }),
      attempt((c) => {
        c.focalLength = -1;
      }),
      attempt((c) => {
        c.aspect = 0;
      }),
    ];
    for (const result of attempts) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain('属性值非法');
    }
    const camera = editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!;
    expect(camera.fov).toBeGreaterThan(0);
    expect(camera.fov).toBeLessThan(180);
    expect(camera.near).toBeGreaterThan(0);
    expect(camera.far).toBeGreaterThan(camera.near);
    expect(editor.getHistoryState().canUndo).toBe(false);
  });

  it('UI 提交路径：合法值正常提交并生成历史', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const result = editor.updateObjectProps(
      'sample-camera',
      (o) => {
        const c = structuredClone(o.camera!);
        c.fov = 60;
        c.near = 0.5;
        c.far = 500;
        return { ...o, camera: c };
      },
      '改摄像机参数',
    );
    expect(result.ok).toBe(true);
    const camera = editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!;
    expect(camera.fov).toBe(60);
    expect(camera.near).toBe(0.5);
    expect(camera.far).toBe(500);
    expect(editor.getHistoryState().canUndo).toBe(true);
  });
});
