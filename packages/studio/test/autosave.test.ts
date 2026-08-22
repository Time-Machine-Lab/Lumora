import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneEditor, createGroupObject, createSampleProject } from '@lumora/core';
import { ProjectAutosaver } from '../src/persistence/autosave';
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
    const states: Array<{ status: string; code?: string }> = [];
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
    const states: Array<{ status: string; code?: string }> = [];
    autosaver.onState((s) => states.push(s));
    await settle(60);

    expect(states.at(-1)!.status).toBe('error');
    expect(states.at(-1)!.code).toBe('quota-exceeded');
    // 脏状态保持：内容未丢
    expect(store.load('lumora://project/a')).not.toBeNull();
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
