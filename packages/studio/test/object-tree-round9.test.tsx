import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createSampleProject, SceneEditor } from '@lumora/core';
import type { SceneEditor as SceneEditorType } from '@lumora/core';
import { ObjectTree } from '../src/components/editor/ObjectTree';
import type { CacheLease, ContentCache } from '../src/components/editor/content-cache';
import { ToastHost } from '../src/components/editor/toasts';
import { useSceneEditor } from '../src/hooks/use-scene-editor';

afterEach(cleanup);

/**
 * R9-M3 #6 对抗测试（TML-57 第九轮 M3，修复前必须失败）：
 * 移动菜单没有 APG 关联：触发器按钮无 aria-haspopup/aria-expanded/aria-controls，
 * 菜单 div 无稳定 id、无 aria-labelledby —— 屏幕阅读器无法把触发器与菜单关联，
 * 也无法感知展开状态。
 * 修复：每行稳定 id tree-move-trigger-${object.id} / tree-move-menu-${object.id}，
 * 触发器绑定 aria-haspopup="menu" + aria-expanded + aria-controls，菜单以
 * aria-labelledby 关联触发器。
 */

function leaseWith(content: Promise<never>): CacheLease {
  return { hash: 'noop', generation: 0, content, isReleased: false, release: vi.fn() };
}

function noopCache(): ContentCache {
  return {
    acquire: vi.fn(() => leaseWith(Promise.resolve() as never)),
    seed: vi.fn(() => leaseWith(Promise.resolve() as never)),
    retain: vi.fn(() => null),
    has: vi.fn(() => false),
    isReady: vi.fn(() => false),
    getInfo: vi.fn(() => null),
    discard: vi.fn(),
    sweep: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ContentCache;
}

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

function TreeHarness({ editor, cache }: { editor: SceneEditorType; cache: ContentCache }) {
  const state = useSceneEditor(editor);
  return (
    <>
      <ObjectTree editor={editor} project={state.project} selection={state.selection} cache={cache} />
      <ToastHost />
    </>
  );
}

function openMenu(objectId: string) {
  const trigger = screen.getByTestId(`tree-move-${objectId}`);
  fireEvent.click(trigger);
  return trigger;
}

describe('R9-M3 #6 移动菜单 APG 关联', () => {
  it('R9-6-T1 触发器：aria-haspopup=menu、展开态 aria-expanded、aria-controls 指向菜单 id', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    const trigger = openMenu('sample-cube');

    // RED：现 HEAD 触发器无任何 aria 属性（getAttribute 均 null）
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // 一致性断言（R10 迁移）：aria-controls 即打开菜单的实际 id，且仍按对象区分
    const menu = screen.getByTestId('tree-move-menu');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.getAttribute('id'));
    expect(trigger.getAttribute('aria-controls')!.endsWith('-sample-cube')).toBe(true);
  });

  it('R9-6-T2 菜单：稳定 id 与 aria-labelledby 关联触发器', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    openMenu('sample-cube');

    const menu = screen.getByTestId('tree-move-menu');
    // RED：现 HEAD 菜单无 id、无 aria-labelledby（均为 null）；
    // 一致性断言（R10 迁移）：id 带前缀与对象后缀，labelledby 指向触发器实际 id
    expect(menu.getAttribute('id')).toMatch(/^tree-move-menu-/);
    expect(menu.getAttribute('id')!.endsWith('-sample-cube')).toBe(true);
    const trigger = screen.getByTestId('tree-move-sample-cube');
    expect(menu.getAttribute('aria-labelledby')).toBe(trigger.getAttribute('id'));
    // 双向关联成立：触发器 aria-controls 指向的 id 就是菜单实际 id
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(menu);
  });

  it('R9-6-T3 关闭后：触发器 aria-expanded 回到 false，菜单移除', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    const trigger = openMenu('sample-cube');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(within(screen.getByTestId('tree-move-menu')).getByTestId('tree-move-to-root'));

    expect(screen.queryByTestId('tree-move-menu')).not.toBeInTheDocument();
    // 层级变更使触发行重建（ObjectTree commitMove flushSync），须重新查询：
    // 新行节点的 aria-expanded 已回到 'false'（RED：现 HEAD 无此属性，null ≠ 'false'）
    const rebuiltTrigger = screen.getByTestId('tree-move-sample-cube');
    expect(rebuiltTrigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('R9-6-T4 每行触发器指向自己对象的菜单 id（多行互不串扰）', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);

    const cubeTrigger = screen.getByTestId('tree-move-sample-cube');
    const coneTrigger = screen.getByTestId('tree-move-sample-cone');
    // 一致性断言（R10 迁移）：每行 aria-controls 不同且按各自对象区分
    const cubeControls = cubeTrigger.getAttribute('aria-controls')!;
    const coneControls = coneTrigger.getAttribute('aria-controls')!;
    expect(cubeControls).not.toBe(coneControls);
    expect(cubeControls.endsWith('-sample-cube')).toBe(true);
    expect(coneControls.endsWith('-sample-cone')).toBe(true);

    openMenu('sample-cone');
    const menu = screen.getByTestId('tree-move-menu');
    expect(menu.getAttribute('id')).toBe(coneControls);
    expect(menu.getAttribute('aria-labelledby')).toBe(coneTrigger.getAttribute('id'));
    expect(cubeTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(coneTrigger.getAttribute('aria-expanded')).toBe('true');
  });
});
