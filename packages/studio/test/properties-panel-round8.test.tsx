import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { createSampleProject, SceneEditor } from '@lumora/core';
import type { SceneEditor as SceneEditorType } from '@lumora/core';
import { PropertiesPanel } from '../src/components/editor/PropertiesPanel';
import { ToastHost } from '../src/components/editor/toasts';
import { useSceneEditor } from '../src/hooks/use-scene-editor';

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
 * R8-12 UI 输入层边界测试（TML-57 第八轮复审，修复前必须失败）：
 * 属性面板摄像机输入（inspector-fov/inspector-near/inspector-far）提交破坏投影值
 * （fov≥180、near≤0、far≤near）时，核心 schema 校验必须拒绝 ——
 * 项目数据不变、出现错误提示，破坏值不得进入状态。
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

async function commitField(testId: string, value: string) {
  const field = await waitFor(() => screen.getByTestId(testId));
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

describe('R8-12 摄像机输入边界（属性面板 UI 层）', () => {
  it('FOV 输入 200：拒绝并提示，项目数据不变', async () => {
    const editor = makeEditor();
    render(<InspectorHarness editor={editor} />);
    await waitFor(() => screen.getByTestId('inspector-fov'));

    await commitField('inspector-fov', '200');

    // RED：旧实现只查有限数，fov=200 直接入库（project.fov 变为 200，无提示）
    expect(cameraOf(editor).fov).toBeLessThan(180);
    expect(screen.getByTestId('lumora-toasts')).toHaveTextContent('属性值非法');
    expect(editor.getHistoryState().canUndo).toBe(false);
  });

  it('近平面输入 0 与远平面 ≤ 近平面：拒绝并提示，数据不变', async () => {
    const editor = makeEditor();
    render(<InspectorHarness editor={editor} />);
    await waitFor(() => screen.getByTestId('inspector-near'));
    const near = cameraOf(editor).near;

    // RED：旧实现只查有限数，near=0 直接入库且无提示
    await commitField('inspector-near', '0');
    expect(cameraOf(editor).near).toBe(near);
    expect(screen.getByTestId('lumora-toasts')).toHaveTextContent('属性值非法');
    expect(editor.getHistoryState().canUndo).toBe(false);

    // 中间状态：合法 near 正常提交（可撤销）；随后 far ≤ near 拒绝，far 保持旧值
    await commitField('inspector-near', '50');
    expect(cameraOf(editor).near).toBe(50);
    const farBefore = cameraOf(editor).far;
    await commitField('inspector-far', '10');
    expect(cameraOf(editor).far).toBe(farBefore);
    expect(cameraOf(editor).far).toBeGreaterThan(cameraOf(editor).near);
    expect(screen.getByTestId('lumora-toasts')).toHaveTextContent('属性值非法');
  });

  it('合法输入正常提交：FOV 60 入库并生成历史', async () => {
    const editor = makeEditor();
    render(<InspectorHarness editor={editor} />);
    await waitFor(() => screen.getByTestId('inspector-fov'));

    await commitField('inspector-fov', '60');

    expect(cameraOf(editor).fov).toBe(60);
    expect(editor.getHistoryState().canUndo).toBe(true);
  });
});
