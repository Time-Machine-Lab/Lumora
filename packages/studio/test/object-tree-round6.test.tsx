import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createGroupObject, createSampleProject, SceneEditor } from '@lumora/core';
import type { Project, SceneObjectData, SceneEditor as SceneEditorType } from '@lumora/core';
import { ObjectTree } from '../src/components/editor/ObjectTree';
import type { CacheLease, ContentCache } from '../src/components/editor/content-cache';
import { ToastHost } from '../src/components/editor/toasts';
import { useSceneEditor } from '../src/hooks/use-scene-editor';

/**
 * R6-D 对抗测试（TML-57 第六轮复审，修复前必须失败）：
 * - 行内重命名期间 treeitem 移出 Tab 顺序（APG：输入框持有焦点期间
 *   Tab 应离开树，而不是跳到下一个 treeitem）；
 * - 「移动到」：行按 M 或行内按钮打开目标菜单（键盘与触屏等价），
 *   候选排除自身与后代，选择即挂载；
 * - 深层树真实渲染与键盘遍历。
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

function findObject(editor: SceneEditorType, id: string) {
  return editor.getProject()?.objects.find((o) => o.id === id);
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

function deepProject(): Project {
  const objects: SceneObjectData[] = [];
  // 链深 8，每级 5 个兄弟叶：共 8×6 = 48 节点
  for (let i = 0; i < 8; i += 1) {
    objects.push({ ...createGroupObject(), id: `d${i}`, name: `D${i}`, parentId: i === 0 ? null : `d${i - 1}` });
    for (let j = 0; j < 5; j += 1) {
      objects.push({ ...createGroupObject(), id: `d${i}-l${j}`, name: `L${i}-${j}`, parentId: `d${i}` });
    }
  }
  return {
    uri: 'lumora://deep',
    name: '深树',
    schemaVersion: 4,
    createdAt: '2026-08-20T00:00:00.000Z',
    revision: 0,
    settings: { fps: 24, aspect: [16, 9] },
    activeSceneId: 's1',
    scenes: [{ id: 's1', name: '主场景', rootObjectIds: ['d0'], activeCameraId: null }],
    objects,
    tracks: [],
    shots: [],
    assets: [],
  };
}

describe('R6-D 对象树可访问性：重命名 Tab 停靠与移动到', () => {
  it('R6-D-T4 行内重命名期间 treeitem 移出 Tab 顺序：F2 后 tabindex=-1，提交后恢复 0', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    const cube = screen.getByTestId('tree-row-sample-cube');
    fireEvent.click(cube);
    expect(cube.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(cube, { key: 'F2' });
    const rename = screen.getByTestId('tree-rename-sample-cube');
    expect(rename).toHaveFocus();
    // RED：旧实现 treeitem 仍是 Tab 停靠点（tabindex=0），
    // Tab 会跳到下一个 treeitem 而非离开树
    expect(cube.getAttribute('tabindex')).toBe('-1');
    expect(
      screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0'),
    ).toHaveLength(0);

    fireEvent.keyDown(rename, { key: 'Enter' });
    expect(screen.queryByTestId('tree-rename-sample-cube')).not.toBeInTheDocument();
    expect(cube.getAttribute('tabindex')).toBe('0');
  });

  it('R6-D-T5 移动到：M 键与行内按钮均可打开目标菜单，候选排除自身与后代，选择即挂载', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    const cube = screen.getByTestId('tree-row-sample-cube');

    fireEvent.keyDown(cube, { key: 'm' });
    // RED：旧实现无 M 处理、无移动菜单
    expect(screen.getByTestId('tree-move-menu')).toBeInTheDocument();
    expect(screen.getByTestId('tree-move-to-root')).toBeInTheDocument();
    expect(screen.getByTestId('tree-move-to-sample-group')).toBeInTheDocument();
    expect(screen.getByTestId('tree-move-to-sample-cone')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-move-to-sample-cube')).not.toBeInTheDocument(); // 自身

    // 后代排除：把球体挂到立方体下，菜单不得出现球体
    // （事件回调外的编辑器变更需 act 包裹才会同步刷新 DOM）
    act(() => {
      editor.setParent('sample-sphere', 'sample-cube');
    });
    expect(screen.queryByTestId('tree-move-to-sample-sphere')).not.toBeInTheDocument();

    // 选择目标：立方体挂到圆锥下，菜单关闭
    fireEvent.click(screen.getByTestId('tree-move-to-sample-cone'));
    expect(screen.queryByTestId('tree-move-menu')).not.toBeInTheDocument();
    expect(findObject(editor, 'sample-cube')!.parentId).toBe('sample-cone');

    // 触屏等价路径：行内「移动」按钮
    fireEvent.click(screen.getByTestId('tree-move-sample-cone'));
    expect(screen.getByTestId('tree-move-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tree-move-to-root'));
    expect(findObject(editor, 'sample-cone')!.parentId).toBeNull();
    expect(screen.queryByTestId('tree-move-menu')).not.toBeInTheDocument();
  });

  it('R6-D-T6 深层树真实渲染与键盘遍历（48 节点、深 8）', () => {
    const editor = new SceneEditor();
    editor.openProject(deepProject());
    render(<TreeHarness editor={editor} cache={noopCache()} />);

    expect(screen.getByTestId('tree-row-d7-l4')).toBeInTheDocument(); // 最深行
    expect(screen.getAllByRole('treeitem')).toHaveLength(8 * 6);

    // 从根一路 ArrowDown 到底：选择与焦点落到最后一行
    screen.getByTestId('tree-row-d0').focus();
    for (let i = 0; i < 8 * 6 - 1; i += 1) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    }
    expect(editor.getSelection()).toEqual(['d7-l4']);
    expect(screen.getByTestId('tree-row-d7-l4')).toHaveFocus();
  });
});
