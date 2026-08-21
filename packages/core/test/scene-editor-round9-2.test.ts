// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project } from '../src/scene/types';

/**
 * R9 恢复：R8-2 四条回归（TML-57 第九轮测试纪律修正）。
 * `84f399a` 曾把 scene-editor-round8.test.ts 原有 4 条 #2 回归整段替换为 #12
 * （84f399a~1 全文件 77 行 = 本文件内容）；按纪律恢复为独立新文件，
 * 断言逐字取自 84f399a~1，作为 M1 事务边界改造期间的回归地板，全程保持绿：
 * - updater 内 dispose()：外层提交必须被取消，项目不得复活；
 * - updater 内嵌套提交：外层提交必须被取消，内层结果保留且历史不被移动；
 * - 输入/返回对象的 getter 在 structuredClone 期间执行 dispose()：
 *   克隆后必须复验终态，不得继续提交。
 */

describe('R9-2 外部 updater 终态与原子提交（恢复的 R8-2 回归）', () => {
  it('R9-2-T1 updater 内 dispose：提交被取消，项目不复活，返回失败', () => {
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
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });

  it('R9-2-T2 updater 内嵌套提交：外层取消、内层保留、历史只含内层', () => {
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
    expect(result.ok).toBe(false);
    const cube = editor.getProject()!.objects.find((x) => x.id === 'sample-cube')!;
    const sphere = editor.getProject()!.objects.find((x) => x.id === 'sample-sphere')!;
    expect(cube.name).toBe('立方体');
    expect(sphere.name).toBe('内层改名');
    editor.undo();
    expect(editor.getProject()!.objects.find((x) => x.id === 'sample-sphere')!.name).toBe('球体');
  });

  it('R9-2-T3 openProject 输入 getter 副作用 dispose：克隆后复验，状态不复活', () => {
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
    expect(() => editor.openProject(poisoned)).toThrow('编辑器已释放');
    expect(editor.getProject()).toBeNull();
  });

  it('R9-2-T4 返回对象 getter 副作用 dispose：own 克隆后复验，提交被取消', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => {
        const next = { ...o, name: '毒返回' };
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
    expect(result.ok).toBe(false);
    expect(editor.getProject()).toBeNull();
  });
});
