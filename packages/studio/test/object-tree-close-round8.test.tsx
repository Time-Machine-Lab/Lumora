import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createSampleProject, SceneEditor } from '@lumora/core';
import type { SceneEditor as SceneEditorType } from '@lumora/core';
import { ObjectTree } from '../src/components/editor/ObjectTree';
import type { CacheLease, ContentCache } from '../src/components/editor/content-cache';
import { ToastHost } from '../src/components/editor/toasts';
import { useSceneEditor } from '../src/hooks/use-scene-editor';

/**
 * R8-1 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 选中树行后关闭项目：ObjectTree 在 project===null 早退后，effect 不得再读取
 * 未初始化（TDZ）的 flatRows —— 旧实现抛 ReferenceError 使整个 Studio 卸载。
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

function TreeHarness({ editor, cache }: { editor: SceneEditorType; cache: ContentCache }) {
  const state = useSceneEditor(editor);
  return (
    <>
      <ObjectTree editor={editor} project={state.project} selection={state.selection} cache={cache} />
      <ToastHost />
    </>
  );
}

describe('R8-1 关闭项目安全', () => {
  it('R8-1-T1 选中树行后关闭项目：树卸载且不抛错，重新打开后恢复', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    fireEvent.click(screen.getByTestId('tree-row-sample-cube'));

    // RED：focusedId 保留在组件状态，project 置空后 effect 读 TDZ 中的
    // flatRows（`const flatRows` 在早退 return 之后才求值）→ ReferenceError
    act(() => {
      editor.reset();
    });
    expect(screen.queryByTestId('lumora-tree')).not.toBeInTheDocument();

    // 重新打开项目：树恢复渲染
    act(() => {
      editor.openProject(createSampleProject());
    });
    expect(screen.getByTestId('tree-row-sample-cube')).toBeInTheDocument();
  });
});
