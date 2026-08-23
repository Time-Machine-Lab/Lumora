import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupObject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import type { StudioRuntime } from '../src/runtime/studio-runtime';
import { ProjectStore } from '../src/persistence/project-store';
import { OpfsProjectStore } from '../src/persistence/project-store-opfs';
import { MemDirectoryHandle } from './opfs-fs-shim';

const DB = 'lumora-test-persist-opfs';

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const openRuntimes: StudioRuntime[] = [];
const openStores: ProjectStore[] = [];

async function makeRuntime(storage?: 'indexeddb' | 'opfs') {
  const runtime = createStudioRuntime();
  openRuntimes.push(runtime);
  await runtime.init({ debounceMs: 10, dbName: DB, storage });
  return runtime;
}

beforeEach(async () => {
  // 同一测试内多次 init（多运行时模拟多标签页）共享同一 OPFS 根
  const root = new MemDirectoryHandle('root');
  vi.stubGlobal(
    'navigator',
    Object.create(navigator, {
      storage: {
        value: { getDirectory: async () => root },
        configurable: true,
      },
    }),
  );
  await OpfsProjectStore.drop(DB);
  await ProjectStore.drop(DB);
});

afterEach(async () => {
  for (const runtime of openRuntimes) await runtime.dispose();
  openRuntimes.length = 0;
  for (const store of openStores) store.close();
  openStores.length = 0;
  await OpfsProjectStore.drop(DB);
  await ProjectStore.drop(DB);
  vi.unstubAllGlobals();
});

describe('ProjectPersistence：OPFS 后端（可配置切换，行为与 IndexedDB 一致）', () => {
  it('init({ storage: opfs }) 后可用且 backend 报告 opfs；缺省为 indexeddb', async () => {
    const opfsRuntime = await makeRuntime('opfs');
    expect(opfsRuntime.persistence.available).toBe(true);
    expect(opfsRuntime.persistence.backend).toBe('opfs');

    const idbRuntime = await makeRuntime();
    expect(idbRuntime.persistence.available).toBe(true);
    expect(idbRuntime.persistence.backend).toBe('indexeddb');
  });

  it('新建项目 → 打开 → 自动保存 → 出现在最近项目列表（OPFS 落盘）', async () => {
    const runtime = await makeRuntime('opfs');
    expect(await runtime.persistence.listRecent()).toEqual([]);

    const project = runtime.persistence.createProject('OPFS 项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60);

    const recent = await runtime.persistence.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ uri: project.uri, name: 'OPFS 项目' });
    // 重新打开同后端：数据从 OPFS 完整恢复
    const reopened = await makeRuntime('opfs');
    const loaded = await reopened.persistence.loadProject(project.uri);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.project.objects).toHaveLength(2);
    expect(loaded.project.revision).toBeGreaterThanOrEqual(1);
  });

  it('重命名 / 复制 / 删除在 OPFS 后端工作', async () => {
    const runtime = await makeRuntime('opfs');
    const project = runtime.persistence.createProject('原名');
    runtime.openProject(project);
    await settle(60);

    // 打开中的项目重命名走编辑器提交（一步历史 + revision 递增 + 落盘）
    const renamed = await runtime.persistence.renameProject(project.uri, '新名');
    expect(renamed.ok).toBe(true);
    await settle(60);
    const renamedLoaded = await runtime.persistence.loadProject(project.uri);
    expect(renamedLoaded.ok).toBe(true);
    if (!renamedLoaded.ok) return;
    expect(renamedLoaded.project.name).toBe('新名');

    // 复制
    const duplicate = await runtime.persistence.duplicateProject(project.uri);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.summary.name).toBe('新名 副本');
    expect(await runtime.persistence.hasLocal(duplicate.summary.uri)).toBe(true);

    // 删除副本
    expect(await runtime.persistence.deleteProject(duplicate.summary.uri)).toBe(true);
    expect(await runtime.persistence.hasLocal(duplicate.summary.uri)).toBe(false);
  });

  it('切换后端不共享数据：IndexedDB 的既有记录在 OPFS 模式不可见，反之亦然', async () => {
    const idbRuntime = await makeRuntime();
    const project = idbRuntime.persistence.createProject('IDB 项目');
    idbRuntime.openProject(project);
    await settle(60);
    expect(await idbRuntime.persistence.listRecent()).toHaveLength(1);

    const opfsRuntime = await makeRuntime('opfs');
    expect(await opfsRuntime.persistence.listRecent()).toEqual([]);

    // 反向：OPFS 写入后 IndexedDB 侧仍不可见
    const opfsProject = opfsRuntime.persistence.createProject('OPFS 项目');
    opfsRuntime.openProject(opfsProject);
    await settle(60);
    expect(await idbRuntime.persistence.listRecent()).toHaveLength(1);
  });

  it('revision 冲突在 OPFS 后端同样锁存并可通过「加载较新版本」解决（AC2）', async () => {
    const runtime = await makeRuntime('opfs');
    const states: string[] = [];
    runtime.persistence.events.on('save-state', ({ state }) => states.push(state.status));
    const project = runtime.persistence.createProject('冲突项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60); // rev1 已存

    // 模拟另一标签页（另一 OPFS 连接）写入了较新内容（rev5，无条件写入）
    const store = await OpfsProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    expect((await store.save({ ...project, name: '较新内容', revision: 5 })).ok).toBe(true);

    // 本地再编辑 → 保存失败（期望基线 1 ≠ 已存 5）
    runtime.editor.addObject(createGroupObject());
    await settle(60);
    expect(states).toContain('error');

    // 显式解决「加载较新版本」：以存储内容为基线重开，冲突解除
    const reloaded = await runtime.persistence.reloadOpenProject();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(runtime.editor.getProject()!.name).toBe('较新内容');
    expect(runtime.editor.getProject()!.revision).toBe(5);

    // 冲突解除：后续编辑可正常保存为 rev6（不覆盖较新内容）
    runtime.editor.addObject(createGroupObject());
    await settle(60);
    const final = await store.load(project.uri);
    expect(final!.revision).toBe(6);
    expect(final!.name).toBe('较新内容');
    store.close();
  });

  it('v2 记录经 OPFS 后端重开：适配器层 raw 保留，facade 统一完成 迁移 → 校验 → CAS 写回（第七轮 #6）', async () => {
    const runtime = await makeRuntime('opfs');
    const store = await OpfsProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    const v3 = runtime.persistence.createProject('OPFS 旧版项目');
    const { tracks: _tracks, ...v2 } = v3;
    expect((await store.save({ ...v2, schemaVersion: 2 } as unknown as Project)).ok).toBe(true);

    // 适配器层不提前迁移：raw/source schema 原样返回
    const raw = await store.load(v3.uri);
    expect(raw!.schemaVersion).toBe(2);
    // facade loadProject：迁移 → 校验 → 以已存 revision CAS 写回（migratedFrom 如实报告）
    const loaded = await runtime.persistence.loadProject(v3.uri);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.migratedFrom).toBe(2);
    expect(loaded.project.schemaVersion).toBe(3);
    expect(loaded.project.tracks).toEqual([]);
    // 写回后的存储记录已是 v3（下次加载不再迁移）
    const after = await store.load(v3.uri);
    expect(after!.schemaVersion).toBe(3);
    expect(after!.revision).toBe(0);
    store.close();
  });

  it('OPFS 不可用时 init 静默降级：available false、backend null（仅内存编辑）', async () => {
    vi.stubGlobal(
      'navigator',
      Object.create(navigator, {
        storage: { value: {}, configurable: true },
      }),
    );
    const runtime = await makeRuntime('opfs');
    expect(runtime.persistence.available).toBe(false);
    expect(runtime.persistence.backend).toBeNull();
    expect(await runtime.persistence.listRecent()).toEqual([]);
  });
});
