// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project } from '../src/scene/types';

/**
 * R8-2 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 外部 updater / 输入对象克隆期间的副作用（dispose、嵌套提交）不得破坏
 * 编辑器终态与原子提交：
 * - updater 内 dispose()：外层提交必须被取消，项目不得复活；
 * - updater 内嵌套提交：外层提交必须被取消，内层结果保留且历史不被移动；
 * - 输入/返回对象的 getter 在 structuredClone 期间执行 dispose()：
 *   克隆后必须复验终态，不得继续提交。
 */

describe('R8-2 外部 updater 终态与原子提交', () => {
  it('R8-2-T1 updater 内 dispose：提交被取消，项目不复活，返回失败', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => {
        editor.dispose();
        return { ...o, name: '毒改名' };
      },
      '改名',
    );
    // RED：旧实现不校验，外层 commit 复活项目并返回成功
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R8-2-T2 updater 内嵌套提交：外层取消、内层保留、历史只含内层', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => {
        const inner = editor.updateObjectProps(
          'sample-sphere',
          (s) => ({ ...s, name: '内层改名' }),
          '内层改名',
        );
        expect(inner.ok).toBe(true);
        return { ...o, name: '外层改名' };
      },
      '外层改名',
    );
    // RED：旧实现外层提交成功且用回调前的旧快照覆盖内层结果
    expect(result.ok).toBe(false);
    const cube = editor.getProject()!.objects.find((x) => x.id === 'sample-cube')!;
    const sphere = editor.getProject()!.objects.find((x) => x.id === 'sample-sphere')!;
    expect(cube.name).toBe('立方体');
    expect(sphere.name).toBe('内层改名');
    // 历史只有内层一步：undo 回到内层改名前
    editor.undo();
    expect(editor.getProject()!.objects.find((x) => x.id === 'sample-sphere')!.name).toBe('球体');
  });

  it('R8-2-T3 openProject 输入 getter 副作用 dispose：克隆后复验，状态不复活', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const poisoned: Project = { ...createSampleProject(), name: '带毒项目' };
    Object.defineProperty(poisoned, 'bomb', {
      enumerable: true,
      get() {
        editor.dispose();
        return 'x';
      },
    });
    // RED：旧实现克隆后不复验，继续提交复活项目
    expect(() => editor.openProject(poisoned)).toThrow('编辑器已释放');
    expect(editor.getProject()).toBeNull();
  });

  it('R8-2-T4 返回对象 getter 副作用 dispose：own 克隆后复验，提交被取消', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => {
        const next = { ...o, name: '毒返回' };
        // getter 必须挂在 schema 已知键上（R8-6 严格校验在克隆前拒绝未知键，
        // 未知键上的 getter 不再能到达 structuredClone，测试场景将不可达）
        Object.defineProperty(next, 'name', {
          enumerable: true,
          configurable: true,
          get() {
            editor.dispose();
            return '毒返回';
          },
        });
        return next;
      },
      '改名',
    );
    // RED：旧实现 own 克隆后不复验，commit 复活项目并返回成功
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });
});
