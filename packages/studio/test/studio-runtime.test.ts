import { describe, expect, it, vi } from 'vitest';
import { createGroupObject, createSampleProject } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';

describe('StudioRuntime：宿主快照与事件总线随编辑器同步（S-3）', () => {
  it('编辑器每次变更后 host 快照与 project:changed 广播保持当前', () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    runtime.openProject(project);
    // owned immutable：宿主同步的是编辑器持有的深克隆快照，而非传入的输入引用
    expect(runtime.host.getProject()).not.toBe(project);
    expect(runtime.host.getProject()).toEqual(project);

    const changed = vi.fn();
    const unsubscribe = runtime.events.on('project:changed', changed);

    // 编辑（addObject）：宿主读到的不是打开时的旧快照，而是当前项目
    const result = runtime.editor.addObject(createGroupObject());
    expect(result.ok).toBe(true);
    expect(runtime.host.getProject()).toBe(runtime.editor.getProject());
    expect(runtime.host.getProject()!.objects.length).toBe(project.objects.length + 1);
    expect(changed).toHaveBeenLastCalledWith({ project: runtime.editor.getProject() });

    // 撤销同样同步
    runtime.editor.undo();
    expect(runtime.host.getProject()!.objects.length).toBe(project.objects.length);

    unsubscribe.dispose();
  });

  it('closeProject 清空宿主快照并广播；dispose 后编辑器变更不再同步到宿主', async () => {
    const runtime = createStudioRuntime();
    runtime.openProject(createSampleProject());
    const closed = vi.fn();
    const unsubscribe = runtime.events.on('project:closed', closed);

    runtime.closeProject();
    expect(runtime.host.getProject()).toBeNull();
    expect(runtime.editor.getProject()).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    unsubscribe.dispose();

    await runtime.dispose();
    // dispose 为终态：openProject 同步抛错，宿主快照保持空
    expect(() => runtime.editor.openProject(createSampleProject())).toThrow('编辑器已释放');
    expect(runtime.host.getProject()).toBeNull();
  });
});
