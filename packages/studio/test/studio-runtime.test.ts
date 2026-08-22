import { describe, expect, it, vi } from 'vitest';
import { createGroupObject, createSampleProject } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import { ProjectStore } from '../src/persistence/project-store';

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

    await runtime.closeProject();
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

describe('StudioRuntime：openProject 可等待的类型化切换屏障（TML-53 第三轮 #1）', () => {
  it('切换前先稳定排空当前项目未保存变更，再打开新项目', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-switch';
    await ProjectStore.drop(db);
    await runtime.init({ dbName: db, debounceMs: 20 });
    const opened = await runtime.openProject(createSampleProject('lumora://project/a', '项目A'));
    expect(opened).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10)); // 首存完成
    runtime.editor.addObject(createGroupObject()); // rev1 未保存
    const switched = await runtime.openProject(createSampleProject('lumora://project/b', '项目B'));
    expect(switched).toEqual({ ok: true });
    // A 的未保存编辑已在替换编辑器前排空落盘
    const loaded = await runtime.persistence.loadProject('lumora://project/a');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.project.revision).toBe(1);
      expect(loaded.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }
    // 新项目已打开（宿主与编辑器同步）
    expect(runtime.editor.getProject()!.uri).toBe('lumora://project/b');
    expect(runtime.host.getProject()!.uri).toBe('lumora://project/b');
    await runtime.dispose();
    await ProjectStore.drop(db);
  });

  it('排空失败（锁存冲突）时 openProject 返回 {ok:false} 且不触碰编辑器：旧项目保持打开', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-conflict';
    await ProjectStore.drop(db);
    const store = await ProjectStore.create(db);
    if (!store) throw new Error('store 创建失败');
    // 预置较新的已存内容（revision 5，模拟另一标签页已保存）
    await store.save({ ...createSampleProject('lumora://project/a', '较新内容'), revision: 5 });
    store.close();

    await runtime.init({ dbName: db, debounceMs: 20 });
    await runtime.openProject({ ...createSampleProject('lumora://project/a', '较旧内容'), revision: 3 });
    await new Promise((r) => setTimeout(r, 60)); // 对账 → revision 冲突锁存

    const switched = await runtime.openProject(createSampleProject('lumora://project/b'));
    expect(switched.ok).toBe(false);
    if (switched.ok) return;
    expect(switched.message).toContain('不一致');
    // 旧项目保持打开：编辑器与宿主都未被替换
    expect(runtime.editor.getProject()!.uri).toBe('lumora://project/a');
    expect(runtime.host.getProject()!.uri).toBe('lumora://project/a');
    await runtime.dispose();
    await ProjectStore.drop(db);
  });
});
