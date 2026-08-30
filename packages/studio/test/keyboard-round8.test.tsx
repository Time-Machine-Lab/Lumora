import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import * as THREE from 'three';
import { createSampleProject } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';

/**
 * R8-9 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * - LumoraStudio.tsx:111-165 在 window 上无条件注册 keydown：多个 Studio
 *   实例共存（可嵌入场景）时，每个实例都执行全部快捷键——在一个实例内
 *   按 Delete/Backspace/Ctrl+K 会同时作用于其他实例；
 * - ObjectTree.tsx:151-155,566-600 「移动到」菜单无键盘语义：键盘 M 打开后
 *   焦点不进菜单、方向键不导航、Enter 不提交、Escape 不返回触发行。
 * 修复：快捷键按实例作用域（只响应本实例子树内的按键）；菜单按 APG menu
 * button 实现（打开聚焦首项、方向键/Home/End 轮转、Enter/Space 激活、
 * Escape 关闭并返回焦点）。
 */

const mockScene = vi.hoisted(() => ({ scene: null as unknown as THREE.Group }));

vi.mock('@react-three/fiber', async () => {
  const { Group, PerspectiveCamera } = await import('three');
  return {
    Canvas: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-canvas">{children}</div>,
    useThree: (selector?: (s: unknown) => unknown) => {
      if (!mockScene.scene) mockScene.scene = new Group();
      const state = {
        scene: mockScene.scene,
        set: () => undefined,
        camera: new PerspectiveCamera(),
        gl: { setViewport: () => undefined, setScissor: () => undefined, setScissorTest: () => undefined },
        size: { width: 800, height: 600 },
        viewport: { dpr: 1 },
      };
      return selector ? selector(state) : state;
    },
    useFrame: () => undefined,
  };
});

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

/** 每个测试独立的场景组：模拟 r3f 场景按用例隔离，避免跨用例残留旧树 */
beforeEach(() => {
  mockScene.scene = null as unknown as THREE.Group;
});

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
}

/** 挂载一个打开示例项目的 Studio 实例，返回其句柄与根节点 */
async function mountStudio(): Promise<{
  editor: import('@lumora/core').SceneEditor;
  root: HTMLElement;
}> {
  const handle = createRef<LumoraStudioHandle>();
  render(<LumoraStudio ref={handle} initialProject={createSampleProject()} />);
  await waitFor(() => expect(handle.current?.runtime.editor.getProject()).not.toBeNull());
  const roots = screen.getAllByTestId('lumora-studio');
  return { editor: handle.current!.runtime.editor, root: roots[roots.length - 1]! };
}

describe('R8-9 多实例快捷键隔离 + 移动菜单键盘语义', () => {
  it('R8-9-T1 多实例隔离：焦点实例内的 Delete 只删除该实例的选择', async () => {
    const a = await mountStudio();
    const b = await mountStudio();
    act(() => {
      a.editor.setSelection(['sample-cube']);
      b.editor.setSelection(['sample-sphere']);
    });

    act(() => {
      a.root.dispatchEvent(key('Delete'));
    });

    // RED：旧实现两个实例的 window 监听都触发，B 的选择也被删除
    expect(a.editor.getProject()!.objects.some((o) => o.id === 'sample-cube')).toBe(false);
    expect(b.editor.getProject()!.objects.some((o) => o.id === 'sample-sphere')).toBe(true);
    expect(b.editor.getSelection()).toEqual(['sample-sphere']);
  });

  it('R8-9-T2 焦点在实例外：Delete 不触发任何实例', async () => {
    const a = await mountStudio();
    const b = await mountStudio();
    act(() => {
      a.editor.setSelection(['sample-cube']);
      b.editor.setSelection(['sample-sphere']);
    });

    act(() => {
      document.body.dispatchEvent(key('Delete'));
    });

    // RED：旧实现无作用域判断，body 上的按键同样删除两个实例的选择
    expect(a.editor.getSelection()).toEqual(['sample-cube']);
    expect(b.editor.getSelection()).toEqual(['sample-sphere']);
  });

  it('R8-9-T3 命令面板快捷键按实例作用域：Ctrl+K 只切换焦点所在实例', async () => {
    const a = await mountStudio();
    const b = await mountStudio();

    act(() => {
      a.root.dispatchEvent(key('k', { ctrlKey: true }));
    });
    // RED：旧实现 Ctrl+K 是「全局快捷键」，两个实例的面板同时打开
    expect(within(a.root).queryByTestId('command-palette')).not.toBeNull();
    expect(within(b.root).queryByTestId('command-palette')).toBeNull();

    act(() => {
      b.root.dispatchEvent(key('k', { ctrlKey: true }));
    });
    expect(within(b.root).queryByTestId('command-palette')).not.toBeNull();
  });

  it('R8-9-T4 移动菜单键盘：M 打开聚焦首项，方向键导航，Enter 提交', async () => {
    const { editor, root } = await mountStudio();
    const row = within(root).getByTestId('tree-row-sample-cube');
    row.focus();
    expect(document.activeElement).toBe(row);

    act(() => {
      row.dispatchEvent(key('m'));
    });
    const menu = within(root).getByTestId('tree-move-menu');
    // RED：旧实现打开后焦点不进入菜单（键盘用户只能看到菜单，无法操作）
    expect(document.activeElement).toBe(within(menu).getByTestId('tree-move-to-root'));

    act(() => {
      menu.dispatchEvent(key('ArrowDown'));
    });
    expect(document.activeElement).toBe(within(menu).getByTestId('tree-move-to-sample-group'));

    // 候选 = 可见行 − 自身 − 后代（含 group 内子行）：sphere/cone 也在列
    act(() => {
      menu.dispatchEvent(key('ArrowDown'));
    });
    expect(document.activeElement).toBe(within(menu).getByTestId('tree-move-to-sample-sphere'));

    act(() => {
      menu.dispatchEvent(key('ArrowDown'));
    });
    expect(document.activeElement).toBe(within(menu).getByTestId('tree-move-to-sample-cone'));

    act(() => {
      menu.dispatchEvent(key('ArrowDown'));
    });
    expect(document.activeElement).toBe(within(menu).getByTestId('tree-move-to-sample-ground'));

    act(() => {
      menu.dispatchEvent(key('Enter'));
    });
    // RED：旧实现 Enter 无处理，菜单不关闭、父级不变
    expect(within(root).queryByTestId('tree-move-menu')).toBeNull();
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.parentId).toBe('sample-ground');
    // 层级变更使触发行重建：焦点应落在重建后的行（旧行已卸载，需重新查询）
    expect(document.activeElement).toBe(within(root).getByTestId('tree-row-sample-cube'));
  });

  it('R8-9-T6 单实例嵌入：按键落在实例外（body）仍生效（点击画布后焦点在 body）', async () => {
    const a = await mountStudio();
    act(() => {
      document.body.dispatchEvent(key('k', { ctrlKey: true }));
    });
    // RED：严格包含校验下 body 上的按键被忽略，单实例嵌入（最常见形态）的
    // Ctrl+K/Delete 等快捷键全部失效
    expect(within(a.root).queryByTestId('command-palette')).not.toBeNull();
  });

  it('单实例嵌入不接管聚焦的宿主控件，同时保留 body 兜底', async () => {
    const a = await mountStudio();
    const hostLog = document.createElement('aside');
    hostLog.tabIndex = 0;
    document.body.appendChild(hostLog);
    const play = within(a.root).getByTestId('timeline-play');
    const playBefore = play.textContent;

    hostLog.focus();
    act(() => {
      hostLog.dispatchEvent(key(' '));
    });

    expect(play).toHaveTextContent(playBefore ?? '');
    expect(within(a.root).queryByTestId('command-palette')).toBeNull();

    act(() => {
      document.body.dispatchEvent(key('k', { ctrlKey: true }));
    });
    expect(within(a.root).queryByTestId('command-palette')).not.toBeNull();
    hostLog.remove();
  });

  it('R8-9-T5 移动菜单 Escape：关闭并返回焦点到触发行', async () => {
    const { root } = await mountStudio();
    const row = within(root).getByTestId('tree-row-sample-cube');
    row.focus();

    act(() => {
      row.dispatchEvent(key('m'));
    });
    const menu = within(root).getByTestId('tree-move-menu');
    expect(document.activeElement).toBe(within(menu).getByTestId('tree-move-to-root'));

    act(() => {
      menu.dispatchEvent(key('Escape'));
    });
    expect(within(root).queryByTestId('tree-move-menu')).toBeNull();
    // RED：旧实现菜单关闭后焦点不返回触发行
    expect(document.activeElement).toBe(row);
  });
});
