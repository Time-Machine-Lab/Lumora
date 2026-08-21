// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project } from '../src/scene/types';

/**
 * R8-6 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * 严格 schema（validate.ts）——未知非 JSON 字段与 Map/Set/Date 壳：
 * - 未知字段携带 Map：deepFreeze 只冻结自有属性，Map 内部槽位仍可变更，
 *   持有项目引用的调用方可无历史地改写编辑器状态；
 * - 未知字段（含嵌套层）一律拒绝：schema 之外的载荷不收、不落库。
 * 修复：每层结构拒绝未知键 + 拒绝非 JSON 结构（Map/Set/Date/类实例）。
 */

describe('R8-6 严格 schema：未知字段与非 JSON 结构拒绝', () => {
  it('R8-6-T1 openProject 未知字段携带 Map：拒绝打开，编辑器状态保持空', () => {
    const editor = new SceneEditor();
    // RED：旧校验不查未知键，Map 经 structuredClone 存活并被深冻结为「壳」——
    // 冻结只覆盖自有属性，Map.set 仍可改内部槽位 → 无历史绕过
    const poisoned: Project = { ...createSampleProject(), evil: new Map() } as Project;

    expect(() => editor.openProject(poisoned)).toThrow(/未知字段/);
    expect(editor.getProject()).toBeNull();
  });

  it('R8-6-T2 updater 返回对象携带 Map 未知字段：提交被拒绝，历史不动', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    const result = editor.updateObjectProps('sample-cube', (o) => ({ ...o, evil: new Map() }), '注入');
    // RED：旧实现接受并提交，变更不可见于历史
    expect(result.ok).toBe(false);
    expect(editor.getHistoryState().canUndo).toBe(false);
    expect(editor.getProject()!.objects.find((x) => x.id === 'sample-cube')!.name).toBe('立方体');
  });

  it('R8-6-T3 openProject 普通未知字段：schema 之外的载荷一律拒绝', () => {
    const editor = new SceneEditor();
    const poisoned: Project = { ...createSampleProject(), extra: 123 } as Project;

    expect(() => editor.openProject(poisoned)).toThrow(/未知字段/);
    expect(editor.getProject()).toBeNull();
  });

  it('R8-6-T4 updater 返回对象带未知普通字段：提交被拒绝', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    const result = editor.updateObjectProps('sample-cube', (o) => ({ ...o, extra: 123 }), '注入');
    expect(result.ok).toBe(false);
  });

  it('R8-6-T5 嵌套层（settings）未知字段携带 Date：同样拒绝', () => {
    const editor = new SceneEditor();
    const poisoned: Project = {
      ...createSampleProject(),
      settings: { fps: 30, aspect: [16, 9], evil: new Date() } as Project['settings'],
    };

    expect(() => editor.openProject(poisoned)).toThrow(/未知字段/);
    expect(editor.getProject()).toBeNull();
  });
});
