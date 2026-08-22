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
 * R10-M3 #6 对抗测试（TML-57 第十轮 M3，修复前必须失败）：
 * 移动菜单的 aria 关联 id 是 tree-move-trigger/menu-${object.id}——不含实例
 * 作用域：同一文档挂两个 ObjectTree（双面板/预览并排）时，同 id 对象的两棵树
 * 产生重复 DOM id（非法且 aria-controls/labelledby 解析歧义，getElementById
 * 恒取首个）；对象 id 若含空白（外部项目数据），id 属性含空白（非法、关联破坏）。
 * 修复：useId() 实例命名空间 + 空白编码（enc）——id 形如
 * tree-move-trigger-${instanceNs}-${enc(object.id)}，文档内全局唯一、无空白。
 * RED 格（现 HEAD 行为）：T1 双实例 id 重复且 aria 错配；T2 空白 id 未编码；
 * T3 为 R9-6-T3 语义回归（id 形态变化不得破坏关闭流）。
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

/** 替换 sample-cube 的 id（sample-cube 无子对象，重命名不破坏 parentId 引用） */
function makeEditorWithCubeId(id: string) {
  const editor = new SceneEditor();
  const sample = createSampleProject();
  editor.openProject({
    ...sample,
    objects: sample.objects.map((o) => (o.id === 'sample-cube' ? { ...o, id } : o)),
    // 轨道引用随对象 id 重命名同步（sample-track-cube-spin 绑定 sample-cube）
    tracks: sample.tracks.map((t) => (t.objectId === 'sample-cube' ? { ...t, objectId: id } : t)),
  });
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

describe('R10-M3 #6 移动菜单 aria 关联 id：实例作用域 + 空白编码', () => {
  it('R10-6-T1 双实例：同一对象 id 的两棵树 aria 关联 id 全局唯一、互不串扰（RED）', () => {
    const editorA = makeEditor();
    const editorB = makeEditor();
    render(
      <>
        <TreeHarness editor={editorA} cache={noopCache()} />
        <TreeHarness editor={editorB} cache={noopCache()} />
      </>,
    );

    // RED：现 HEAD id 不含实例作用域 → 两棵树的触发器 id 相同（重复 DOM id）
    const ids = Array.from(document.querySelectorAll('[id^="tree-move-"]')).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);

    const triggers = screen.getAllByTestId('tree-move-sample-cube');
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[0]!);
    expect(screen.getAllByTestId('tree-move-menu')).toHaveLength(1);
    // 焦点效应（既有行为，登记为上下文）：菜单打开时聚焦首个菜单项，第二个
    // 菜单打开夺走焦点 → 第一个菜单经 onBlur 关闭——双菜单同开在聚焦语义下
    // 不可达，本测试的目标是 id 唯一性与跨实例 aria 解析，而非双菜单并存
    fireEvent.click(triggers[1]!);
    const menus = screen.getAllByTestId('tree-move-menu');
    expect(menus).toHaveLength(1);
    const menu = menus[0]!;
    // 打开的菜单属于第二次点击的树（一致性）
    expect(document.getElementById(triggers[1]!.getAttribute('aria-controls')!)).toBe(menu);
    // RED：现 HEAD 两棵树 id 相同 → 已关闭的树 A 触发器 aria-controls 仍解析
    // 到树 B 的菜单（跨实例错配）；修复后唯一 id → 无元素（null）
    expect(document.getElementById(triggers[0]!.getAttribute('aria-controls')!)).toBeNull();
  });

  it('R10-6-T2 对象 id 含空白：aria 关联 id 编码为合法 id（无空白）、双向关联成立（RED）', () => {
    const editor = makeEditorWithCubeId('my object');
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    const trigger = openMenu('my object');
    const menu = screen.getByTestId('tree-move-menu');

    // RED：现 HEAD id = 'tree-move-menu-my object'（含空白——非法 id 且破坏关联）
    const menuId = menu.getAttribute('id')!;
    expect(menuId).not.toMatch(/\s/);
    expect(menuId.endsWith('-my_object')).toBe(true);
    expect(trigger.getAttribute('aria-controls')).toBe(menuId);
    expect(menu.getAttribute('aria-labelledby')).toBe(trigger.getAttribute('id'));
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(menu);
  });

  it('R10-6-T3 R9-6-T3 语义回归：移动后触发器 aria-expanded 回到 false、菜单移除', () => {
    const editor = makeEditor();
    render(<TreeHarness editor={editor} cache={noopCache()} />);
    const trigger = openMenu('sample-cube');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(within(screen.getByTestId('tree-move-menu')).getByTestId('tree-move-to-root'));

    expect(screen.queryByTestId('tree-move-menu')).not.toBeInTheDocument();
    // 层级变更使触发行重建（ObjectTree commitMove flushSync），须重新查询：
    // 新行节点的 aria-expanded 已回到 'false'
    const rebuiltTrigger = screen.getByTestId('tree-move-sample-cube');
    expect(rebuiltTrigger.getAttribute('aria-expanded')).toBe('false');
  });
});
