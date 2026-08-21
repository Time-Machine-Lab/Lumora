// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project, SceneObjectData } from '../src/scene/types';

/**
 * R8-6 对抗测试（TML-57 第八轮复审，修复前必须失败）：
 * Map/Set/Date 冻结壳（immutable.ts 冻结盲区）：
 * - deepFreeze 只遍历自有属性，Map/Set 内部槽位（[[MapData]]）与 Date 时间
 *   槽位不在自有属性上 → 冻结「壳」仍可 .set()/.setTime()，持有项目引用的
 *   调用方可无历史地改写编辑器状态；
 * - 修复：validate 对候选载荷做全树 JSON 纯性校验（迭代遍历、防环），任何
 *   层级出现 Map/Set/Date/类实例一律拒绝，保证落库数据可被真正深度冻结。
 * - 基线约束：round-6 冻结测试要求含自引用未知键（loop）的输入可正常打开，
 *   故未知普通字段保留——只要整树是 JSON 纯结构，deepFreeze 即真正冻结，
 *   不产生绕过。
 */

describe('R8-6 非 JSON 结构（Map/Set/Date 壳）拒绝', () => {
  it('R8-6-T1 openProject 未知字段携带 Map：拒绝打开，编辑器状态保持空', () => {
    const editor = new SceneEditor();
    // RED：旧校验不查结构，Map 经 structuredClone 存活并被深冻结为「壳」——
    // 冻结只覆盖自有属性，Map.set 仍可改内部槽位 → 无历史绕过
    const poisoned: Project = { ...createSampleProject(), evil: new Map() } as Project;

    expect(() => editor.openProject(poisoned)).toThrow(/不是 JSON 结构/);
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

  it('R8-6-T3 未知普通字段保留（round-6 基线可打开），落库后整树深度冻结', () => {
    const editor = new SceneEditor();
    const extended: Project = {
      ...createSampleProject(),
      extra: { deep: [1, 2, 3] },
    } as Project;
    // 冻结基线：含未知普通字段（乃至自引用）的输入必须可打开
    editor.openProject(extended);
    const stored = editor.getProject()! as Project & { extra: { deep: number[] } };
    // 未知字段作为普通数据落库，必须被深度冻结：写入抛 TypeError，无历史绕过
    expect(Object.isFrozen(stored.extra)).toBe(true);
    expect(Object.isFrozen(stored.extra.deep)).toBe(true);
    expect(() => {
      stored.extra.deep[0] = 99;
    }).toThrow(TypeError);
  });

  it('R8-6-T4 updater 返回对象带未知普通字段：接受并深度冻结', () => {
    const editor = new SceneEditor();
    editor.openProject(createSampleProject());

    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => ({ ...o, extra: { deep: [1, 2, 3] } }),
      '注入',
    );
    expect(result.ok).toBe(true);
    const stored = editor.getProject()!.objects.find((x) => x.id === 'sample-cube')! as SceneObjectData & {
      extra: { deep: number[] };
    };
    expect(Object.isFrozen(stored.extra)).toBe(true);
    expect(Object.isFrozen(stored.extra.deep)).toBe(true);
  });

  it('R8-6-T5 嵌套层（settings）携带 Date：同样拒绝', () => {
    const editor = new SceneEditor();
    const poisoned: Project = {
      ...createSampleProject(),
      settings: { fps: 30, aspect: [16, 9], evil: new Date() } as Project['settings'],
    };

    expect(() => editor.openProject(poisoned)).toThrow(/不是 JSON 结构/);
    expect(editor.getProject()).toBeNull();
  });
});
