import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneEditor, createGroupObject, createLightObject, createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { ProjectAutosaver } from '../src/persistence/autosave';
import type { AutosaveState } from '../src/persistence/autosave';
import { ProjectStore } from '../src/persistence/project-store';
import type { ProjectStorage } from '../src/persistence/project-storage';

const DB = 'lumora-test-autosave';
/** 便捷读取/列表（第十七轮严重 4：list/load 收口为类型化结果后直接取数据字段） */
async function loadStored(store: ProjectStorage, uri: string): Promise<Project | null> {
  const result = await store.load(uri);
  return result.ok ? result.project : null;
}

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
    const stored = await loadStored(store, 'lumora://project/a');
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
    const stored = await loadStored(store, 'lumora://project/a');
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
    const stored = await loadStored(store, 'lumora://project/a');
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
    const storedA = await loadStored(store, 'lumora://project/a');
    expect(storedA).not.toBeNull();
    expect(storedA!.revision).toBe(1);
    expect(storedA!.objects.length).toBe(createSampleProject().objects.length + 1);
    // B 首存成功且状态干净（A 的保存结果未污染 B）
    const storedB = await loadStored(store, 'lumora://project/b');
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
    const stored = await loadStored(store, 'lumora://project/a');
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
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.revision).toBe(5);
    expect(stored!.name).toBe('较新内容');

    // 编辑两次使本地 revision 追平并越过已存 5 → 依旧冲突：期望基线是「上次成功保存的 revision」，
    // 本地计数追平不能自动覆盖较新的已存内容（评审阻断项：A 追平后覆盖 B 的数据丢失路径）
    editor.addObject(createGroupObject()); // rev4
    editor.addObject(createGroupObject()); // rev5
    await settle(60);
    expect(states.at(-1)!.status).toBe('error');
    const afterTally = await loadStored(store, 'lumora://project/a');
    expect(afterTally!.revision).toBe(5);
    expect(afterTally!.name).toBe('较新内容');

    // 显式解决「加载较新版本」：以存储内容为基线重开（resetTo 先重设基线 → 编辑器重开走净态路径）
    const storedAfter = await loadStored(store, 'lumora://project/a');
    autosaver.resetTo(storedAfter!);
    editor.openProject(storedAfter!);
    await settle(10);
    expect(states.at(-1)!.status).toBe('clean');

    // 解决后正常编辑保存：期望基线 = 已存 5 → 写入 rev6
    editor.addObject(createGroupObject());
    await settle(60);
    const final = await loadStored(store, 'lumora://project/a');
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
    expect(await loadStored(store, 'lumora://project/a')).not.toBeNull();
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
    const storedA = await loadStored(store, 'lumora://project/a');
    expect(storedA!.revision).toBe(2);
    expect(storedA!.objects.length).toBe(createSampleProject().objects.length + 2);
    // 新项目首存不受影响
    const storedB = await loadStored(store, 'lumora://project/b');
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
        return { ok: true, project: base };
      });
    editor.openProject(base);
    await settle(5); // reconcile 挂起在慢 load 上
    editor.addObject(createGroupObject()); // rev1
    await settle(80);
    slowLoad.mockRestore();

    // 编辑未因对账的「已保存」而被掩盖：以对账读到的存储基线 CAS 落盘
    const stored = await loadStored(store, 'lumora://project/a');
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
    expect((await loadStored(store, 'lumora://project/a'))!.revision).toBe(5);
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
    const stored = await loadStored(store, A);
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
    expect(await loadStored(store, 'lumora://project/b')).toBeNull();

    // 重试：仍以 null 基线（create-only）发起，不以失败后的数字基线 CAS 误拒
    editor.addObject(createGroupObject()); // rev1
    await settle(60);
    const bCalls = saveSpy.mock.calls.filter((call) => (call[0] as { uri: string }).uri === 'lumora://project/b');
    expect(bCalls).toHaveLength(2); // 首存失败 + 重试
    expect(bCalls.every((call) => call[1] === null)).toBe(true);
    const stored = await loadStored(store, 'lumora://project/b');
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
    const stored = await loadStored(store, 'lumora://project/a');
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
    const stored = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
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
    expect((await loadStored(store, 'lumora://project/a'))!.revision).toBe(1);

    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    editor.undo();
    await settle(60);
    expect(states).toContain('dirty');
    expect(states.at(-1)).toBe('clean');
    expect((await loadStored(store, 'lumora://project/a'))!.revision).toBe(editor.getProject()!.revision);
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
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();

    // 存储恢复后重试：仍以 null 基线（create-only）发起，不以失败后的数字基线误拒
    vi.mocked(store.save).mockRestore();
    const retry = await autosaver.flush();
    expect(retry.ok).toBe(true);
    const stored = await loadStored(store, 'lumora://project/a');
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
    const after = await loadStored(store, A);
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
    const after = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
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
      expect(await loadStored(store, A)).toBeNull();
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
    const stored = await loadStored(store, A);
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
    const stored = await loadStored(store, A);
    expect(stored!.revision).toBe(2);
    expect(stored!.objects.length).toBe(base.objects.length + 2);
    expect(autosaver.getRecovery(A)).toBeNull();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：切换广播守卫与代际失效（第九轮 #1 阻断回归）', () => {
  it('switchOpen 整轮切换只广播一次最终态 —— save-state 序列无中间态', async () => {
    const { editor, autosaver } = await wired();
    const A = 'lumora://project/a';
    editor.openProject(createSampleProject(A, '项目A'));
    await settle(60); // 基线落盘

    // 切换中编辑器 openProject 的整轮事件分发会触发 changed() 链（pending 更新、
    // 定时器）—— 修复前 resetTo 与分发期间的中间态泄漏到监听器（dirty/clean
    // 抖动、基线已换但编辑器未切的错位状态）；修复后广播守卫吸收全部中间态，
    // 分发返回后以最新编辑器状态统一发布一次最终态
    const seq: AutosaveState[] = [];
    autosaver.onState((s) => seq.push(s));
    const B = createSampleProject('lumora://project/b', '项目B');
    autosaver.switchOpen(B);

    expect(seq.length).toBe(1);
    expect(seq[0].status).toBe('clean');
    expect(editor.getProject()?.uri).toBe('lumora://project/b');
    autosaver.dispose();
  });

  it('switchOpen 编辑器提交失败 —— 零广播、autosaver 状态回滚、异常上抛', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60);

    // 结构校验失败（activeSceneId 指向不存在的场景）→ openProject 原子失败：
    // 修复前 resetTo 已先执行，失败后 autosaver 与编辑器状态错位（基线换到 B、
    // 编辑器仍是 A，后续保存按 B 的基线 CAS 全部失败）；修复后整轮回滚并上抛
    const broken = createSampleProject('lumora://project/b', '项目B');
    (broken as { activeSceneId: string }).activeSceneId = '不存在的场景';

    const seq: AutosaveState[] = [];
    autosaver.onState((s) => seq.push(s));
    expect(() => autosaver.switchOpen(broken)).toThrow();
    expect(seq).toEqual([]); // 失败路径零广播
    expect(editor.getProject()?.uri).toBe(A); // 编辑器保持原项目
    expect(autosaver.getRecovery('lumora://project/b')).toBeNull();

    // 回滚后自动保存照常工作：新编辑按 A 的原基线落盘（rev1）
    editor.addObject(createGroupObject());
    await settle(60);
    const stored = await loadStored(store, A);
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    autosaver.dispose();
  });

  it('双状态监听器同步重入 —— 陈旧分发终止，监听器不再收到倒置状态', async () => {
    const { editor, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60); // 基线落盘

    // 监听器 1 在最终 clean 广播中同步提交编辑（嵌套 dirty 分发立即开始）；
    // 修复前外层分发不终止 —— 监听器 2 在嵌套 dirty 之后仍收到陈旧的 clean
    // （倒置序列 dirty → clean）；修复后代际失效终止外层分发，监听器 2 只看到
    // 嵌套的最新状态，陈旧 clean 永不送达
    const seq2: AutosaveState[] = [];
    let reentered = false;
    autosaver.onState((s) => {
      if (s.status === 'clean' && !reentered) {
        reentered = true;
        editor.addObject(createGroupObject());
      }
    });
    autosaver.onState((s) => seq2.push(s));

    editor.addObject(createGroupObject()); // 触发一次保存 → 完成后广播 clean
    await settle(120);
    expect(reentered).toBe(true);

    // 监听器 2 序列中不得出现 dirty 紧随其后的陈旧 clean（倒置）；
    // 合法落盘序列为 dirty → saving → clean，clean 后无再起的 dirty
    const statuses = seq2.map((s) => s.status);
    for (let i = 0; i < statuses.length - 1; i += 1) {
      expect([statuses[i], statuses[i + 1]]).not.toEqual(['dirty', 'clean']);
    }
    // 重入编辑保留（两次编辑都在，未被陈旧分发覆盖）
    expect(editor.getProject()?.objects.length).toBe(base.objects.length + 2);
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：switchOpen 失败回滚恢复防抖保存（第十轮 #1 严重回归）', () => {
  it('dirty → 切换失败 → 不再编辑 → 自动落盘仍发生（存储 revision 推进，保存恰一次）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60); // 基线落盘（rev0）
    const saveSpy = vi.spyOn(store, 'save');
    saveSpy.mockClear();

    editor.addObject(createGroupObject()); // dirty（防抖 20ms 窗口内）
    await settle(5);

    // 切换到结构损坏的项目：openProject 原子失败并上抛；修复前 resetTo 的
    // cancelTimer 使旧项目的防抖保存被永久取消 —— 不再编辑后存储停留在 rev0
    const broken = createSampleProject('lumora://project/b', '项目B');
    (broken as { activeSceneId: string }).activeSceneId = '不存在的场景';
    expect(() => autosaver.switchOpen(broken)).toThrow();
    expect(editor.getProject()?.uri).toBe(A);

    // 不再编辑：修复后回滚重建真实存在的待执行 timer，防抖窗口过后旧内容
    // 自动落盘（第十二轮一般 #7：仅恢复 reset 前真实存在的 timer，保存恰好一次）
    await settle(100);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const stored = await loadStored(store, A);
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    saveSpy.mockRestore();
    autosaver.dispose();
  });

  it('dirty 且在途保存（in-flight）时回滚不重复调度：释放阻塞后保存调用恰一次，落盘完成', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60);

    // 在途保存：慢速保存挂起期间切换失败 —— 回滚后不得重复 scheduleSave
    // （第十二轮一般 #7：in-flight 单独跟踪，链中任务继续推进基线），
    // 释放阻塞后断言调用次数仍为 1
    editor.addObject(createGroupObject());
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const realSave = store.save.bind(store);
    const slowSave = vi
      .spyOn(store, 'save')
      .mockImplementation(async (incoming, expected) => {
        await gate;
        return realSave(incoming, expected);
      });
    await settle(40); // debounce 到期 → runSave → 任务开始（saveQueued 清位，in-flight）
    expect(slowSave).toHaveBeenCalledTimes(1);

    const broken = createSampleProject('lumora://project/b', '项目B');
    (broken as { activeSceneId: string }).activeSceneId = '不存在的场景';
    expect(() => autosaver.switchOpen(broken)).toThrow();

    releaseSave();
    await settle(80);
    // 释放阻塞后调用次数不翻倍：在途任务是唯一一次保存
    expect(slowSave).toHaveBeenCalledTimes(1);
    const stored = await loadStored(store, A);
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(1);
    slowSave.mockRestore();
    autosaver.dispose();
  });

  it('保存失败后未再编辑（timer/queued/in-flight 皆无）→ 切换失败回滚重新调度，自动重试落盘', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60);

    // 保存失败（配额错误）：runSave 执行完失败路径 —— timer 已清、queued/in-flight
    // 皆无，内容仍未落盘（第十轮 #1 严重场景：保存失败后未再编辑）
    const failingSave = vi
      .spyOn(store, 'save')
      .mockImplementationOnce(async () => ({ ok: false, code: 'quota-exceeded', message: '配额不足' } as const));
    editor.addObject(createGroupObject()); // dirty
    await settle(40); // debounce 到期 → 保存失败 → error 状态
    expect(failingSave).toHaveBeenCalledTimes(1);
    expect((await loadStored(store, A))!.revision).toBe(0); // 旧内容未落盘
    failingSave.mockRestore();

    // 切换失败 → 回滚：三个调度态皆无但内容未保存 → 重新调度（第十二轮一般 #7）
    const broken = createSampleProject('lumora://project/b', '项目B');
    (broken as { activeSceneId: string }).activeSceneId = '不存在的场景';
    const saveSpy = vi.spyOn(store, 'save');
    expect(() => autosaver.switchOpen(broken)).toThrow();
    expect(editor.getProject()?.uri).toBe(A);

    // 不再编辑：防抖窗口过后保存自动重试成功（修复前停留在 rev0）
    await settle(100);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const stored = await loadStored(store, A);
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    saveSpy.mockRestore();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：保存失败错误广播与监听器同步重入（第十三轮严重 #4）', () => {
  it('保存失败监听器同步失败 switchOpen：错误广播在 saveInFlight 清零之后，回滚重新调度不停止自动保存', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60);

    // 保存失败（存储错误）：错误监听器在广播中同步执行失败的 switchOpen。
    // 修复前广播发生在 applySaveResult 内（saveInFlight 仍为 true）→ 回滚捕获
    // prevInFlight=true 不重调度，随后 finally 清零 —— 自动保存永久停止；
    // 修复后广播移到 saveInFlight 清零之后 → 回滚看到 prevInFlight=false，
    // 旧项目未落盘且无调度 → 重新调度
    const failingSave = vi
      .spyOn(store, 'save')
      .mockImplementationOnce(async () => ({ ok: false, code: 'storage-error', message: '存储不可用' } as const));
    const broken = createSampleProject('lumora://project/b', '项目B');
    (broken as { activeSceneId: string }).activeSceneId = '不存在的场景';
    autosaver.onState((s) => {
      if (s.status === 'error') {
        try {
          autosaver.switchOpen(broken);
        } catch {
          // 失败 switchOpen：回滚 autosaver 状态并上抛（正常防御路径）
        }
      }
    });
    editor.addObject(createGroupObject()); // dirty
    await settle(40); // debounce 到期 → 保存失败 → error 广播（含监听器同步重入）
    expect(failingSave).toHaveBeenCalledTimes(1);
    expect((await loadStored(store, A))!.revision).toBe(0); // 旧内容未落盘
    failingSave.mockRestore();

    // 不再编辑：回滚分支重新调度后自动重试落盘（修复前停止在 rev0）
    const saveSpy = vi.spyOn(store, 'save');
    await settle(100);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const stored = await loadStored(store, A);
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(base.objects.length + 1);
    saveSpy.mockRestore();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：慢保存失败的延迟错误广播按 {uri, session} 新鲜度校验（第十四轮严重 3）', () => {
  it('慢失败后切换 B：A 的保存失败不覆盖 B 的真实状态，不广播 error', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60); // 首存完成（rev0 clean）

    // A 的保存慢速挂起（in-flight）：切换前任务已开始执行
    editor.addObject(createGroupObject()); // dirty
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const realSave = store.save.bind(store);
    const slowSave = vi.spyOn(store, 'save').mockImplementation(async (_incoming, _expected) => {
      await gate;
      slowSave.mockImplementation(realSave); // 仅本次失败，后续排空/对账走真实存储
      return { ok: false, code: 'storage-error', message: '存储不可用' };
    });
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    await settle(40); // debounce 到期 → runSave → 任务开始（保存挂起中）
    expect(slowSave).toHaveBeenCalledTimes(1);

    // 挂起期间切换到 B（resetTo 递增会话代、currentUri 指向 B）
    autosaver.switchOpen(createSampleProject('lumora://project/b', '项目B'));
    await settle(10);

    releaseSave(); // A 的慢保存失败
    await settle(100);
    // 修复前无条件广播 error，覆盖 B 的真实状态；修复后仅在目标仍 fresh 时
    // 广播 —— A 已不是当前项目（会话代递增），失败绝不回弹
    expect(states).not.toContain('error');
    // switchOpen 丢弃 A 的 pending（排空由调用方 flush 负责）：A 保持首存基线，
    // 失败不产生假记录；这正是「旧项目慢失败不覆盖任何状态」的落点
    const storedA = await loadStored(store, A);
    expect(storedA).not.toBeNull();
    expect(storedA!.revision).toBe(0);
    expect(storedA!.objects.length).toBe(base.objects.length);
    // B 的对账完成：真实状态 clean（不被 A 的失败覆盖）
    expect(states.at(-1)).toBe('clean');
    expect(editor.getProject()?.uri).toBe('lumora://project/b');
    slowSave.mockRestore();
    autosaver.dispose();
  });

  it('慢失败后关闭 A：编辑器关闭（会话代递增、currentUri 清空）后不广播 error', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60); // 首存完成（rev0 clean）

    editor.addObject(createGroupObject()); // dirty
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const realSave = store.save.bind(store);
    const slowSave = vi.spyOn(store, 'save').mockImplementation(async (_incoming, _expected) => {
      await gate;
      slowSave.mockImplementation(realSave); // 仅本次失败
      return { ok: false, code: 'storage-error', message: '存储不可用' };
    });
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    await settle(40); // 任务开始（保存挂起中）
    expect(slowSave).toHaveBeenCalledTimes(1);

    // 挂起期间关闭 A（编辑器关闭事件：session 递增、currentUri 清空、广播 idle）
    autosaver.changed(null);
    expect(states.at(-1)).toBe('idle');

    releaseSave(); // A 的慢保存失败
    await settle(100);
    // 关闭后不得回弹错误状态（修复前无条件广播 error 覆盖 idle）
    expect(states).not.toContain('error');
    // 关闭时排空任务以真实存储重试成功：A 的未保存内容最终落盘（不丢）
    const storedA = await loadStored(store, A);
    expect(storedA).not.toBeNull();
    expect(storedA!.revision).toBe(1);
    expect(storedA!.objects.length).toBe(base.objects.length + 1);
    slowSave.mockRestore();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：队列占位期间 A→B→A 的会话代捕获（第十五轮严重 3）', () => {
  it('慢 reconcile 占队列时旧 A1 保存任务在切回 A 后作废：不写回已丢弃快照、不推进基线（修复前误判 fresh 写回）', async () => {
    const { editor, store, autosaver } = await wired(20);
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(60); // 首轮对账完成：rev0 落盘，队列空

    // 慢 reconcile 占队列（setStore 重复接线会入队 reconcile，load 延迟 300ms）：
    // A1 入队后排在其后，执行被推迟到 A→B→A0 切换完成之后
    const realLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementationOnce(async (uri) => {
      await new Promise((r) => setTimeout(r, 300));
      return realLoad(uri);
    });
    autosaver.setStore(store);

    // 编辑 A → rev1 → 防抖到点 → A1 入队（入队时捕获会话代 N）
    editor.addObject(createGroupObject());
    const saveSpy = vi.spyOn(store, 'save');
    await settle(40);

    // 慢 reconcile 挂起期间 A→B→A0（switchOpen 保留 A0 的 rev0 基线、无排空
    // 入队；会话代 N→N+2，currentUri 回到 A）：修复前 A1 执行时读到的
    // this.session 已是新代、uri 也是 A → 误判 fresh → 把已丢弃快照写回并
    // 推进基线；修复后以入队时代（N）复验 → 直接作废，一次保存都不发生
    autosaver.switchOpen(createSampleProject('lumora://project/b', '项目B'));
    autosaver.switchOpen({ ...base }); // A0 = 与存储一致的 rev0 内容（基线 rev0）
    await settle(400);

    // 修复前 A1 会写回一次（X rev1、基线推进到 1）；修复后作废零写回
    const aSaves = saveSpy.mock.calls.filter(([p]) => p.uri === A);
    expect(aSaves.length).toBe(0);
    // 存储仍是首轮对账的 rev0 原内容（未被已丢弃快照覆盖）
    const storedA = await loadStored(store, A);
    expect(storedA).not.toBeNull();
    expect(storedA!.revision).toBe(0);
    expect(storedA!.objects.length).toBe(base.objects.length);
    // 编辑器保持 A0 打开（未被打断）
    expect(editor.getProject()!.uri).toBe(A);
    expect(editor.getProject()!.revision).toBe(0);
    saveSpy.mockRestore();
    autosaver.dispose();
  });

  it('慢 reconcile 占队期间切换 + 新会话连续编辑：旧会话排队任务不吞新会话占位、不重复排队、不重放旧快照、不假冲突（第十七轮严重 3）', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const saveSpy = vi.spyOn(store, 'save');
    const realLoad = store.load.bind(store);
    const realSave = store.save.bind(store);
    let delayFirstLoad = true;
    let delayDrain = true;
    const A_URI = 'lumora://project/a';
    // 首轮 reconcile 的 load 延迟 120ms（占住串行链）；切换排空（A 的保存）
    // 再延迟 150ms —— 旧会话保存任务执行时新会话任务仍在排队（吞占位窗口）
    store.load = async (uri) => {
      if (delayFirstLoad) {
        delayFirstLoad = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      return realLoad(uri);
    };
    store.save = async (p, expected) => {
      if (p.uri === A_URI && delayDrain) {
        delayDrain = false;
        await new Promise((r) => setTimeout(r, 150));
      }
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));

    const projectA = createSampleProject('lumora://project/a', '项目A');
    const projectB = createSampleProject('lumora://project/b', '项目B');
    const B_URI = projectB.uri;
    editor.openProject(projectA);
    await settle(5);
    editor.addObject(createGroupObject()); // A rev1
    await settle(25); // 防抖到点：A 会话保存任务入队（链被慢 reconcile 占用）
    editor.openProject(projectB);
    await settle(5);
    editor.addObject(createGroupObject()); // B rev1
    await settle(25); // B 会话保存任务入队（占位 { 会话 B, ticket }）
    await settle(150); // 慢 reconcile 结束、旧 A 任务已执行（吞占位窗口）
    editor.addObject(createGroupObject()); // B rev2 —— 修复前此处会重复排队
    await settle(25);
    await settle(250); // 全部排空

    // 修复前：A 旧任务无条件清位 → B 的占位被吞 → B rev2 重复排队（B 保存 3 次）；
    // 修复后占位只被持有者清理 → B 仅 reconcile 首存 + runSave 任务各一次
    const bSaves = saveSpy.mock.calls.filter(([p]) => p.uri === B_URI);
    expect(bSaves.length, '新会话同一防抖只排队一次保存').toBe(2);
    // 无旧快照重放：B 落盘内容始终是 B 的（A 的 rev1 快照不得写入 B）
    const storedB = await loadStored(store, B_URI);
    expect(storedB?.name).toBe('项目B');
    expect(storedB?.objects.length).toBe(createSampleProject().objects.length + 2);
    // 无假冲突：全程无 error 状态广播（旧实现 B 任务以触发时快照执行，
    // 撞上 reconcile 已写入的较新 revision 会报 revision-conflict）
    expect(states).not.toContain('error');
    // 切换/关闭不被错误阻断：flush 立即放行
    expect((await autosaver.flush()).ok).toBe(true);
    // A 的未保存对象仍由切换排空正常落盘
    const storedA = await loadStored(store, projectA.uri);
    expect(storedA?.objects.length).toBe(createSampleProject().objects.length + 1);
    saveSpy.mockRestore();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：flush 任务执行时重读最新内容（第十八轮严重 3）', () => {
  it('慢 reconcile 占队 + 已排队 autosave + flush 等待期间继续编辑：不重放旧快照、无假 revision-conflict、关闭/切换不被阻断', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const saveSpy = vi.spyOn(store, 'save');
    const realLoad = store.load.bind(store);
    let delayFirstLoad = true;
    const A_URI = 'lumora://project/a';
    // 首轮 reconcile 的 load 延迟 120ms 占住串行链：rev1 autosave 与 flush 的
    // 任务都排队等待执行，期间继续编辑产生更新内容（rev2）
    store.load = async (uri) => {
      if (delayFirstLoad) {
        delayFirstLoad = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      return realLoad(uri);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));

    editor.openProject(createSampleProject(A_URI));
    await settle(5);
    editor.addObject(createGroupObject()); // rev1 → 防抖触发 autosave 入队（链被慢 reconcile 占用）
    // 等足防抖 + 余量：runSave 必须先于 flush 入队（[reconcile, runSave, flush]），
    // 修复前 flush 重放捕获的 rev1 才会撞上 runSave 已写入的 rev2 触发假冲突
    await settle(50);
    const flushing = autosaver.flush(); // 队列占用期间 flush：修复前闭包捕获 rev1 快照
    editor.addObject(createGroupObject()); // rev2 —— flush 等待期间继续编辑
    await settle(200); // 慢 reconcile 结束 → runSave 以执行时最新内容落盘 → flush 任务执行
    const outcome = await flushing;

    // 无旧快照重放：A 恰两次落盘（reconcile 首存 + runSave），全部是 rev2 内容；
    // 修复前 flush 用捕获的 rev1 快照第三次落盘（旧 revision 撞已写入的 rev2
    // → 假 revision-conflict 锁存）。逐次检查无 rev1 重放
    const aSaves = saveSpy.mock.calls.filter(([p]) => p.uri === A_URI);
    expect(aSaves.length).toBe(2);
    for (const [p] of aSaves) expect(p.revision).toBe(2);
    // 无假 revision-conflict：不锁存、不广播 error，flush 放行（关闭/切换不被阻断）
    expect(states).not.toContain('error');
    expect(outcome).toEqual({ ok: true });
    // rev2 内容完整落盘
    const storedA = await loadStored(store, A_URI);
    expect(storedA?.revision).toBe(2);
    expect(storedA?.objects.length).toBe(createSampleProject().objects.length + 2);
    saveSpy.mockRestore();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：flush 排队期间会话失效（第十九轮严重 3）', () => {
  it('flush 排队期间项目关闭：任务执行时会话已失效 → 等待 superseding drain 并传播其失败（quota-exceeded），不得映射为成功；恢复快照保留', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realLoad = store.load.bind(store);
    const realSave = store.save.bind(store);
    let delayFirstLoad = true;
    const A_URI = 'lumora://project/a';
    // 首轮 reconcile 的 load 延迟 120ms 占住串行链：flush 任务排队等待执行
    store.load = async (uri) => {
      if (delayFirstLoad) {
        delayFirstLoad = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      return realLoad(uri);
    };
    // A 的一切保存（关闭后的 superseding drain；reconcile 首存因会话失效被丢弃）
    // 返回 quota-exceeded —— 修复前 drain 失败只写 recovery 不传播，flush 任务
    // 对 uri 不匹配直接 {ok:true}，外层假报成功
    store.save = async (p, expected) => {
      if (p.uri === A_URI) return { ok: false, code: 'quota-exceeded', message: '模拟配额不足' };
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(5);
    editor.addObject(createGroupObject()); // rev1 → pending 捕获
    const flushing = autosaver.flush(); // 链被慢 reconcile 占用：flush 任务入队（执行前会话必失效）
    editor.reset(); // 关闭：触发 changed(null) → close() → 会话递增 + enqueueDrain(A)
    const outcome = await flushing;

    // drain 的失败如实传播：flush 不再声称成功（修复前 {ok:true}）
    expect(outcome).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    // A 未落盘：内容保留为恢复快照（不丢、不假报）
    expect(autosaver.getRecovery(A_URI)).not.toBeNull();
    autosaver.dispose();
  });

  it('flush 排队期间 A→B 切换 + drain 失败：flush 传播 drain 失败（不得放行），A 内容留在恢复快照，B 不受污染', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realLoad = store.load.bind(store);
    const realSave = store.save.bind(store);
    let delayFirstLoad = true;
    const A_URI = 'lumora://project/a';
    const B_URI = 'lumora://project/b';
    store.load = async (uri) => {
      if (delayFirstLoad) {
        delayFirstLoad = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      return realLoad(uri);
    };
    // A 的一切保存（A→B 切换的 superseding drain；reconcile 首存因会话失效被丢弃）
    // 失败；B 的保存全部走真实实现
    store.save = async (p, expected) => {
      if (p.uri === A_URI) return { ok: false, code: 'quota-exceeded', message: '模拟配额不足' };
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(5);
    editor.addObject(createGroupObject()); // A rev1 → pending 捕获
    const flushing = autosaver.flush(); // 链被慢 reconcile 占用：flush 任务入队
    editor.openProject(createSampleProject(B_URI)); // A→B：open(B) → 会话递增 + enqueueDrain(A)
    const outcome = await flushing;

    // drain 失败传播给正在等待的 flush：切换不得被假成功放行
    expect(outcome).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    // A 的 rev1 内容未落盘（存储中无 A 记录；reconcile 首存因会话失效被丢弃），
    // 未保存内容保留为恢复快照 —— 不丢、不假报
    expect(autosaver.getRecovery(A_URI)).not.toBeNull();
    const storedA = await loadStored(store, A_URI);
    expect(storedA).toBeNull();
    // B 不受 A 的失败污染：首存完成，当前会话 flush 正常放行
    const storedB = await loadStored(store, B_URI);
    expect(storedB).not.toBeNull();
    expect((await autosaver.flush()).ok).toBe(true);
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：flush 任务内保存挂起期间会话失效与代际隔离（第二十一轮阻断 2/3）', () => {
  it('保存 await 期间编辑+关闭：flush 任务保存 rev1 挂起时继续编辑 rev2 并 reset() → 任务复验失败转 superseded，传播本代 drain（rev2 保存失败）而非以 rev1 落盘放行', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realSave = store.save.bind(store);
    const A_URI = 'lumora://project/a';
    // rev1 保存（expected=0）开始执行的显式信号 —— 替代 settle(0) 猜测：确认
    // flush 任务真正挂起在 150ms 保存上之后才进行 rev2 编辑与 reset，杜绝
    // 「任务尚未启动」的竞态（改动时序后测试要么照常通过、要么超时失败，
    // 不会在错误前提下假通过）
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    // 仅 A 的 rev1 保存（flush 任务内、expected=0）挂起 150ms 后真实落盘；
    // 关闭触发的 rev2 superseding drain（expected=1）失败 —— 修复前 flush 任务
    // 以 rev1 落盘成功返回 done/ok，外层对「已关闭」假报成功放行
    store.save = async (p, expected) => {
      if (p.uri !== A_URI) return realSave(p, expected);
      if (expected === 0) {
        markSaveStarted();
        await new Promise((r) => setTimeout(r, 150));
        return realSave(p, expected);
      }
      if (expected === 1) return { ok: false, code: 'quota-exceeded', message: '模拟配额不足' };
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(5); // reconcile 首存（rev0, expected null）完成
    editor.addObject(createGroupObject()); // rev1 → pending 捕获
    const flushing = autosaver.flush();
    await saveStarted; // 显式屏障：flush 任务已开始 saveSnapshot(rev1)（挂起中）
    editor.addObject(createGroupObject()); // rev2 —— 保存 await 期间继续编辑
    editor.reset(); // 关闭：close() → 会话递增 + enqueueDrain(A rev2)（本代 drain）
    const outcome = await flushing;

    // 修复前：rev1 落盘成功 → 任务返回 done/ok → flush 放行假成功；
    // 修复后：保存后复验失败 → superseded → 传播本代 drain 的失败
    expect(outcome).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    // rev1 已落盘（flush 任务在途保存），rev2 未落盘且保留为恢复快照 —— 不丢、不假报
    const storedA = await loadStored(store, A_URI);
    expect(storedA?.revision).toBe(1);
    expect(autosaver.getRecovery(A_URI)).not.toBeNull();
    autosaver.dispose();
  });

  it('新项目 reconcile 前同步 flush+reset：B 打开后从未编辑（close 无 drain 记录），同步 flush 后被 reset 作废 → 无 drain 记录时以基线判定如实失败（storage-error），不得放行「从未落盘」的假成功', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realLoad = store.load.bind(store);
    let delayFirstLoad = true;
    const A_URI = 'lumora://project/a';
    const B_URI = 'lumora://project/b';
    // 首轮 reconcile 的 load 延迟 120ms 占住串行链：open(B) 后 reconcile(B)
    // 尚未执行时 flush 已入队，随后的 reset() 使任务与对账全部过期
    store.load = async (uri) => {
      if (delayFirstLoad) {
        delayFirstLoad = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      return realLoad(uri);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(5);
    editor.addObject(createGroupObject()); // A rev1 → pending 捕获
    editor.openProject(createSampleProject(B_URI)); // 排空 A rev1（本代 drain）+ reconcile(B) 排队
    const flushing = autosaver.flush(); // 绑定 {B, session}：B 基线 null 视为脏 → 入队
    editor.reset(); // 关闭：B 从未编辑 → 无 drain 记录；会话递增使任务/对账全部过期
    const outcome = await flushing;

    // 修复前：任务对 uri 不匹配/无脏快照直接 {ok:true}，假报 B 已落盘；
    // 修复后：无 drain 记录 → 已提交基线未覆盖 → 如实失败（recovery 也不存在）
    expect(outcome).toEqual({
      ok: false,
      code: 'storage-error',
      message: '项目未保存内容未能落盘且无恢复快照，请重试',
    });
    // A 的排空成功落盘（不丢）；B 从未落盘（对账因会话失效作废，无假成功写入）
    const storedA = await loadStored(store, A_URI);
    expect(storedA?.revision).toBe(1);
    const storedB = await loadStored(store, B_URI);
    expect(storedB).toBeNull();
    autosaver.dispose();
  });

  it('同 URI 前代失败、后代成功：前代 drain（A rev1）失败后同 uri 后代 drain（A rev2）成功 → 等待中的 flush 仍返回前代失败，后代成功不覆盖；恢复快照保留（前代内容从未落盘，仍可恢复）', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realLoad = store.load.bind(store);
    const realSave = store.save.bind(store);
    let delayFirstLoad = true;
    const A_URI = 'lumora://project/a';
    const B_URI = 'lumora://project/b';
    const C_URI = 'lumora://project/c';
    store.load = async (uri) => {
      if (delayFirstLoad) {
        delayFirstLoad = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      return realLoad(uri);
    };
    // A 的 rev1 保存（前代 drain）失败；rev2 保存（后代 drain）成功 ——
    // 修复前按 uri 记录 drain 结果：后代成功覆盖前代失败，F1 误读后代结果
    store.save = async (p, expected) => {
      if (p.uri !== A_URI) return realSave(p, expected);
      if (p.revision === 1) return { ok: false, code: 'quota-exceeded', message: '模拟配额不足' };
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(5);
    editor.addObject(createGroupObject()); // A rev1 → pending 捕获
    const flushing = autosaver.flush(); // F1 排队（链被慢 reconcile 占用）
    editor.openProject(createSampleProject(B_URI)); // 前代 drain（A rev1，epoch 1）→ 失败
    editor.openProject(createSampleProject(A_URI)); // 回到 A：reconcile 作废
    editor.addObject(createGroupObject()); // 后代 A 编辑 rev1
    editor.addObject(createGroupObject()); // 后代 A 编辑 rev2 → pending 捕获
    editor.openProject(createSampleProject(C_URI)); // 后代 drain（A rev2，epoch 3）→ 成功
    const outcome = await flushing;

    // F1 绑定第一代会话：读取本代 drain 结果 —— 前代失败如实传播，
    // 不被同 uri 后代的成功覆盖（修复前按 uri 覆盖后误报成功）
    expect(outcome).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    // 后代 drain 成功落盘（rev2），但成功只清除「自己覆盖的恢复项」—— 前代
    // rev1 从未落盘（内容仅存于恢复快照），必须保留仍可恢复（第二十三轮阻断 4）；
    // F1 结果不受翻转
    const storedA = await loadStored(store, A_URI);
    expect(storedA?.revision).toBe(2);
    expect(autosaver.getRecovery(A_URI)).not.toBeNull();
    expect(autosaver.getRecovery(A_URI)!.revision).toBe(1);
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：clean 时 flush 的等待窗口与并发共享（第二十三轮阻断 1 / 严重 6 / 严重 7）', () => {
  it('clean 时 flush：等待期间同栈编辑+关闭追加的 superseding drain 失败 → flush 传播该 drain 失败，不得以「编辑器已空」假报成功（阻断 1）', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realSave = store.save.bind(store);
    const A_URI = 'lumora://project/a';
    let drainRan = false;
    // rev1 保存（close 触发的 superseding drain）失败 —— 真实探针：flush 无脏
    // 分支等待期间同栈编辑+reset，drain 追加到 flush 等待的旧 tail 之后
    store.save = async (p, expected) => {
      if (p.uri === A_URI && p.revision === 1) {
        drainRan = true;
        return { ok: false, code: 'quota-exceeded', message: '模拟配额不足' };
      }
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(10); // rev0 落盘 → clean
    const flushing = autosaver.flush(); // 无脏分支：await 挂起
    editor.addObject(createGroupObject()); // 同步栈内编辑 rev1（flush 恢复前）
    editor.reset(); // 同步栈内关闭：会话递增 + enqueueDrain(A rev1) 追加到 flush 等待的 tail 之后
    const outcome = await flushing;

    // 修复前：flush 等旧 tail 后看到编辑器已空 → {ok:true} 假报成功，内容仅存
    // 恢复快照仍放行关闭；修复后：绑定 {uri, session}，会话失效后继续等待新链尾
    // 并传播该会话代的 drain 结果 —— 失败如实返回
    expect(drainRan).toBe(true);
    expect(outcome).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    expect(autosaver.getRecovery(A_URI)).not.toBeNull();
    autosaver.dispose();
  });

  it('保存成功落盘后 clean 监听器同步切换：superseded 携带实际保存 target/outcome，无 drain 回退校验实际 target → flush 放行（严重 6）', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realSave = store.save.bind(store);
    const A_URI = 'lumora://project/a';
    const B_URI = 'lumora://project/b';
    // A 的 rev1 保存（第一个 flush 任务）挂起 30ms 占住串行链：让第二个 flush
    // 捕获 rev1 后、其任务执行前产生 rev2 编辑（实际保存目标 ≠ flush 捕获快照）
    store.save = async (p, expected) => {
      if (p.uri === A_URI && p.revision === 1) {
        await new Promise((r) => setTimeout(r, 30));
      }
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));
    // clean 监听器同步切换：保存成功广播 clean 的瞬间打开新项目（会话递增）——
    // 此时 pending 已被清除，切换无 superseding drain，回退路径必须校验实际 target。
    // 初始对账的 clean（rev0 落盘）不触发，只切换「flush 任务保存成功」的那次
    // clean（编辑器 revision ≥ 1）
    let switched = false;
    autosaver.onState((s) => {
      if (s.status === 'clean' && editor.getProject()?.uri === A_URI && !switched && (editor.getProject()?.revision ?? 0) >= 1) {
        switched = true;
        editor.openProject(createSampleProject(B_URI, '项目B'));
      }
    });

    editor.openProject(createSampleProject(A_URI));
    await settle(10); // rev0 落盘 → clean
    editor.addObject(createGroupObject()); // rev1 → pending 捕获
    const flushing1 = autosaver.flush(); // F1 任务保存 rev1（挂起 30ms 占链）
    await settle(0);
    const flushing2 = autosaver.flush(); // F2 捕获 pending（rev1）后入队
    editor.addObject(createGroupObject()); // rev2 —— F2 任务执行前的最新内容
    const outcome2 = await flushing2;
    const outcome1 = await flushing1;

    // F2 任务实际保存 rev2 成功 → clean 广播 → 监听器同步切换 → 任务复验失败转
    // superseded{saved: rev2, outcome: ok}；无 drain（切换时无未保存内容）→ 回退
    // 必须校验实际保存的 target（rev2 已推进基线）→ 放行。修复前回退校验 flush
    // 捕获的 rev1 → 误报「未落盘」假失败阻断切换
    expect(switched).toBe(true);
    expect(outcome2).toEqual({ ok: true });
    expect(outcome1).toEqual({ ok: true });
    const storedA = await loadStored(store, A_URI);
    expect(storedA?.revision).toBe(2);
    autosaver.dispose();
  });

  it('并发 flush + reset + drain 失败：同代 drain 记录被并发 waiter 共享，两方都传播失败；无消费者后才清理（严重 7）', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    openStores.push(store);
    const realSave = store.save.bind(store);
    const A_URI = 'lumora://project/a';
    // rev1（关闭触发的 superseding drain）保存失败
    store.save = async (p, expected) => {
      if (p.uri === A_URI && p.revision === 1) {
        return { ok: false, code: 'quota-exceeded', message: '模拟配额不足' };
      }
      return realSave(p, expected);
    };
    const autosaver = new ProjectAutosaver(editor, store, { debounceMs: DEBOUNCE });
    editor.events.on('project:changed', ({ project }) => autosaver.changed(project));

    editor.openProject(createSampleProject(A_URI));
    await settle(10); // rev0 落盘 → clean
    editor.addObject(createGroupObject()); // rev1 → pending 捕获
    const flushing1 = autosaver.flush(); // F1 入队（脏分支，绑定会话 S）
    const flushing2 = autosaver.flush(); // F2 入队（脏分支，同代绑定 S）
    editor.reset(); // 关闭：会话递增 + enqueueDrain(A rev1, epoch S) → 失败
    const outcome1 = await flushing1;
    const outcome2 = await flushing2;

    // 两个 waiter 共享同一 drain promise/结果：各自等待链尾后 observe 同代记录，
    // 都传播失败（修复前 F1 先读先删，F2 读不到记录回退到「无恢复快照」错误路径，
    // 两方结果不一致）；记录在最后一个 waiter release 后才清理
    expect(outcome1).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    expect(outcome2).toEqual({ ok: false, code: 'quota-exceeded', message: '模拟配额不足' });
    expect(autosaver.getRecovery(A_URI)).not.toBeNull();
    autosaver.dispose();
  });
});

describe('ProjectAutosaver：重试恢复代绑定与卸载拒绝（第二十九轮阻断 4/5 回归）', () => {
  it('阻断4：恢复 fork 在重试执行前被清除 —— 执行前复验失败，不落盘任何内容（修复前先写盘再取消）', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const realSave = store.save.bind(store);
    // 仅 A rev1 首次保存失败（排空产生恢复 fork）：rev0 与后续 rev1 落盘正常
    let drainFailed = false;
    store.save = async (p, expected) => {
      if (!drainFailed && p.uri === A && p.revision === 1) {
        drainFailed = true;
        return { ok: false, code: 'storage-error', message: '模拟存储错误' };
      }
      return realSave(p, expected);
    };
    editor.openProject(createSampleProject(A));
    await settle(10); // rev0 落盘 → clean
    editor.addObject(createGroupObject()); // rev1
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60); // 排空 A rev1 失败 → fork 入录；B 首存成功
    expect(autosaver.getRecovery(A)).not.toBeNull();

    const saveSpy = vi.spyOn(store, 'save');
    // 调用时记录仍在（同步通过入口检查），任务执行前该代被显式清除（如用户
    // 另存副本/放弃恢复）—— 任务执行时的预检必须拦截：不得把已作废的快照
    // 以旧 CAS 写回磁盘
    const retrying = autosaver.retryRecovery(A);
    autosaver.clearRecovery(A);
    const outcome = await retrying;
    expect(outcome).toEqual({
      ok: false,
      code: 'revision-conflict',
      message: '恢复快照已被清除或更新，本次重试已取消',
    });
    expect(saveSpy).not.toHaveBeenCalled(); // 未发生任何落盘（修复前会先写盘再取消）
    expect(autosaver.getRecovery(A)).toBeNull();
    await autosaver.dispose();
  });

  it('阻断4：恢复 fork 在保存 await 期间被清除 —— 磁盘事实先同步基线，继续编辑不再假冲突（修复前基线不同步，后续 CAS 假 revision-conflict）', async () => {
    const { editor, store, autosaver } = await wired();
    const states: string[] = [];
    autosaver.onState((s) => states.push(s.status));
    const A = 'lumora://project/a';
    const base = createSampleProject(A);
    const realSave = store.save.bind(store);
    let drainFailed = false;
    store.save = async (p, expected) => {
      if (!drainFailed && p.uri === A && p.revision === 1) {
        drainFailed = true;
        return { ok: false, code: 'storage-error', message: '模拟存储错误' };
      }
      return realSave(p, expected);
    };
    editor.openProject(base);
    await settle(10); // rev0 落盘
    editor.addObject(createGroupObject()); // rev1
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60); // 排空失败 → fork（内容 base+1）；B 首存成功
    expect(autosaver.getRecovery(A)).not.toBeNull();

    // 重开 A（内容与已提交基线一致）→ 锁存 recovery-available
    editor.openProject(base);
    await settle(60);

    // 重试保存挂起：保存开始后、完成前该代恢复记录被清除（如用户另存副本）
    let saveStarted = false;
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.spyOn(store, 'save').mockImplementationOnce(async (p, expected) => {
      saveStarted = true;
      await gate;
      return realSave(p, expected);
    });
    const retrying = autosaver.retryRecovery(A);
    await vi.waitFor(() => expect(saveStarted).toBe(true)); // 保存已开始（await 挂起）
    autosaver.clearRecovery(A); // await 期间该代被清除
    releaseSave();
    const outcome = await retrying;
    expect(outcome).toEqual({
      ok: false,
      code: 'revision-conflict',
      message: '恢复快照已被清除或更新，本次重试已取消',
    });
    // 磁盘事实已同步：A 已含恢复快照内容（revision 1），基线随之推进 ——
    // 修复前取消分支不推进基线，后续保存以旧基线 CAS 触发假冲突
    const storedAfterRetry = await loadStored(store, A);
    expect(storedAfterRetry!.revision).toBe(1);
    expect(storedAfterRetry!.objects.length).toBe(base.objects.length + 1);
    expect(autosaver.getRecovery(A)).toBeNull();

    // 继续编辑并自动保存：以推进后的基线（rev1）CAS 正常落盘 —— 修复前取消
    // 分支不推进基线，后续保存按旧基线（rev0）CAS 触发假 revision-conflict
    // 锁存。连续两次编辑（防抖合并）→ 以 rev2 保存，磁盘已为 rev1 时 CAS 通过
    states.length = 0;
    editor.addObject(createGroupObject());
    editor.addObject(createGroupObject()); // 合并保存 rev2（内容 base+2）
    await settle(60);
    const stored = await loadStored(store, A);
    expect(stored!.revision).toBe(editor.getProject()!.revision);
    expect(stored!.objects.length).toBe(base.objects.length + 2);
    expect(states.at(-1)).toBe('clean'); // 落盘成功，无假冲突
    expect(states).not.toContain('error');
    await autosaver.dispose();
  });

  it('阻断5：卸载前任一 uri 仍有恢复 fork —— 冲刷成功后拒绝 dispose（返回 recovery-available），解决后重试成功释放', async () => {
    const { editor, store, autosaver } = await wired();
    const A = 'lumora://project/a';
    const realSave = store.save.bind(store);
    let drainFailed = false;
    store.save = async (p, expected) => {
      if (!drainFailed && p.uri === A && p.revision === 1) {
        drainFailed = true;
        return { ok: false, code: 'storage-error', message: '模拟存储错误' };
      }
      return realSave(p, expected);
    };
    editor.openProject(createSampleProject(A));
    await settle(10);
    editor.addObject(createGroupObject()); // rev1
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60); // A rev1 排空失败 → fork；B clean
    expect(autosaver.getRecovery(A)).not.toBeNull();

    // 当前项目已净，但 A 的恢复 fork 仅存于恢复区 —— 卸载必须拒绝：
    // 绝不因 teardown 沉没未落盘内容（修复前直接置 disposed 释放）
    const refused = await autosaver.dispose();
    expect(refused).toEqual({
      ok: false,
      code: 'recovery-available',
      message: '存在未保存的恢复快照（上次保存失败），运行时已保留；请先「另存副本」或「重试保存」后再释放',
    });
    // 未被 dispose：恢复快照仍在、自动保存仍可用（重试可落盘该 fork）
    expect(autosaver.getRecovery(A)).not.toBeNull();
    const retried = await autosaver.retryRecovery(A);
    expect(retried.ok).toBe(true);
    expect(autosaver.getRecovery(A)).toBeNull();
    const stored = await loadStored(store, A);
    expect(stored!.revision).toBe(1);
    expect(stored!.objects.length).toBe(createSampleProject().objects.length + 1);

    // 解决后重试 dispose：冲刷通过且无剩余 fork → 释放成功
    expect(await autosaver.dispose()).toEqual({ ok: true });
  });
});
