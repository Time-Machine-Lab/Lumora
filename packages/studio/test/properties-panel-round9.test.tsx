import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { createSampleProject, SceneEditor } from '@lumora/core';
import type { SceneEditor as SceneEditorType } from '@lumora/core';
import { PropertiesPanel } from '../src/components/editor/PropertiesPanel';
import { ToastHost } from '../src/components/editor/toasts';
import { useSceneEditor } from '../src/hooks/use-scene-editor';

afterEach(cleanup);

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-canvas">{children}</div>,
  useThree: () => ({
    scene: new THREE.Group(),
    set: () => undefined,
    camera: new THREE.PerspectiveCamera(),
    gl: { setViewport: () => undefined, setScissor: () => undefined, setScissorTest: () => undefined },
    size: { width: 800, height: 600 },
    viewport: { dpr: 1 },
  }),
  useFrame: () => undefined,
}));

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

/**
 * R9-M3 #5 UI 提交层对抗测试（TML-57 第九轮 M3，修复前必须失败）：
 * camera.aspect 非有限值（NaN/±Infinity）在 openProject 与核心更新两层已被
 * R8-12 之外的新探针覆盖（scene-editor-round9-3.test.ts）；本文件验证 UI 提交通道：
 * - T1 面板提交通道（commitProps → editor.updateObjectProps 同一路径）提交
 *   aspect=NaN/Infinity → 核心校验拒绝 → toast「属性值非法」、数据不变、无历史；
 * - T2 数值控件自拦截：inspector-fov 输入 'NaN'/'Infinity' → NumberField 拒收、
 *   toast「数值非法」、数据不变（控件层防线，NaN/±Infinity 不触达核心）。
 */

function InspectorHarness({ editor }: { editor: SceneEditorType }) {
  const state = useSceneEditor(editor);
  return (
    <>
      <PropertiesPanel editor={editor} project={state.project} selection={state.selection} />
      <ToastHost />
    </>
  );
}

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  editor.setSelection(['sample-camera']);
  return editor;
}

function cameraOf(editor: SceneEditorType) {
  return editor.getProject()!.objects.find((o) => o.id === 'sample-camera')!.camera!;
}

describe('R9-M3 #5 camera.aspect 非有限值（UI 提交层）', () => {
  it.each([NaN, Infinity, -Infinity])(
    'R9-5-T3 面板提交通道提交 aspect=%s：核心拒绝，数据不变、无历史',
    async (aspect) => {
      const editor = makeEditor();
      render(<InspectorHarness editor={editor} />);
      await waitFor(() => screen.getByTestId('inspector-fov'));
      const before = cameraOf(editor).aspect;

      // 面板提交通道：commitProps 对摄像机字段的更新最终走 updateObjectProps，
      // 这里以同一通道直接提交（aspect 目前仅只读展示，无独立输入控件）
      const result = editor.updateObjectProps(
        'sample-camera',
        (o) => ({ ...o, camera: { ...o.camera!, aspect } }),
        '改画幅',
      );

      // RED：现 HEAD 两条分离条件放行 NaN/Infinity（NaN/∞ <= 0 均为 false）→
      // 直接入库；-Infinity 已被「非正」分支拒绝，属防护用例
      expect(result.ok).toBe(false);
      expect(cameraOf(editor).aspect).toBe(before);
      expect(editor.getHistoryState().canUndo).toBe(false);
    },
  );

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'R9-5-T4 数值控件拒收输入 %s（控件层防线，不触达核心）',
    async (raw) => {
      const editor = makeEditor();
      render(<InspectorHarness editor={editor} />);
      await waitFor(() => screen.getByTestId('inspector-fov'));
      const fovBefore = cameraOf(editor).fov;

      const field = screen.getByTestId('inspector-fov');
      fireEvent.change(field, { target: { value: raw } });
      fireEvent.blur(field);
      expect(cameraOf(editor).fov).toBe(fovBefore);
      expect(screen.getByTestId('lumora-toasts')).toHaveTextContent('数值非法');
      expect(editor.getHistoryState().canUndo).toBe(false);
    },
  );
});
