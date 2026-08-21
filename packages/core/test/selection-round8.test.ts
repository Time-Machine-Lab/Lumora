// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';

/**
 * R8-8 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 选择/历史恢复/复制的去重缺失（scene-editor.ts setSelection/
 * filterSelection/duplicateSelection）：
 * - setSelection 与 filterSelection（提交/撤销/重做恢复路径）不过滤重复 ID，
 *   重复选择进入状态与历史快照，undo/redo 非对称地恢复出重复选择；
 * - duplicateSelection 输入含重复 ID 时 roots 重复 → 第二个副本 run 因
 *   indexOf 只取首个下标而被丢弃 → 返回的副本 ID 指向不存在的对象。
 * 修复：选择入口与历史恢复统一「首次出现去重 + 可达性过滤」，
 * 复制入口对 roots 去重；返回的选择 ID 必然不重复且可达。
 */

describe('R8-8 选择去重与可达性不变量', () => {
  it('R8-8-T1 setSelection 重复 ID：首次出现去重，顺序保持', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    editor.setSelection(['sample-cube', 'sample-cube', 'sample-sphere', 'sample-cube']);

    // RED：旧实现仅按可达性过滤，重复 ID 原样保留
    expect(editor.getSelection()).toEqual(['sample-cube', 'sample-sphere']);
  });

  it('R8-8-T2 setSelection 重复 + 不可达 ID：去重后过滤', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    editor.setSelection(['sample-cube', 'ghost', 'sample-cube', 'sample-group']);

    // RED：重复与不可达 ID 均残留
    expect(editor.getSelection()).toEqual(['sample-cube', 'sample-group']);
    expect(editor.getSelection().length).toBe(2);
  });

  it('R8-8-T3 duplicateSelection 输入含重复 ID：每个对象只复制一份，返回 ID 可达', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    editor.setSelection(['sample-group', 'sample-group', 'sample-cube']);

    const result = editor.duplicateSelection();
    // RED：旧实现 roots 含重复 → 第二个副本 run 被 indexOf 丢弃 → 提交失败
    // 或返回指向不存在对象的副本 ID
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.ids;
    expect(ids).toHaveLength(1);
    const project = editor.getProject()!;
    expect(project.objects.some((o) => o.id === ids[0])).toBe(true);
    const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
    expect(scene.rootObjectIds.includes(ids[0])).toBe(true);
  });

  it('R8-8-T4 提交/撤销/重做路径：选择恢复对称且无重复', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    editor.setSelection(['sample-cube', 'sample-cube']);

    const result = editor.updateObjectProps('sample-cube', (o) => ({ ...o, name: '改名' }), '改名');
    expect(result.ok).toBe(true);
    // RED：commitEntry 过滤后选择仍含重复
    expect(editor.getSelection()).toEqual(['sample-cube']);

    editor.undo();
    // RED：恢复 before 快照中的重复选择
    expect(editor.getSelection()).toEqual(['sample-cube']);
    editor.redo();
    // RED：恢复 after 快照中的重复选择（对称性）
    expect(editor.getSelection()).toEqual(['sample-cube']);
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe('改名');
  });

  it('R8-8-T5 历史快照恢复后选择可达：已删对象不残留，undo 后重新可达', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());
    editor.setSelection(['sample-cube', 'sample-sphere']);

    const result = editor.deleteSelection();
    expect(result.ok).toBe(true);
    // 被删对象不在选择中
    expect(editor.getSelection().some((id) => ['sample-cube', 'sample-sphere'].includes(id))).toBe(false);

    editor.undo();
    // 恢复后选择全部可达（对象回到项目）
    const selection = editor.getSelection();
    expect(selection).toEqual(['sample-cube', 'sample-sphere']);
    const project = editor.getProject()!;
    expect(selection.every((id) => project.objects.some((o) => o.id === id))).toBe(true);
  });
});
