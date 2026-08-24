import { describe, expect, it, vi } from 'vitest';
import { createGroupObject, createSampleProject } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import { ProjectStore } from '../src/persistence/project-store';
import type { ProjectStorage } from '../src/persistence/project-storage';

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

describe('StudioRuntime：首存失败的切换屏障（TML-53 第四轮 #2 运行时回归）', () => {
  /** 注入恒失败的存储（save 一律拒绝）：模拟首存即落盘的存储故障 */
  function alwaysFailingStore(): ProjectStorage {
    return {
      kind: 'indexeddb',
      async list() {
        return { ok: true, items: [] };
      },
      async load() {
        return { ok: true, project: null };
      },
      async save() {
        return { ok: false, code: 'quota-exceeded' as const, message: '本地存储空间不足，保存失败' };
      },
      async remove() {
        return { ok: true, removed: false };
      },
      async removeIfUnchanged() {
        return { ok: true, outcome: 'missing' };
      },
      async rename() {
        return { ok: false, code: 'not-found' as const, message: '项目不存在' };
      },
      async duplicate() {
        return { ok: false, code: 'not-found' as const, message: '项目不存在' };
      },
      close() {},
    };
  }

  it('首存失败（未编辑）后切换：openProject(B) 返回 {ok:false}，旧项目保持打开（曾假成功放行）', async () => {
    const runtime = createStudioRuntime();
    await runtime.init({ store: alwaysFailingStore(), debounceMs: 20 });
    await runtime.openProject(createSampleProject('lumora://project/a', '项目A'));
    await new Promise((r) => setTimeout(r, 60)); // 首存失败（无假记录）

    const switched = await runtime.openProject(createSampleProject('lumora://project/b', '项目B'));
    expect(switched.ok).toBe(false);
    if (switched.ok) return;
    expect(switched.message).toContain('保存失败');
    // 旧项目保持打开：未保存内容仍在编辑器与宿主快照
    expect(runtime.editor.getProject()!.uri).toBe('lumora://project/a');
    expect(runtime.host.getProject()!.uri).toBe('lumora://project/a');
    await runtime.dispose();
  });

  it('首存失败后存储恢复：切换前排空重试成功才放行，内容完整落盘', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-firstsave';
    await ProjectStore.drop(db);
    const real = await ProjectStore.create(db);
    if (!real) throw new Error('store 创建失败');
    let firstSaveFailed = false;
    const flaky: ProjectStorage = {
      kind: 'indexeddb',
      async list() {
        return real.list();
      },
      async load(uri) {
        return real.load(uri);
      },
      async save(project, expected) {
        if (!firstSaveFailed) {
          firstSaveFailed = true;
          return { ok: false, code: 'storage-error' as const, message: '磁盘瞬时错误' };
        }
        return real.save(project, expected);
      },
      async remove(uri) {
        return real.remove(uri);
      },
      async removeIfUnchanged(uri, expectedFingerprint) {
        return real.removeIfUnchanged(uri, expectedFingerprint);
      },
      async rename(uri, name) {
        return real.rename(uri, name);
      },
      async duplicate(uri, name) {
        return real.duplicate(uri, name);
      },
      close() {
        real.close();
      },
    };
    await runtime.init({ store: flaky, debounceMs: 20 });
    await runtime.openProject(createSampleProject('lumora://project/a', '项目A'));
    await new Promise((r) => setTimeout(r, 60)); // 首存失败

    // 切换：排空重试（存储已恢复）→ 放行，A 完整落盘
    const switched = await runtime.openProject(createSampleProject('lumora://project/b', '项目B'));
    expect(switched.ok).toBe(true);
    const loaded = await runtime.persistence.loadProject('lumora://project/a');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.project.revision).toBe(0);
    expect(runtime.editor.getProject()!.uri).toBe('lumora://project/b');
    await runtime.dispose();
    await ProjectStore.drop(db);
  });
});

describe('StudioRuntime：dispose 幂等合并 single-flight（第三十一轮严重 3）', () => {
  it('并发 dispose 共享同一 in-flight 执行；失败后清空缓存可重试，成功后永久复用', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-singleflight';
    await ProjectStore.drop(db);
    await runtime.init({ dbName: db, debounceMs: 20 });
    await runtime.openProject(createSampleProject('lumora://project/r31-runtime', '并发释放'));

    // 首次 dispose 失败：persistence 冲刷失败 → 运行时不 teardown
    // （第三十二轮阻断 1：SaveOutcome 失败分支必填 code —— 缺 code 的 mock
    // 使精确 head 的 tsc TS2345，门禁「全绿」不成立）
    const disposeSpy = vi.spyOn(runtime.persistence, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: false, code: 'storage-error', message: '模拟冲刷失败' });

    const first = runtime.dispose();
    const second = runtime.dispose();
    // 非 async 直接返回缓存 promise：并发调用拿到同一对象（发布先行，只执行一次）
    expect(second).toBe(first);
    const outcome = await first;
    expect(outcome).toEqual({ ok: false, message: '模拟冲刷失败' });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // 失败后不 teardown：编辑器仍完整可用（重试/保全未落盘内容的通道未被销毁）
    expect(() => runtime.editor.openProject(createSampleProject())).not.toThrow();

    // 失败 settle 后缓存清空 → 重试执行新一轮，成功
    disposeSpy.mockRestore();
    const retried = await runtime.dispose();
    expect(retried).toEqual({ ok: true });

    // 成功后永久复用成功结果：重复调用幂等，不再触碰 persistence
    const retrySpy = vi.spyOn(runtime.persistence, 'dispose');
    const again = runtime.dispose();
    const again2 = runtime.dispose();
    expect(again2).toBe(again);
    await expect(again).resolves.toEqual({ ok: true });
    expect(retrySpy).not.toHaveBeenCalled();
    retrySpy.mockRestore();

    await ProjectStore.drop(db);
  });
});

describe('StudioRuntime：终态释放 best-effort 收敛（第三十二轮阻断 2 + 第三十三轮阻断 2）', () => {
  it('host.dispose() 抛错：终态仍收敛返回 {ok:true} 并携带失败明细，编辑器完整销毁（修复前 {ok:false} 但 persistence 已永久释放 —— 死壳）', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-host-throw';
    await ProjectStore.drop(db);
    await runtime.init({ dbName: db, debounceMs: 60_000 });
    await runtime.openProject(createSampleProject('lumora://project/r33-host', '宿主停用失败'));

    const hostDisposeSpy = vi.spyOn(runtime.host, 'dispose');
    hostDisposeSpy.mockRejectedValueOnce(new Error('模拟插件停用失败'));

    const outcome = await runtime.dispose();
    // commit 阶段失败不再以 {ok:false} 冒充「运行态完整」：终态已收敛
    // （persistence 释放、host 尝试停用、事件订阅拆除、编辑器销毁），失败
    // 明细并入 message —— 宿主拿到 {ok:true} 即可安全卸载，不会保持挂载
    // 面对「可编辑但不可保存」的死壳（修复前返回 {ok:false}、宿主保持挂载
    // 重试，新编辑随重试的编辑器销毁丢失 —— 审查员点名未验证可落盘）
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('模拟插件停用失败');
    // 终态收敛：编辑器已销毁（best-effort 不中断后续步骤）
    expect(() => runtime.editor.openProject(createSampleProject())).toThrow('编辑器已释放');
    expect(hostDisposeSpy).toHaveBeenCalledTimes(1);

    // 终态后 dispose 幂等短路：重试不再触碰 host —— 成功裁决连同失败明细
    // 一并归档复用（与第三十一轮「成功后永久复用同一成功结果对象」同语义）
    const retried = await runtime.dispose();
    expect(retried).toEqual({ ok: true, message: '终态释放部分失败：模拟插件停用失败' });
    expect(hostDisposeSpy).toHaveBeenCalledTimes(1);
    hostDisposeSpy.mockRestore();
    await ProjectStore.drop(db);
  });
});

describe('StudioRuntime：init/dispose 竞态（第三十二轮严重 4 + 第三十三轮收敛）', () => {
  it('init 挂起期间 dispose 先开始：晚到 store 在收敛点被关闭并丢弃，不残留连接', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-init-race';
    await ProjectStore.drop(db);
    const lateStore = await ProjectStore.create(db);
    expect(lateStore).not.toBeNull();
    const closeSpy = vi.spyOn(lateStore!, 'close');

    let releaseCreate!: (s: ProjectStore | null) => void;
    const createSpy = vi.spyOn(ProjectStore, 'create').mockImplementationOnce(
      () => new Promise<ProjectStore | null>((resolve) => {
        releaseCreate = resolve;
      }),
    );

    const initPromise = runtime.init({ dbName: db });
    // dispose 先开始：preflight 通过后在 commit 前置收敛点等待在途 init settle
    // （第三十三轮严重 4 —— 修复前 dispose 不等 init，晚到 store 的 close 抛错
    // 被空 catch 吞掉，唯一引用丢失、连接泄漏；测试必须先建 disposePromise 再
    // releaseCreate，否则收敛点等待挂死）
    const disposePromise = runtime.dispose();

    releaseCreate(lateStore); // 晚到的 store 到达（disposed 尚未置位 → 正常挂载）
    await initPromise;
    const disposeOutcome = await disposePromise;
    expect(disposeOutcome).toEqual({ ok: true });
    // 晚到 store 被 dispose commit 的 store.close() 关闭：不残留连接
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(runtime.persistence.available).toBe(false);
    createSpy.mockRestore();
    closeSpy.mockRestore();
    lateStore!.close();
    await ProjectStore.drop(db);
  });
});

describe('StudioRuntime：init 拒绝不污染 single-flight（第三十三轮一般 5）', () => {
  it('init 拒绝 settle 后缓存清理：后续 init 重试走新一轮并成功', async () => {
    const runtime = createStudioRuntime();
    const db = 'lumora-test-runtime-init-reject';
    await ProjectStore.drop(db);
    const createSpy = vi.spyOn(ProjectStore, 'create').mockRejectedValueOnce(new Error('模拟存储打开失败'));
    await expect(runtime.init({ dbName: db })).rejects.toThrow('模拟存储打开失败');
    // 拒绝 settle 后 single-flight 缓存已清理：重试走新一轮真实创建并成功
    // （修复前 success-only 清理永久复用 rejected promise，后续 init 永远失败）
    await runtime.init({ dbName: db });
    expect(runtime.persistence.available).toBe(true);
    createSpy.mockRestore();
    await runtime.dispose();
    await ProjectStore.drop(db);
  });
});
