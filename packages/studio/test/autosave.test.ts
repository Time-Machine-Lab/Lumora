import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneEditor, createGroupObject, createSampleProject } from '@lumora/core';
import { ProjectAutosaver } from '../src/persistence/autosave';
import type { AutosaveState } from '../src/persistence/autosave';
import { ProjectStore } from '../src/persistence/project-store';

const DB = 'lumora-test-autosave';
const DEBOUNCE = 20;

/** 编辑器事件 → 自动保存直连（与 ProjectPersistence.init 相同的接线方式） */
const openStores: ProjectStore[] = [];

async function wired(debounceMs = DEBOUNCE) {
  const editor = new SceneEditor();
  const store = await ProjectStore.create(DB);
  expect(store).not.toBeNull();
  openStores.push(store!);
  const autosaver = new ProjectAutosaver(editor, store!, { debounceMs });
  editor.events.on('project:changed', ({ project }) => autosaver.changed(project));
  return { editor, store: store!, autosaver };
}

async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
  await ProjectStore.drop(DB);
});

afterEach(async () => {
  // 先关闭全部连接再删库：deleteDatabase 会排在未关闭连接之后，挂起的删除
  // 会无限阻塞后续 open（fake-indexeddb 与真实浏览器行为一致）
  for (const store of openStores) store.close();
  openStores.length = 0;
  await ProjectStore.drop(DB);
});

describe('ProjectAutosaver：2 秒防抖自动保存（FR-011）', () => {
  it('变更后防抖落盘：dirty → saving → clean，存储 revision 更新', async () => {
    const { editor, store, autosaver } = await wired();
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));

    editor.openProject(createSampleProject('lumora://project/a', '自动保存项目'));
    await settle(10);
    expect(states.at(-1)).toBe('clean');

    editor.addObject(createGroupObject());
    await settle(10);
    expect(states).toContain('dirty');

    await settle(60);
    expect(states.at(-1)).toBe('clean');
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(editor.getProject()!.revision);
    expect(stored!.objects.length).toBe(createSampleProject().objects.length + 1);
    autosaver.dispose();
  });

  it('防抖窗口内多次变更合并为一次保存', async () => {
    const { editor, store, autosaver } = await wired();
    const saveSpy = vi.spyOn(store, 'save');
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    saveSpy.mockClear();

    editor.addObject(createGroupObject());
    editor.addObject(createGroupObject());
    editor.addObject(createGroupObject());
    await settle(10);
    // 防抖窗口内尚未保存
    expect(saveSpy).not.toHaveBeenCalled();
    await settle(60);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    autosaver.dispose();
  });

  it('flush 立即保存（不等防抖）', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    editor.addObject(createGroupObject());
    await autosaver.flush();
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(editor.getProject()!.revision);
    autosaver.dispose();
  });

  it('close（project:changed null）冲刷未保存变更并归位 idle', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    editor.addObject(createGroupObject());
    editor.reset(); // 触发 changed(null)
    await settle(40);
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(editor.getProject()?.revision ?? stored!.revision);
    expect(stored!.objects.length).toBeGreaterThan(createSampleProject().objects.length);
    autosaver.dispose();
  });

  it('持久化不可用（store 为 null）时明示「仅内存」：不报错、不假报已保存', async () => {
    const editor = new SceneEditor();
    const autosaver = new ProjectAutosaver(editor, null, { debounceMs: DEBOUNCE });
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    editor.addObject(createGroupObject());
    await settle(40);
    expect(states.at(-1)).toBe('memory');
    expect(states).not.toContain('error');
    expect(states).not.toContain('clean');
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：切换排空与首存诚实（阻断项回归）', () => {
  it('项目切换：旧项目未保存快照排空落盘（不取消不丢失），结果绑定旧 uri，新项目干净', async () => {
    const { editor, store, autosaver } = await wired();
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));

    editor.openProject(createSampleProject('lumora://project/a', '项目A'));
    await settle(10);
    editor.addObject(createGroupObject()); // A rev1 未保存
    await settle(5); // 防抖窗口内切换 → 旧快照由 open() 排空，不得丢失

    editor.openProject(createSampleProject('lumora://project/b', '项目B'));
    await settle(60);

    // A 的未保存对象已落盘（期望基线 0 → rev1 正常写入）
    const storedA = await store.load('lumora://project/a');
    expect(storedA).not.toBeNull();
    expect(storedA!.revision).toBe(1);
    expect(storedA!.objects.length).toBe(createSampleProject().objects.length + 1);
    // B 首存成功且状态干净（A 的保存结果未污染 B）
    const storedB = await store.load('lumora://project/b');
    expect(storedB).not.toBeNull();
    expect(storedB!.revision).toBe(0);
    expect(states.at(-1)).toBe('clean');
    autosaver.dispose();
  });

  it('首次落盘诚实：先 saving 后 clean，绝不出现未经提交的「已保存」', async () => {
    const { editor, autosaver } = await wired();
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(60);
    // saving 必然出现（提交完成前广播），最终才转 clean
    expect(states).toContain('saving');
    expect(states.at(-1)).toBe('clean');
    autosaver.dispose();
  });

  it('flush 构成排空屏障：首存进行中调用立即等待落盘完成', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await autosaver.flush();
    const stored = await store.load('lumora://project/a');
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(0);
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：保存失败保持脏且不覆盖（AC2 / NFR-003）', () => {
  it('revision 冲突无自动恢复：本地计数追平已存也不覆盖，须显式解决（加载较新版本 / 另存副本）', async () => {
    const { editor, store, autosaver } = await wired();
    // 预置较新的已存内容（revision 5，模拟另一标签页已保存）
    const newer = { ...createSampleProject('lumora://project/a', '较新内容'), revision: 5 };
    expect((await store.save(newer)).ok).toBe(true);

    // 打开的是较旧内容（revision 3）：对账即冲突（不预设已保存）
    editor.openProject({ ...createSampleProject('lumora://project/a', '较旧内容'), revision: 3 });
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    await settle(60);

    const error = states.find((s) => s.status === 'error');
    expect(error).toBeDefined();
    expect(error!.code).toBe('revision-conflict');
    expect(error!.message).toContain('加载较新版本');
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(5);
    expect(stored!.name).toBe('较新内容');

    // 编辑两次使本地 revision 追平并越过已存 5 → 依旧冲突：期望基线是「上次成功保存的 revision」，
    // 本地计数追平不能自动覆盖较新的已存内容（评审阻断项：A 追平后覆盖 B 的数据丢失路径）
    editor.addObject(createGroupObject()); // rev4
    editor.addObject(createGroupObject()); // rev5
    await settle(60);
    expect(states.at(-1)!.status).toBe('error');
    const afterTally = await store.load('lumora://project/a');
    expect(afterTally!.revision).toBe(5);
    expect(afterTally!.name).toBe('较新内容');

    // 显式解决「加载较新版本」：以存储内容为基线重开（resetTo 先重设基线 → 编辑器重开走净态路径）
    const storedAfter = await store.load('lumora://project/a');
    autosaver.resetTo(storedAfter!);
    editor.openProject(storedAfter!);
    await settle(10);
    expect(states.at(-1)!.status).toBe('clean');

    // 解决后正常编辑保存：期望基线 = 已存 5 → 写入 rev6
    editor.addObject(createGroupObject());
    await settle(60);
    const final = await store.load('lumora://project/a');
    expect(final!.revision).toBe(6);
    expect(states.at(-1)!.status).toBe('clean');
    autosaver.dispose();
  });

  it('配额不足：保持脏并广播 quota-exceeded', async () => {
    const { editor, store, autosaver } = await wired();
    // 注入配额错误：save 命中配额异常路径
    const originalSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (project) => {
      // 先真实保存（建立基线），再让后续保存触发配额错误
      const result = await originalSave(project);
      if (result.ok) {
        vi.spyOn(store, 'save').mockImplementation(async () => ({
          ok: false,
          code: 'quota-exceeded' as const,
          message: '本地存储空间不足，保存失败',
        }));
      }
      return result;
    });

    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    editor.addObject(createGroupObject());
    await settle(20); // 第一次保存成功（基线）
    editor.addObject(createGroupObject()); // 新变更 → 保存 → 配额错误
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    await settle(60);

    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'quota-exceeded' });
    // 脏状态保持：内容未丢
    expect(store.load('lumora://project/a')).not.toBeNull();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：在途保存→继续编辑→切换（阻断项回归）', () => {
  it('在途保存挂起期间编辑，随后切换：旧项目以执行时已提交基线落盘，rev2 不丢不冲突', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10); // rev0 首存完成（基线 0）

    // 慢速在途保存：真实写入但延迟返回（模拟大文件落盘），期间继续编辑
    const originalSave = store.save.bind(store);
    const slowSave = vi
      .spyOn(store, 'save')
      .mockImplementationOnce(async (project) => {
        await new Promise((r) => setTimeout(r, 40));
        return originalSave(project);
      });
    editor.addObject(createGroupObject()); // rev1 → 防抖触发在途保存
    await settle(30); // 在途保存挂起中
    editor.addObject(createGroupObject()); // rev2 → 切换时进入 pending
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(100);
    slowSave.mockRestore();

    // 旧 URI 成功结果推进基线 → 排空以执行时基线 CAS → rev2 完整落盘
    const storedA = await store.load('lumora://project/a');
    expect(storedA!.revision).toBe(2);
    expect(storedA!.objects.length).toBe(createSampleProject().objects.length + 2);
    // 新项目首存不受影响
    const storedB = await store.load('lumora://project/b');
    expect(storedB).not.toBeNull();
    autosaver.dispose();
  });

  it('对账（慢速 load）期间的新编辑直接落盘：以存储基线 CAS 写入，不出现「未落盘的假已保存」', async () => {
    const { editor, store, autosaver } = await wired();
    const base = createSampleProject('lumora://project/a');
    expect((await store.save(base)).ok).toBe(true); // 预存 rev0

    // 慢速 load：reconcile 的 await 挂起，期间编辑产生新快照
    const slowLoad = vi
      .spyOn(store, 'load')
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return base;
      });
    editor.openProject(base);
    await settle(5); // reconcile 挂起在慢 load 上
    editor.addObject(createGroupObject()); // rev1
    await settle(80);
    slowLoad.mockRestore();

    // 编辑未因对账的「已保存」而被掩盖：以对账读到的存储基线 CAS 落盘
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(createSampleProject().objects.length + 1);
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：flush 返回类型化结果（关闭/切换阻断判定）', () => {
  it('revision 冲突（含未保存编辑）：flush → {ok:false, code:revision-conflict}', async () => {
    const { editor, store, autosaver } = await wired();
    const newer = { ...createSampleProject('lumora://project/a', '较新内容'), revision: 5 };
    expect((await store.save(newer)).ok).toBe(true);
    editor.openProject({ ...createSampleProject('lumora://project/a', '较旧内容'), revision: 3 });
    await settle(60); // 对账 → 冲突
    editor.addObject(createGroupObject()); // rev4 未保存
    const outcome = await autosaver.flush();
    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    // 存储未被覆盖（CAS 防倒退）
    expect((await store.load('lumora://project/a'))!.revision).toBe(5);
    autosaver.dispose();
  });

  it('配额不足：flush → {ok:false, code:quota-exceeded}，快照保留', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    vi.spyOn(store, 'save').mockImplementationOnce(async () => ({
      ok: false,
      code: 'quota-exceeded' as const,
      message: '本地存储空间不足，保存失败',
    }));
    editor.addObject(createGroupObject());
    const outcome = await autosaver.flush();
    expect(outcome).toMatchObject({ ok: false, code: 'quota-exceeded' });
    expect(autosaver.getRecovery('lumora://project/a')).toBeNull();
    autosaver.dispose();
  });

  it('存储错误（异常）：flush → {ok:false, code:storage-error}，快照保留', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    vi.spyOn(store, 'save').mockImplementationOnce(async () => {
      throw new Error('indexeddb boom');
    });
    editor.addObject(createGroupObject());
    const outcome = await autosaver.flush();
    expect(outcome).toMatchObject({ ok: false, code: 'storage-error' });
    autosaver.dispose();
  });

  it('仅内存模式（store 为 null）：flush → {ok:true}（无可持久化内容，关闭不被阻塞）', async () => {
    const editor = new SceneEditor();
    const autosaver = new ProjectAutosaver(editor, null, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));
    editor.openProject(createSampleProject('lumora://project/a'));
    editor.addObject(createGroupObject());
    expect((await autosaver.flush()).ok).toBe(true);
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：恢复快照（切换/关闭时保存失败的旧项目内容）', () => {
  it('切换排空失败 → 快照保留；重开同 uri 明示恢复快照可用；重试成功后内容落盘', async () => {
    const { editor, store, autosaver } = await wired();
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // rev0 已保存

    // 保存全面失败（模拟配额）：编辑 rev1、rev2，切换时排空失败 → 快照保留
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'quota-exceeded' as const,
      message: '本地存储空间不足，保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1
    editor.addObject(createGroupObject()); // rev2
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    expect(autosaver.getRecovery(A)!.objects.length).toBe(base.objects.length + 2);

    // 恢复可用后重开 A：对账一致但存在恢复快照 → 明示 recovery-available（编辑不清除）
    vi.mocked(store.save).mockRestore();
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'recovery-available' });
    const latched = states.at(-1)!;
    if (latched.status === 'error') expect(latched.message).toContain('恢复快照');
    editor.addObject(createGroupObject()); // 锁存期间编辑
    await settle(20);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'recovery-available' });

    // 显式重试：以已提交基线 CAS 落盘恢复快照，成功清除快照与锁存
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome.ok).toBe(true);
    expect(autosaver.getRecovery(A)).toBeNull();
    const stored = await store.load(A);
    expect(stored!.revision).toBe(2);
    expect(stored!.objects.length).toBe(base.objects.length + 2);
    autosaver.dispose();
  });

  it('clearRecovery（已另存副本等显式决定）：解除锁存并重报真实状态', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A);
    editor.openProject(base);
    await settle(10);
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'recovery-available' });

    autosaver.clearRecovery(A);
    expect(autosaver.getRecovery(A)).toBeNull();
    expect(states.at(-1)).toMatchObject({ status: 'clean' });
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：撤销回到已保存状态即转净', () => {
  it('保存后撤销 → dirty → 再保存 → clean', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    editor.addObject(createGroupObject());
    await settle(60);
    expect((await store.load('lumora://project/a'))!.revision).toBe(1);

    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    editor.undo();
    await settle(60);
    expect(states).toContain('dirty');
    expect(states.at(-1)).toBe('clean');
    expect((await store.load('lumora://project/a'))!.revision).toBe(editor.getProject()!.revision);
    autosaver.dispose();
  });
});
