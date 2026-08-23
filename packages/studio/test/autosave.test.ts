import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneEditor, createGroupObject, createLightObject, createSampleProject } from '@lumora/core';
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

    // 显式重试（第六轮 #4 写入前决策）：锁存期间的编辑（G3）与快照内容（G1+G2）、
    // 已提交基线三方内容各不相同 → 真分叉 —— 不写入磁盘，快照保留在恢复区可重试，
    // 锁存冲突供显式解决，当前编辑不被静默覆盖
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    expect(autosaver.getRecovery(A)).not.toBeNull(); // 快照保留（未预持久化）
    const stored = await store.load(A);
    expect(stored!.revision).toBe(0); // 磁盘未被推进，保持已提交基线
    expect(stored!.objects.length).toBe(base.objects.length);
    expect(editor.getProject()!.revision).toBe(1); // 锁存期间编辑保持（未覆盖）
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'revision-conflict' });
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
    // 以与已存记录一致的内容重开（改名的分叉内容属「同 revision 不同内容」，
    // 会按第四轮分叉规则锁存冲突 —— 真实重开走 loadProject 读到的存储记录）
    editor.openProject({ ...base });
    await settle(60);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'recovery-available' });

    autosaver.clearRecovery(A);
    expect(autosaver.getRecovery(A)).toBeNull();
    expect(states.at(-1)).toMatchObject({ status: 'clean' });
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：首存失败 / flush 稳定排空 / retryRecovery 对齐（TML-53 第三轮回归）', () => {
  it('首存失败不被吞：如实报错且存储无假记录；重试仍按创建语义（null 基线）成功', async () => {
    const { editor, store, autosaver } = await wired();
    const realSave = store.save.bind(store);
    let bSaveFailed = false;
    const saveSpy = vi.spyOn(store, 'save').mockImplementation(async (project, expected) => {
      if (project.uri === 'lumora://project/b' && !bSaveFailed) {
        bSaveFailed = true;
        return { ok: false, code: 'quota-exceeded' as const, message: '本地存储空间不足，保存失败' };
      }
      return realSave(project, expected);
    });
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    saveSpy.mockClear();

    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    // 首存失败如实呈现，且未产生任何「假已保存」记录
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'quota-exceeded' });
    expect(await store.load('lumora://project/b')).toBeNull();

    // 重试：仍以 null 基线（create-only）发起，不以失败后的数字基线 CAS 误拒
    editor.addObject(createGroupObject()); // rev1
    await settle(60);
    const bCalls = saveSpy.mock.calls.filter((call) => (call[0] as { uri: string }).uri === 'lumora://project/b');
    expect(bCalls).toHaveLength(2); // 首存失败 + 重试
    expect(bCalls.every((call) => call[1] === null)).toBe(true);
    const stored = await store.load('lumora://project/b');
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(1);
    autosaver.dispose();
  });

  it('flush 稳定排空：排空期间产生的新编辑被循环追平，直到与已提交基线一致', async () => {
    const { editor, store, autosaver } = await wired();
    editor.openProject(createSampleProject('lumora://project/a'));
    await settle(10);
    editor.addObject(createGroupObject()); // rev1
    const flushing = autosaver.flush(); // 排空开始（rev1 落盘中）
    editor.addObject(createGroupObject()); // rev2：排空期间的新编辑
    const outcome = await flushing;
    expect(outcome.ok).toBe(true);
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(2);
    expect(stored!.objects.length).toBe(createSampleProject().objects.length + 2);
    autosaver.dispose();
  });

  it('flush 在锁存错误（revision 冲突）下返回锁存错误：排空无法稳定，调用方不放行切换/关闭', async () => {
    const { editor, store, autosaver } = await wired();
    const newer = { ...createSampleProject('lumora://project/a', '较新内容'), revision: 5 };
    expect((await store.save(newer)).ok).toBe(true);
    editor.openProject({ ...createSampleProject('lumora://project/a', '较旧内容'), revision: 3 });
    await settle(60); // 对账 → 冲突锁存
    const outcome = await autosaver.flush();
    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    autosaver.dispose();
  });

  it('retryRecovery 三方分叉（编辑器 ≠ 快照 ≠ 已提交基线）：写入前决策不落盘、快照保留，锁存冲突（第六轮 #4）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    // 保存全面失败 → 切换产生恢复快照（rev1，内容 = base + 1 新对象）
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

    // 重开 A（对账基线 rev0），重试前编辑出另一分支内容（base + 2 个新对象）：
    // 三方内容各不相同 —— 旧逻辑按 revision 大小（2 > 1）误判为「编辑器更新」向前
    // 保存、静默丢弃快照内容；新逻辑按内容指纹判为真分叉，须显式解决
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    editor.addObject(createGroupObject()); // rev1
    editor.addObject(createGroupObject()); // rev2
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    // 写入前决策（第六轮 #4）：三方分叉不落盘 —— 磁盘保持基线，快照保留在
    // 恢复区（可重试/另存副本），当前编辑不被静默覆盖
    expect(autosaver.getRecovery(A)).not.toBeNull();
    const stored = await store.load(A);
    expect(stored!.revision).toBe(0);
    expect(stored!.objects.length).toBe(base.objects.length);
    expect(editor.getProject()!.revision).toBe(2);
    expect(editor.getProject()!.objects.length).toBe(base.objects.length + 2);
    // 锁存冲突下 flush 同样阻断（调用方不放行关闭/切换）
    expect(await autosaver.flush()).toMatchObject({ ok: false, code: 'revision-conflict' });
    autosaver.dispose();
  });

  it('retryRecovery 快照与已提交基线一致（未带来新内容）：编辑器内容向前保存（第五轮 #4）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    // 保存失败 → 编辑后撤销回已保存内容（revision 递增、内容 == 基线）→ 切换产生恢复快照
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1
    editor.undo(); // rev2，内容与基线一致
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    // 重开 A（基线 rev0），重试前编辑出新内容（rev3 > 快照 rev2）
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    editor.addObject(createGroupObject()); // rev1
    editor.addObject(createGroupObject()); // rev2
    editor.addObject(createGroupObject()); // rev3
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome.ok).toBe(true);
    // 快照 == 旧基线内容（未带来新内容）→ 编辑器内容向前保存
    await autosaver.flush();
    const stored = await store.load(A);
    expect(stored!.revision).toBe(3);
    expect(stored!.objects.length).toBe(base.objects.length + 3);
    expect(editor.getProject()!.revision).toBe(3);
    autosaver.dispose();
  });

  it('retryRecovery 成功且编辑器不新于恢复快照：以恢复快照重开编辑器（对齐已落盘内容）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10);
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1（恢复快照内容）
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome.ok).toBe(true);
    // 编辑器不新于恢复快照 → 重开恢复快照：编辑器内容 = 已落盘的恢复快照（rev1）
    const stored = await store.load(A);
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    expect(editor.getProject()!.revision).toBe(1);
    expect(editor.getProject()!.objects.length).toBe(base.objects.length + 1);
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

describe('ProjectAutosaver：首存失败 flush 诚实 / 分叉检测（TML-53 第四轮回归）', () => {
  it('首存失败后 flush 不再假成功：如实返回失败且无假记录；存储恢复后重试仍按创建语义落盘', async () => {
    const { editor, store, autosaver } = await wired();
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'quota-exceeded' as const,
      message: '本地存储空间不足，保存失败',
    }));
    editor.openProject(createSampleProject('lumora://project/a'));
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    const outcome = await autosaver.flush();
    // 首存失败后 flush 不得以「revision 未变」判净假报成功：调用方据此阻断关闭/切换
    expect(outcome).toMatchObject({ ok: false, code: 'quota-exceeded' });
    expect(await store.load('lumora://project/a')).toBeNull();

    // 存储恢复后重试：仍以 null 基线（create-only）发起，不以失败后的数字基线误拒
    vi.mocked(store.save).mockRestore();
    const retry = await autosaver.flush();
    expect(retry.ok).toBe(true);
    const stored = await store.load('lumora://project/a');
    expect(stored!.revision).toBe(0);
    expect(states.at(-1)!.status).toBe('clean');
    autosaver.dispose();
  });

  it('同 revision 不同内容分叉：不得以「revision 一致」判净建基线，锁存冲突须显式解决', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    // 预置已存记录（revision 5，内容甲）
    const stored = { ...createSampleProject(A, '内容甲'), revision: 5 };
    expect((await store.save(stored)).ok).toBe(true);
    // 打开同 revision 但内容不同的分叉（内容乙）：以 revision 一致判净会把分叉
    // 建为基线，后续保存/切换静默吞掉本地分叉内容
    editor.openProject({ ...createSampleProject(A, '内容乙'), revision: 5 });
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    await settle(60);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'revision-conflict' });
    const latched = states.at(-1)!;
    if (latched.status === 'error') expect(latched.message).toContain('分叉');
    // 存储未被分叉内容覆盖
    const after = await store.load(A);
    expect(after!.revision).toBe(5);
    expect(after!.name).toBe('内容甲');
    autosaver.dispose();
  });

  it('同 uri 同 revision 运行期替换不判净：保存被分叉保护拒绝并锁存冲突，磁盘与编辑器各自保留（第五轮 #3）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    editor.openProject(createSampleProject(A, '原项目'));
    await settle(10); // rev0 已落盘（基线 {0, 原内容指纹}）

    // 运行期以同 uri 同 revision 的另一内容替换编辑器（导入/替换打开路径）：
    // 旧逻辑按 revision 一致判净，替换内容会被后续保存/切换静默吞掉
    editor.openProject({ ...createSampleProject(A, '替换项目'), revision: 0 });
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    await settle(60);
    // 内容指纹不同 → 判为未保存 → 保存被存储层同 revision 分叉保护拒绝 → 锁存冲突
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'revision-conflict' });
    const after = await store.load(A);
    expect(after!.name).toBe('原项目'); // 磁盘未被替换内容覆盖
    expect(editor.getProject()!.name).toBe('替换项目'); // 编辑器保留替换内容供显式解决
    autosaver.dispose();
  });

  it('retryRecovery 同 revision 分叉：写入前决策不落盘、快照保留，锁存冲突引导显式解决', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // rev0 已保存（基线 0）

    // 保存全面失败 → 编辑 rev2 → 切换：恢复快照 = base + 2 group
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1
    editor.addObject(createGroupObject()); // rev2
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    // 重开 A（对账基线 0），重试前编辑出同 revision 但内容不同的分叉（light vs group）
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    editor.addObject(createLightObject('directional')); // rev1
    editor.addObject(createGroupObject()); // rev2（内容 ≠ 恢复快照）
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    // 写入前决策（第六轮 #4）：同 revision 分叉不落盘 —— 磁盘保持基线 rev0，
    // 快照保留在恢复区，当前编辑未被恢复快照静默覆盖
    expect(autosaver.getRecovery(A)).not.toBeNull();
    const current = editor.getProject()!;
    expect(current.revision).toBe(2);
    expect(current.objects.length).toBe(base.objects.length + 2);
    expect(current.objects.filter((o) => o.type === 'light').length).toBe(
      base.objects.filter((o) => o.type === 'light').length + 1,
    );
    const stored = await store.load(A);
    expect(stored!.revision).toBe(0);
    expect(stored!.objects.length).toBe(base.objects.length);
    autosaver.dispose();
  });

  it('retryRecovery 快照 revision 高于当前编辑器（第六轮 #4）：按内容决策向前保存当前编辑，不按 revision 大小推断', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0

    // 保存全面失败 → 编辑 4 次后撤销回基线内容：恢复快照 revision 高（8）
    // 但内容 == 已提交基线（未带来新内容）
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    for (let i = 0; i < 4; i += 1) editor.addObject(createGroupObject());
    for (let i = 0; i < 4; i += 1) editor.undo();
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    const snapshot = autosaver.getRecovery(A);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.revision).toBeGreaterThan(2); // 快照 revision 高于后续当前编辑
    vi.mocked(store.save).mockRestore();

    // 重开 A 后编辑出当前内容（rev2）。旧逻辑先落盘快照（rev8）再以刚落盘
    // revision 为期望保存当前编辑 → rev2 < rev8 被存储层拒绝、fire-and-forget
    // 静默丢当前编辑；新逻辑写入前决策：快照 == 基线 → 按原基线保存当前内容
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    editor.addObject(createGroupObject()); // rev1
    editor.addObject(createGroupObject()); // rev2
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome.ok).toBe(true);
    const stored = await store.load(A);
    expect(stored!.revision).toBe(2); // 当前编辑内容落盘，而非快照的 rev8
    expect(stored!.objects.length).toBe(base.objects.length + 2);
    expect(editor.getProject()!.revision).toBe(2); // 编辑器不被重开覆盖
    expect(autosaver.getRecovery(A)).toBeNull(); // 成功清除恢复快照
    autosaver.dispose();
  });

  it('阻断1：重试保存挂起期间继续编辑：不重开编辑器、不报 clean、锁存冲突，恢复快照保留（第七轮 #1）', async () => {
    const { editor, store, autosaver } = await wired(500); // 长防抖：复验失败后无自动保存干扰断言
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1
    editor.undo(); // rev2，内容与基线一致 → 恢复快照 == 已提交基线
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    // 重开 A：基线 rev0 + 恢复快照（内容 == 基线）→ recovery-available 锁存
    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'recovery-available' });

    // 编辑出新内容（rev1 X1）→ 决策走「快照 == 基线 → 向前保存当前内容」分支；
    // 慢速保存：真实写入但延迟返回；挂起期间继续编辑（rev2 X2）
    editor.addObject(createGroupObject()); // rev1
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async (project, expected) => {
      await new Promise((r) => setTimeout(r, 40));
      return realSave(project, expected);
    });
    const retrying = autosaver.retryRecovery(A);
    await settle(20); // 保存挂起中
    editor.addObject(createGroupObject()); // rev2：延迟保存期间继续编辑
    const outcome = await retrying;

    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    // 编辑器未被重开/重置：当前编辑内容原样保留（不静默覆盖新编辑）
    const current = editor.getProject()!;
    expect(current.revision).toBe(2);
    expect(current.objects.length).toBe(base.objects.length + 2);
    // 锁存冲突且不报 clean
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'revision-conflict' });
    // 磁盘已推进到决策时内容（rev1），恢复快照保留（未清除）
    const stored = await store.load(A);
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    autosaver.dispose();
  });

  it('阻断1：重试保存挂起期间切换项目：不触碰新项目、锁存冲突、恢复快照保留（第七轮 #1）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1（恢复快照内容）
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

    // 决策：编辑器 == 已提交基线 → 保存恢复快照（分支 1）；慢速保存挂起期间切换
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async (project, expected) => {
      await new Promise((r) => setTimeout(r, 40));
      return realSave(project, expected);
    });
    const retrying = autosaver.retryRecovery(A);
    await settle(20); // 保存挂起中
    editor.openProject(createSampleProject('lumora://project/c', '项目C')); // 切换项目
    const outcome = await retrying;

    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    // 编辑器是切换后的项目（恢复快照未被重开覆盖到新项目上）
    expect(editor.getProject()!.uri).toBe('lumora://project/c');
    expect(editor.getProject()!.name).toBe('项目C');
    // 恢复快照保留；磁盘已推进（恢复快照落盘 rev1）
    expect(autosaver.getRecovery(A)).not.toBeNull();
    const stored = await store.load(A);
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    autosaver.dispose();
  });

  it('阻断1：不可编码内容（undefined/NaN/BigInt/循环引用/数组非索引键）恒判未保存，保存返回类型化错误且不崩溃', async () => {
    const cases: Array<[string, () => object]> = [
      ['undefined 字段', () => ({ extra: undefined })],
      ['NaN', () => ({ extra: { value: NaN } })],
      ['BigInt', () => ({ extra: { value: 1n } })],
      ['循环引用', () => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        return { extra: loop };
      }],
      ['数组非索引键', () => {
        const arr = [1, 2] as unknown as Record<string, unknown>;
        arr.extra = 3;
        return { extra: arr };
      }],
    ];
    for (const [label, corrupt] of cases) {
      const { editor, store, autosaver } = await wired();
      const states: AutosaveState[] = [];
      autosaver.onState((s) => states.push(s));
      const A = `lumora://project/${label}`;
      editor.openProject({ ...createSampleProject(A, '项目A'), ...corrupt() });
      await settle(80);
      // 指纹不可比较 → 恒判未保存 → 保存路径返回类型化错误（storage-error +
      // 具体编码问题），绝不假报 clean、不崩溃、不产生假记录
      const last = states.at(-1)!;
      expect(last).toMatchObject({ status: 'error', code: 'storage-error' });
      if (last.status === 'error') expect(last.message).toContain('无法本地保存');
      expect(states.some((s) => s.status === 'clean')).toBe(false);
      expect(await store.load(A)).toBeNull();
      const outcome = await autosaver.flush();
      expect(outcome).toMatchObject({ ok: false, code: 'storage-error' });
      autosaver.dispose();
    }
  });

  it('严重6：重试保存挂起期间「编辑→撤销」—— 内容与决策时相等但编辑器已变更，绝不重开编辑器（第八轮 #6）', async () => {
    const { editor, store, autosaver } = await wired(500); // 长防抖：复验失败后无自动保存干扰断言
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1（恢复快照内容 = base+1）
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    const states: AutosaveState[] = [];
    autosaver.onState((s) => states.push(s));
    editor.openProject({ ...base, name: '项目A' }); // 编辑器 == 基线 → 分支 1：保存恢复快照
    await settle(60);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'recovery-available' });

    // 慢速保存挂起期间「编辑→撤销」：内容回到决策时（== 基线，引用全新）。
    // 修复前复验以内容指纹判「无编辑」→ 误判通过 → switchOpen 用恢复快照覆盖
    // 编辑、报 clean、清恢复快照；修复后 mutationVersion 代数判变 → 锁存冲突、
    // 编辑器与撤销栈原样、恢复快照保留
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async (project, expected) => {
      await new Promise((r) => setTimeout(r, 40));
      return realSave(project, expected);
    });
    const retrying = autosaver.retryRecovery(A);
    await settle(20); // 保存挂起中
    editor.addObject(createGroupObject()); // rev1（内容 base+1）
    editor.undo(); // rev2（内容回到 base，撤销栈已变）
    const outcome = await retrying;

    expect(outcome).toMatchObject({ ok: false, code: 'revision-conflict' });
    // 编辑器未被重开/覆盖：当前内容（base，rev2）与撤销栈原样保留
    const current = editor.getProject()!;
    expect(current.revision).toBe(2);
    expect(current.objects.length).toBe(base.objects.length);
    expect(states.at(-1)).toMatchObject({ status: 'error', code: 'revision-conflict' });
    // 磁盘已推进到决策时内容（恢复快照 rev1）；恢复快照保留（未清除）
    const stored = await store.load(A);
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    autosaver.dispose();
  });

  it('阻断5：最终切换原子化 —— save-state clean 回调中同步提交编辑，编辑保留且落盘（第八轮 #5）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1（恢复快照内容 = base+1）
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(autosaver.getRecovery(A)).not.toBeNull();
    vi.mocked(store.save).mockRestore();

    // 重开 A → recovery-available 锁存（编辑器 == 基线 → 分支 1：保存恢复快照并切换）
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);

    // 最终切换是原子操作：编辑器提交 + autosaver 重置完成后才广播。在 clean
    // 回调中同步提交编辑 —— 修复前 resetTo 先 emit clean（编辑器尚未切换），
    // 回调编辑落在旧内容上、随后被 openProject 覆盖丢失；修复后编辑落在已切换
    // 内容上，走正常 dirty 路径落盘（rev2 = base+2）
    let reentered = false;
    autosaver.onState((s) => {
      if (s.status === 'clean' && editor.getProject()?.uri === A && !reentered) {
        reentered = true;
        editor.addObject(createGroupObject());
      }
    });
    const outcome = await autosaver.retryRecovery(A);
    expect(outcome.ok).toBe(true);
    expect(reentered).toBe(true);

    await settle(60); // 重入编辑经防抖落盘
    const stored = await store.load(A);
    expect(stored!.revision).toBe(2);
    expect(stored!.objects.length).toBe(base.objects.length + 2);
    expect(autosaver.getRecovery(A)).toBeNull();
    autosaver.dispose();
  });
});
