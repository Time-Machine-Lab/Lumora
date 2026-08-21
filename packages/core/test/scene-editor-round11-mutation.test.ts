// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';

/**
 * R11-3 setGuide 同值 no-op（TML-57 第十一轮，修复前必须失败）：
 * setGuide 无同值 guard——同值写仍替换 view、mutationVersion+1、emit
 * （对比 setViewMode 有 same 检查）。后果：updater 内嵌套同值 setGuide
 * 推进事务版本 → 外层合法提交被 commitEntry 背止取消。
 * 修复：guard 后先比较当前值再 return，同值不推进版本、不 emit、不取消外层。
 * RED 格（现 HEAD 行为）：T1 同值首次调用 emit 1 次；T3 外层提交失败。
 */

function makeEditor() {
  const editor = new SceneEditor();
  editor.openProject(createSampleProject());
  return editor;
}

describe('R11-3 setGuide 同值 no-op：真实变化才推进版本并 emit', () => {
  it('R11-3-T1 同值 no-op：初始同值调用与重复调用均不 emit（RED）', () => {
    const editor = makeEditor();
    const listener = vi.fn();
    editor.events.on('view:changed', listener);
    // fresh 视图 guides.thirds 默认为 true：同值调用
    editor.setGuide('thirds', true);
    // RED：现 HEAD 无条件写 → emit 1 次；修复后同值 no-op → 0 次
    expect(listener).toHaveBeenCalledTimes(0);
    editor.setGuide('thirds', true);
    expect(listener).toHaveBeenCalledTimes(0);
    expect(editor.getView().guides.thirds).toBe(true);
  });

  it('R11-3-T2 真实变化：false→true 切换 emit 1 次、视图更新', () => {
    const editor = makeEditor();
    const listener = vi.fn();
    editor.events.on('view:changed', listener);
    editor.setGuide('thirds', false);
    expect(editor.getView().guides.thirds).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    editor.setGuide('thirds', true);
    expect(editor.getView().guides.thirds).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    // 另一个 kind 互不影响
    expect(editor.getView().guides.safeFrame).toBe(true);
  });

  it('R11-3-T3 updater 内同值 setGuide 不取消外层事务：外层改名提交成功（RED）', () => {
    const editor = makeEditor();
    const before = editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name;
    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => {
        // 同值调用（guides.thirds 当前已是 true）：修复后为 no-op，不推进版本
        editor.setGuide('thirds', true);
        return { ...o, name: '改名' };
      },
      '改名',
    );
    // RED：现 HEAD 内层同值 setGuide 仍推进 mutationVersion → 外层 commitEntry
    // 背止失败；修复后同值 no-op → 外层提交成功
    expect(result.ok).toBe(true);
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe('改名');
    expect(editor.getView().guides.thirds).toBe(true);
  });

  it('R11-3-T4 updater 内真实变化 setGuide：外层仍被取消、内层视图写保留（事务语义回归）', () => {
    const editor = makeEditor();
    const before = editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name;
    const result = editor.updateObjectProps(
      'sample-cube',
      (o) => {
        editor.setGuide('thirds', false);
        return { ...o, name: '改名' };
      },
      '改名',
    );
    // 真实变化仍是版本推进（R10-M1 不变式）：外层取消、内层保留
    expect(result.ok).toBe(false);
    expect(editor.getProject()!.objects.find((o) => o.id === 'sample-cube')!.name).toBe(before);
    expect(editor.getView().guides.thirds).toBe(false);
  });

  it('R11-3-T5 dispose 后静默 no-op（R10-T19 语义回归）', () => {
    const editor = makeEditor();
    editor.dispose();
    editor.setGuide('safeFrame', false);
    // dispose 重置视图为 fresh 默认（safeFrame 默认 true），dispose 后不得改变
    expect(editor.getView().guides.safeFrame).toBe(true);
  });
});
