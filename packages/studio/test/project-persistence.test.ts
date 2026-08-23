import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupObject, createSampleProject, SceneEditor } from '@lumora/core';
import type { Project } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import type { StudioRuntime } from '../src/runtime/studio-runtime';
import { ProjectStore } from '../src/persistence/project-store';
import { ProjectPersistence } from '../src/persistence/project-persistence';
import { buildProjectPackage, serializeProjectPackage } from '@lumora/core';
import type { ListOutcome, LoadOutcome, ProjectStorage, RemoveOutcome } from '../src/persistence/project-storage';

const DB = 'lumora-test-persist';
/** 便捷读取/列表（第十七轮严重 4：list/load 收口为类型化结果后直接取数据字段） */
async function loadStored(store: ProjectStorage, uri: string): Promise<Project | null> {
  const result = await store.load(uri);
  return result.ok ? result.project : null;
}


async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const openStores: ProjectStore[] = [];
const openRuntimes: StudioRuntime[] = [];

async function makeRuntime() {
  const runtime = createStudioRuntime();
  openRuntimes.push(runtime);
  await runtime.init({ debounceMs: 10, dbName: DB });
  return runtime;
}

async function openStandaloneStore(): Promise<ProjectStore> {
  const store = await ProjectStore.create(DB);
  expect(store).not.toBeNull();
  openStores.push(store!);
  return store!;
}

beforeEach(async () => {
  await ProjectStore.drop(DB);
});

afterEach(async () => {
  // 先释放运行时与全部连接再删库：deleteDatabase 会排在未关闭连接之后，
  // 挂起的删除会无限阻塞后续 open（fake-indexeddb 与真实浏览器行为一致）
  for (const runtime of openRuntimes) {
    const outcome = await runtime.dispose();
    // 第二十八轮阻断 4：dispose 冲刷失败时不 teardown（连接保留供调用方
    // 重试/另存副本）——测试隔离要求删库前强制释放连接，否则挂起的
    // deleteDatabase 永久排队，阻塞后续测试的 open（级联超时）
    if (!outcome.ok) {
      const store = (runtime.persistence as unknown as { store: ProjectStorage | null }).store;
      store?.close();
    }
  }
  openRuntimes.length = 0;
  for (const store of openStores) store.close();
  openStores.length = 0;
  await ProjectStore.drop(DB);
});

describe('ProjectPersistence：新建 / 最近项目 / 重命名 / 复制 / 删除（FR-001）', () => {
  it('init 后可用；新建项目 → 打开 → 自动保存 → 出现在最近项目列表', async () => {
    const runtime = await makeRuntime();
    expect(runtime.persistence.available).toBe(true);
    expect(await runtime.persistence.listRecent()).toEqual([]);

    const project = runtime.persistence.createProject('我的新项目');
    expect(project.name).toBe('我的新项目');
    expect(project.uri).toMatch(/^lumora:\/\/project\//);
    expect(project.scenes).toHaveLength(1);

    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60);

    const recent = await runtime.persistence.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.uri).toBe(project.uri);
    expect(recent[0]!.name).toBe('我的新项目');
    expect(recent[0]!.revision).toBe(runtime.editor.getProject()!.revision);
    await runtime.dispose();
  });

  it('打开中的项目重命名走编辑器提交（revision 递增并自动落盘）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('旧名字');
    runtime.openProject(project);
    const result = await runtime.persistence.renameProject(project.uri, '新名字');
    expect(result.ok).toBe(true);
    expect(runtime.editor.getProject()!.name).toBe('新名字');
    await settle(60);
    const stored = await openStandaloneStore();
    expect((await loadStored(stored!, project.uri))!.name).toBe('新名字');
    await runtime.dispose();
  });

  it('未打开项目的重命名直接改存储记录；空名拒绝', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('不打开的项目');
    // 需要先落盘：模拟曾经打开并保存过的项目
    const store = await openStandaloneStore();
    await store!.save(project);

    const ok = await runtime.persistence.renameProject(project.uri, '改名不打开');
    expect(ok.ok).toBe(true);
    const reopened = await openStandaloneStore();
    expect((await loadStored(reopened!, project.uri))!.name).toBe('改名不打开');

    const empty = await runtime.persistence.renameProject(project.uri, '   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty-name');
    await runtime.dispose();
  });

  it('复制项目生成新 uri 与副本名；删除后从列表移除', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('源项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60);

    const dup = await runtime.persistence.duplicateProject(project.uri);
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.summary.uri).not.toBe(project.uri);
    expect(dup.summary.name).toBe('源项目 副本');

    // 复制出的项目同样可被打开编辑
    const copy = await openStandaloneStore();
    const copyProject = await loadStored(copy!, dup.summary.uri);
    expect(copyProject!.revision).toBe(0);

    expect(await runtime.persistence.deleteProject(dup.summary.uri)).toBe(true);
    const recent = await runtime.persistence.listRecent();
    expect(recent.map((s) => s.uri)).not.toContain(dup.summary.uri);
    await runtime.dispose();
  });
});

describe('ProjectPersistence：工程包导出 / 导入（FR-011 / AC1 / AC3）', () => {
  it('导出当前项目为 .lumora 文本：不含私有字段，可再次导入完整恢复', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('导出项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());

    const exported = runtime.persistence.exportCurrent();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.filename).toBe('导出项目.lumora');
    expect(exported.bytes).toBeGreaterThan(0);

    // 未打开项目时导出失败
    await runtime.closeProject();
    expect(runtime.persistence.exportCurrent().ok).toBe(false);

    // 导入恢复（同 revision 体系与内容）
    const imported = await runtime.persistence.importPackage(exported.text);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.project.name).toBe('导出项目');
    expect(imported.project.uri).toBe(project.uri);
    expect(imported.project.objects.length).toBe(project.objects.length + 1);
    await runtime.dispose();
  });

  it('导入失败（损坏包）不改变当前项目（AC3 失败回滚）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('当前项目');
    runtime.openProject(project);
    const before = runtime.editor.getProject()!;

    const broken = await runtime.persistence.importPackage('这不是 JSON {{{');
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error.code).toBe('not-json');

    // 当前项目原样保留，未被打断
    expect(runtime.editor.getProject()).toEqual(before);

    // 未知未来 schema 的包同样拒绝且不产生副作用
    const pkg = buildProjectPackage(before);
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    raw.project.schemaVersion = 99;
    const future = await runtime.persistence.importPackage(JSON.stringify(raw));
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe('migration-failed');
    expect(runtime.editor.getProject()).toEqual(before);
    await runtime.dispose();
  });

  it('缺失资产载荷的包：导入成功并给出缺失明细（缺失资产报告）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('缺资产项目');
    runtime.openProject(project);
    const pkg = buildProjectPackage(runtime.editor.getProject()!);
    pkg.assets = {};
    const imported = await runtime.persistence.importPackage(serializeProjectPackage(pkg));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(Array.isArray(imported.warnings)).toBe(true);
    await runtime.dispose();
  });
});

describe('ProjectPersistence：运行时集成（自动保存链路）', () => {
  it('dispose 冲刷未保存变更（不等防抖）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('卸载前项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    // 不等待防抖，直接卸载
    await runtime.dispose();
    const store = await openStandaloneStore();
    const stored = await loadStored(store!, project.uri);
    expect(stored!.revision).toBeGreaterThan(0);
  });

  it('closeProject 前冲刷未保存变更（排空屏障：在途保存也等待完成）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('关闭前项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await runtime.closeProject();
    const store = await openStandaloneStore();
    const stored = await loadStored(store!, project.uri);
    expect(stored).not.toBeNull();
    expect(stored!.objects.length).toBeGreaterThan(project.objects.length);
    await runtime.dispose();
  });

  it('重新打开已保存项目：从磁盘加载重开（内存旧对象会触发冲突，必须走存储）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('再打开项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60);
    const savedRevision = (await runtime.persistence.listRecent())[0]!.revision;

    await runtime.closeProject();
    const loaded = await runtime.persistence.loadProject(project.uri);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    runtime.openProject(loaded.project);
    // 打开后不做任何编辑：不触发保存（savedAt 不刷新、不产生脏状态）
    await settle(60);
    const recent = await runtime.persistence.listRecent();
    expect(recent[0]!.revision).toBe(savedRevision);
    await runtime.dispose();
  });

  it('冷启动：init 前打开并编辑的项目在持久化就绪后对账落盘（不丢事件）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const project = runtime.persistence.createProject('冷启动项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject()); // init 之前的变更（仅内存受理）
    await runtime.init({ debounceMs: 10, dbName: DB });
    await settle(80);
    const store = await openStandaloneStore();
    const stored = await loadStored(store!, project.uri);
    expect(stored).not.toBeNull();
    expect(stored!.revision).toBe(runtime.editor.getProject()!.revision);
    expect(stored!.objects.length).toBe(project.objects.length + 1);
    await runtime.dispose();
  });

  it('复制打开中的项目以编辑器快照为准（磁盘记录可能落后于未保存变更，不丢内容）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    await runtime.init({ debounceMs: 1000, dbName: DB });
    const project = runtime.persistence.createProject('快照源');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject()); // 未保存（防抖 1s 内操作）
    const dup = await runtime.persistence.duplicateProject(project.uri);
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    const copy = await openStandaloneStore();
    const copyProject = await loadStored(copy!, dup.summary.uri);
    // 副本来自编辑器快照：含未保存的新增对象
    expect(copyProject).not.toBeNull();
    expect(copyProject!.objects.length).toBe(project.objects.length + 1);
    expect(copyProject!.revision).toBe(0);
    await runtime.dispose();
  });

  it('reloadOpenProject（加载较新版本）：以本地较新保存内容为基线重开，冲突解除后正常保存', async () => {
    const runtime = await makeRuntime();
    const states: string[] = [];
    runtime.persistence.events.on('save-state', ({ state }) => states.push(state.status));
    const project = runtime.persistence.createProject('冲突项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60); // rev1 已存

    // 模拟另一标签页写入了较新内容（rev5）
    const store = await openStandaloneStore();
    await store!.save({ ...project, name: '较新内容', revision: 5 });

    // 本地再编辑 → 保存失败（期望基线 1 ≠ 已存 5）
    runtime.editor.addObject(createGroupObject());
    await settle(60);
    expect(states).toContain('error');

    // 显式解决「加载较新版本」
    const reloaded = await runtime.persistence.reloadOpenProject();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(runtime.editor.getProject()!.name).toBe('较新内容');
    expect(runtime.editor.getProject()!.revision).toBe(5);

    // 冲突解除：后续编辑可正常保存为 rev6（不覆盖较新内容）
    runtime.editor.addObject(createGroupObject());
    await settle(60);
    const final = await openStandaloneStore();
    const stored = await loadStored(final!, project.uri);
    expect(stored!.revision).toBe(6);
    expect(stored!.name).toBe('较新内容');
    await runtime.dispose();
  });

  it('阻断2：重载挂起期间继续编辑：操作取消（cancelled），编辑器与自动保存未被触碰（第七轮 #2）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const store = await openStandaloneStore();
    await runtime.init({ debounceMs: 10, dbName: DB, store });
    const project = runtime.persistence.createProject('重载项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60); // rev1 已存

    // 慢速 load：reloadOpenProject 的 await 挂起
    const realLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return realLoad(project.uri);
    });
    const reloading = runtime.persistence.reloadOpenProject();
    await settle(20); // load 挂起中
    runtime.editor.addObject(createGroupObject()); // 继续编辑（rev2）
    const outcome = await reloading;
    vi.mocked(store.load).mockRestore();

    // 重载取消：不把存储内容切换进编辑器，绝不覆盖挂起期间的新编辑
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('已取消');
    expect(runtime.editor.getProject()!.revision).toBe(2);
    expect(runtime.editor.getProject()!.objects.length).toBe(project.objects.length + 2);
    // 自动保存未被触碰（无锁存冲突）：新编辑随后正常落盘
    await settle(60);
    const stored = await loadStored(store, project.uri);
    expect(stored!.revision).toBe(2);
    expect(stored!.objects.length).toBe(project.objects.length + 2);
    await runtime.dispose();
  });

  it('阻断2：重载挂起期间切换项目：操作取消，新项目未被重载结果覆盖（第七轮 #2）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const store = await openStandaloneStore();
    await runtime.init({ debounceMs: 10, dbName: DB, store });
    const project = runtime.persistence.createProject('重载项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60); // rev1 已存

    const realLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return realLoad(project.uri);
    });
    const reloading = runtime.persistence.reloadOpenProject();
    await settle(20); // load 挂起中
    const other = runtime.persistence.createProject('另一项目');
    runtime.openProject(other); // 切换项目
    const outcome = await reloading;
    vi.mocked(store.load).mockRestore();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('已取消');
    // 新项目原样：未被重载结果覆盖，自动保存基线未被重置
    expect(runtime.editor.getProject()!.uri).toBe(other.uri);
    expect(runtime.editor.getProject()!.name).toBe('另一项目');
    await settle(60);
    const otherStored = await loadStored(store, other.uri);
    expect(otherStored).not.toBeNull(); // 新项目自身照常落盘
    await runtime.dispose();
  });
});

describe('ProjectPersistence：本地加载边界 schema 迁移（TML-53 第四轮 #6）', () => {
  it('v2 项目记录（无 tracks）重开：加载边界迁移到 v3 补 tracks，并以已存 revision CAS 原子写回', async () => {
    const runtime = await makeRuntime();
    // 直接向存储写入 v2 记录（模拟旧版本留下的本地数据，无迁移入口时的形态）
    const store = await openStandaloneStore();
    const v3 = runtime.persistence.createProject('旧版项目');
    const { tracks: _tracks, ...v2 } = v3;
    const v2Record = { ...v2, schemaVersion: 2 } as unknown as Project;
    expect((await store!.save(v2Record)).ok).toBe(true);

    // 重开：加载边界迁移 + 校验 + 原子写回（绝不把旧版本数据原样交给编辑器）
    const loaded = await runtime.persistence.loadProject(v3.uri);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.migratedFrom).toBe(2);
    expect(loaded.project.schemaVersion).toBe(3);
    expect(loaded.project.tracks).toEqual([]);
    expect(loaded.project.objects).toEqual(v3.objects);

    // 写回后的存储记录已是 v3（下次加载不再迁移）
    const after = await loadStored(store!, v3.uri);
    expect(after!.schemaVersion).toBe(3);
    expect(after!.tracks).toEqual([]);
    await runtime.dispose();
  });

  it('v2 记录携带非法 tracks（非数组）：迁移保留原值不静默置空，校验明确拒绝打开', async () => {
    const runtime = await makeRuntime();
    const store = await openStandaloneStore();
    const v3 = runtime.persistence.createProject('损坏轨道项目');
    const { tracks: _tracks, ...v2 } = v3;
    const bad = { ...v2, schemaVersion: 2, tracks: 'not-an-array' } as unknown as Project;
    expect((await store!.save(bad)).ok).toBe(true);

    const loaded = await runtime.persistence.loadProject(v3.uri);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message).toContain('tracks');
    await runtime.dispose();
  });
});

describe('ProjectPersistence：本地加载边界统一「迁移 → 校验」（第五轮 #7）', () => {
  it('当前版本（v3）损坏记录：结构校验拒绝，绝不原样交给编辑器，也不产生写回', async () => {
    const runtime = await makeRuntime();
    const store = await openStandaloneStore();
    const v3 = runtime.persistence.createProject('损坏的当前版本');
    const bad = { ...v3, tracks: 'not-an-array' } as unknown as Project;
    expect((await store!.save(bad)).ok).toBe(true);

    const loaded = await runtime.persistence.loadProject(v3.uri);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message).toContain('tracks');

    // 磁盘记录保持原样（无写回尝试），下次加载仍被拒绝
    const after = await loadStored(store!, v3.uri);
    expect(after!.tracks).toBe('not-an-array');
    await runtime.dispose();
  });

  it('当前版本（v3）合法记录：校验通过原样返回，不做无意义写回（save 不被调用）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const injected = await ProjectStore.create(DB);
    if (!injected) return;
    const saveSpy = vi.spyOn(injected, 'save');
    openStores.push(injected);
    await runtime.init({ debounceMs: 10, dbName: DB, store: injected });
    const project = runtime.persistence.createProject('合法记录');
    runtime.openProject(project);
    await settle(60); // 打开时自动保存已建立记录
    saveSpy.mockClear();

    const loaded = await runtime.persistence.loadProject(project.uri);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(saveSpy).not.toHaveBeenCalled();
    expect(loaded.project.schemaVersion).toBe(3);
    await runtime.dispose();
  });

  it('reloadOpenProject 复用统一边界：损坏记录 → 失败且编辑器状态不变（第五轮 #5）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('冲突项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60); // rev1 已存
    // 磁盘记录被破坏（同 uri，tracks 损坏，revision 更新）
    const store = await openStandaloneStore();
    const bad = { ...project, revision: 2, tracks: 'corrupted' } as unknown as Project;
    expect((await store!.save(bad)).ok).toBe(true);

    const reloaded = await runtime.persistence.reloadOpenProject();
    expect(reloaded.ok).toBe(false);
    if (reloaded.ok) return;
    expect(reloaded.message).toContain('tracks');
    // 失败不改变编辑器状态（内容与 revision 原样）
    expect(runtime.editor.getProject()!.name).toBe('冲突项目');
    expect(runtime.editor.getProject()!.revision).toBe(1);
    await runtime.dispose();
  });
});

describe('ProjectPersistence：图结构损坏与导出编码预检（第六轮 #2 / #5）', () => {
  it('图结构损坏记录（activeSceneId 指向不存在的场景）：loadProject 拒绝，恢复快照不受影响', async () => {
    // 注入 store 以便 spy 运行时实际使用的保存路径（makeRuntime 内部自建 store）
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const store = await openStandaloneStore();
    await runtime.init({ debounceMs: 10, dbName: DB, store });
    // 打开正常项目并制造恢复快照（保存失败 → 切换 → 快照保留）
    const A = runtime.persistence.createProject('正常项目');
    runtime.openProject(A);
    await settle(40);
    vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    runtime.editor.addObject(createGroupObject());
    await settle(40);
    // 切换屏障（flush 失败则拒绝切换）下无法制造恢复快照：显式跳过排空走切换路径
    runtime.openProject(runtime.persistence.createProject('另一项目'), { flush: false });
    await settle(40);
    vi.mocked(store.save).mockRestore();
    expect(runtime.persistence.getRecoverySnapshot(A.uri)).not.toBeNull();

    // 磁盘记录被破坏为图结构非法（schema 通过、结构校验拒绝）
    const bad = { ...A, revision: 1, activeSceneId: '不存在的场景' } as unknown as Project;
    expect((await store.save(bad)).ok).toBe(true);

    const loaded = await runtime.persistence.loadProject(A.uri);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message).toContain('活动场景不存在');
    // 失败路径不触碰恢复区：快照仍可重试/另存副本
    expect(runtime.persistence.getRecoverySnapshot(A.uri)).not.toBeNull();
    await runtime.dispose();
  });

  it('exportCurrent 编码预检：数组非索引键（settings 契约字段承载）→ 类型化失败；整对象声明被叶值校验剥离（第十五轮阻断 1）', async () => {
    // 剥离路径经真实入口：带非索引自有键的数组（JSON.stringify 会静默丢键）作
    // 整对象声明 —— 字符串声明仅允许叶值，数组整值被剥离 → 包正常导出且不含
    // 该字段
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('不可导出');
    const arr = [1, 2] as unknown as Record<string, unknown>;
    arr.extra = 3;
    runtime.openProject({ ...project, pluginData: { 'com.example': { arr: arr as unknown as unknown[] } } } as Project);
    await settle(40);
    const stripped = await runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['arr'] },
    });
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    expect(stripped.text).not.toContain('"arr"');
    await runtime.dispose();

    // 契约承载路径（绕过编辑器 schema 校验 —— settings.fps 类型检查在编辑器
    // 边界拦截坏值，这里直接注入投影视图）：契约字段原样保留 → 编码预检对
    // 最终投影视图拒绝（第十三轮语义保留）
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB });
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue({
      ...createSampleProject('lumora://project/bad', '坏数据'),
      settings: { fps: arr as unknown as number, aspect: [16, 9] } as unknown as Project['settings'],
    } as Project);
    try {
      const result = persistence.exportCurrent({ includePrivate: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('无法导出');
      expect(result.message).toContain('array-extra-keys');
      // settings 是项目核心契约（与 includePrivate 无关）：坏值经契约字段进入
      // 最终投影，两种导出模式都拒绝 —— 不得产出丢字段的包
      expect(persistence.exportCurrent().ok).toBe(false);
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });

  it('exportCurrent 根级反射：访问器顶层字段 → 类型化失败，getter 副作用不发生（第十一轮一般 #6）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB }); // 超长防抖：注入期间无保存读取
    let getterCalled = 0;
    const withAccessor = createSampleProject('lumora://project/getter', '访问器项目');
    Object.defineProperty(withAccessor, 'name', {
      configurable: true,
      get() {
        getterCalled += 1;
        return '读取到的名字';
      },
    });
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue(withAccessor);
    try {
      const result = persistence.exportCurrent();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('访问器属性');
      expect(result.message).toContain('name');
      // 预检在属性读取之前拒绝：getter 副作用未发生（修复前 project[field] 会先触发）
      expect(getterCalled).toBe(0);
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });

  it('exportCurrent 根级反射：Proxy 的 getOwnPropertyDescriptor trap 抛错 → 类型化失败（第十一轮一般 #6）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB });
    const target = createSampleProject('lumora://project/proxy', '代理项目');
    const proxy = new Proxy(target, {
      ownKeys() {
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor() {
        throw new Error('trap boom');
      },
    });
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue(proxy);
    try {
      const result = persistence.exportCurrent();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('无法反射');
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });

  it('exportCurrent 文件名回归：get 陷阱抛错的源对象经 descriptor 预检隔离，文件名读取不裸抛（第十四轮一般 6）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB });
    const target = createSampleProject('lumora://project/gettrap', '代理名称项目');
    // get 陷阱抛错：任何属性读取都会裸抛；getOwnPropertyDescriptor 正常 →
    // 构建期 descriptor 预检不触发 get，文件名改从构建产物（manifest 投影视图）
    // 读取 —— 修复前文件名在 try 外直接读原始 project.name，会裸抛
    const proxy = new Proxy(target, {
      get() {
        throw new Error('unexpected get trap');
      },
    });
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue(proxy);
    try {
      const result = persistence.exportCurrent({ includePrivate: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.filename).toBe('代理名称项目.lumora');
      expect(result.text).toContain('代理名称项目');
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });

  it('exportCurrent 编码预检：循环引用（settings 契约字段承载）→ 类型化失败；整对象声明被叶值校验剥离（第十五轮阻断 1）', async () => {
    // 剥离路径经真实入口：循环对象作整对象声明 —— trie 投影遇非叶对象即剥离，
    // 包正常导出且不含该字段
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('循环项目');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    runtime.openProject({ ...project, pluginData: { 'com.example': { loop } } } as Project);
    await settle(40);
    const stripped = await runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['loop'] },
    });
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    expect(stripped.text).not.toContain('"loop"');
    await runtime.dispose();

    // 契约承载路径（绕过编辑器 schema 校验直接注入投影视图）：循环引用经契约
    // 字段原样进入最终投影 → 编码预检拒绝
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB });
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue({
      ...createSampleProject('lumora://project/bad', '坏数据'),
      settings: { fps: loop as unknown as number, aspect: [16, 9] } as unknown as Project['settings'],
    } as Project);
    try {
      const result = persistence.exportCurrent({ includePrivate: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('circular-reference');
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });

  it('exportCurrent 编码预检：BigInt/循环引用位于契约外字段（投影剥离）→ 不阻断导出（第十二轮一般 #10）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('可导出');
    const object = project.objects[0]!;
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    // settings 契约外 BigInt + 对象契约外 BigInt/循环引用：逐层投影把这些字段
    // 从最终投影视图剥离 —— 预检在投影之后执行，不得阻断合法导出
    runtime.openProject({
      ...project,
      settings: { ...project.settings, apiKey: 9007199254740993n } as unknown as Project['settings'],
      objects: [
        { ...object, apiKey: 9007199254740993n, loop },
        ...project.objects.slice(1),
      ],
    } as Project);
    await settle(40);
    const result = await runtime.persistence.exportCurrent();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('apiKey');
    await runtime.dispose();
  });

  it('阻断2：慢速重试落盘期间继续编辑后「另存副本」保存最新编辑器内容，不丢弃新编辑（第八轮 #2）', async () => {
    const editor = new SceneEditor();
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    openStores.push(store!);
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 500, store: store! }); // 长防抖：慢速窗口内无自动保存干扰
    const A = 'lumora://project/a';
    const base = createSampleProject(A, '项目A');
    editor.openProject(base);
    await settle(10); // 基线 rev0
    vi.spyOn(store!, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject()); // rev1（恢复快照内容 = base+1）
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/b'));
    await settle(60);
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();
    vi.mocked(store!.save).mockRestore();

    // 重开 A（编辑器 == 基线）→ 慢速重试恢复快照；挂起期间继续编辑两次
    editor.openProject({ ...base, name: '项目A' });
    await settle(60);
    const realSave = store!.save.bind(store!);
    vi.spyOn(store!, 'save').mockImplementationOnce(async (project, expected) => {
      await new Promise((r) => setTimeout(r, 40));
      return realSave(project, expected);
    });
    const retrying = persistence.retryRecovery(A);
    await settle(20); // 保存挂起中
    editor.addObject(createGroupObject()); // rev1（内容 base+1）
    editor.addObject(createGroupObject()); // rev2（内容 base+2 —— 最新编辑）
    const outcome = await retrying;
    expect(outcome.ok).toBe(false); // 挂起期间编辑 → 锁存冲突（快照保留）

    // 「另存副本」以编辑器现场为准：修复前取旧恢复快照（base+1），新编辑被丢弃
    const source = persistence.resolveSaveAsCopySource(A);
    expect(source).not.toBeNull();
    expect(source!.objects.length).toBe(base.objects.length + 2);
    const saved = await persistence.saveSnapshotAsNew(source!);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    persistence.clearRecovery(A);

    const copyLoaded = await loadStored(store!, saved.project.uri);
    expect(copyLoaded).not.toBeNull();
    expect(copyLoaded!.revision).toBe(0);
    expect(copyLoaded!.objects.length).toBe(base.objects.length + 2);
    // 旧恢复快照内容为 base+1（未被误当副本源）；重试保存已把快照落盘到 A
    const storedA = await loadStored(store!, A);
    expect(storedA!.objects.length).toBe(base.objects.length + 1);
    expect(persistence.getRecoverySnapshot(A)).toBeNull();
    await persistence.dispose();
  });
});

describe('ProjectPersistence：第九轮 #1/#2/#4 回归（切换广播、导出预检先于克隆、往返回归）', () => {
  it('reloadOpenProject 的最终切换只广播一次 save-state —— 序列无中间态（第九轮 #1）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('重载项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await settle(60); // rev1 已存

    const states: string[] = [];
    runtime.persistence.events.on('save-state', ({ state }) => states.push(state.status));
    const reloaded = await runtime.persistence.reloadOpenProject();
    expect(reloaded.ok).toBe(true);
    // 切换期间 resetTo/编辑器事件分发产生的中间态全部被广播守卫吸收：
    // 监听器只收到分发返回后按最新编辑器状态发布的唯一一次最终态
    expect(states).toEqual(['clean']);
    expect(runtime.editor.getProject()!.revision).toBe(1);
    await runtime.dispose();
  });

  it('exportCurrent 真实入口：非纯对象（Date）在开时被编辑器拒绝；BigInt 由编码预检在投影后归一为类型化失败（第九轮 #2 + 第十三轮：显式 allowlist 放行时拒绝）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('不可导出');
    // 非纯对象（Date）：编辑器开时 JSON 纯结构校验直接拒绝 —— 这类值根本到不了
    // 导出路径（exportCurrent 的预检在编辑器保证之上兜底，防御纵深）
    await expect(
      runtime.openProject({ ...project, pluginData: { 'com.example': { at: new Date() } } } as Project),
    ).rejects.toThrow(/JSON 结构/);

    // BigInt 是原始值：通过编辑器开时校验进入项目，但 JSON.stringify 会抛
    // TypeError —— 修复前 exportCurrent 在序列化阶段裸抛异常（调用方拿到崩溃而
    // 非类型化失败）；修复后编码预检在最终投影视图上拒绝（投影剥离的契约外
    // BigInt 不阻断导出，见上一测试）
    const opened = await runtime.openProject({
      ...project,
      pluginData: { 'com.example': { big: 9007199254740993n } },
    } as Project);
    expect(opened.ok).toBe(true);
    // 未注册插件（无声明映射）：命名空间排除 → 导出成功
    expect(runtime.persistence.exportCurrent({ includePrivate: true }).ok).toBe(true);
    // 空 allowlist（已注册但无公开字段）：整段排除 → 导出成功（第十三轮阻断 2 反转）
    expect(
      runtime.persistence.exportCurrent({ includePrivate: true, publicKeysByPlugin: { 'com.example': [] } }).ok,
    ).toBe(true);
    // 字符串声明仅允许叶值（null/string/number/boolean）：BigInt 非叶值 →
    // 声明被剥离，包正常导出且不含该字段（第十五轮阻断 1：BigInt 走不了
    // 投影，编码预检的 bigint 拒绝改由契约字段承载，见下）
    const stripped = await runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['big'] },
    });
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    expect(stripped.text).not.toContain('"big"');
    // 不含私有设置时 pluginData 不进包：导出成功
    expect(runtime.persistence.exportCurrent().ok).toBe(true);
    await runtime.dispose();

    // 契约承载路径（绕过编辑器 schema 校验直接注入投影视图）：BigInt 经契约
    // 字段原样进入最终投影 → 编码预检归一为类型化失败（第九轮 #2 语义保留）
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB });
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue({
      ...createSampleProject('lumora://project/big', 'BigInt 项目'),
      settings: { fps: 9007199254740993n as unknown as number, aspect: [16, 9] } as unknown as Project['settings'],
    } as Project);
    try {
      const result = persistence.exportCurrent({ includePrivate: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('无法导出');
      expect(result.message).toContain('bigint-value');
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });

  it('导出导入往返 + 键级 allowlist（第十三轮阻断 2）：显式声明的键进包，未声明键（含凭据形态键名）排除', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('往返回归');
    runtime.openProject({
      ...project,
      pluginData: {
        'com.example': {
          keyboardLayout: 'kb-intl',
          tokenizerConfig: 'cl100k-base',
          monkeyPatch: 'off',
          hotkeyMap: 'default',
          apiKey: 'sk-leak-1',
          clientSecret: 'client-secret-2',
        },
      },
    } as Project);
    await settle(40);

    // 无声明映射（未注册插件）：命名空间 fail-closed 排除 —— 凭据形态值绝不进包
    // （第十二轮阻断 2）
    const excludedExport = runtime.persistence.exportCurrent({ includePrivate: true });
    expect(excludedExport.ok).toBe(true);
    if (!excludedExport.ok) return;
    expect(excludedExport.text).not.toContain('sk-leak-1');
    expect(excludedExport.text).not.toContain('client-secret-2');

    // 已注册插件（空声明）：无公开字段 —— 整段排除，凭据形态键名同样绝不进包
    // （第十三轮阻断 2 反转：已注册但空声明不再整段放行）
    const rawExport = runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': [] },
    });
    expect(rawExport.ok).toBe(true);
    if (!rawExport.ok) return;
    expect(rawExport.text).not.toContain('sk-leak-1');
    expect(rawExport.text).not.toContain('client-secret-2');

    // 显式 allowlist：只有声明的键进包，未声明键排除；凭据形态键名（apiKey/
    // clientSecret）的声明命中 → 导出失败（第二十五轮指令 3：不再静默丢弃，
    // 插件作者可见的带错误码校验失败）—— 即使显式声明也不得进包，绝不出现
    // 「插件声明了就放行」的凭据出口
    const rejectedExport = runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['keyboardLayout', 'monkeyPatch', 'apiKey', 'clientSecret'] },
    });
    expect(rejectedExport.ok).toBe(false);
    if (rejectedExport.ok) return;
    expect(rejectedExport.message).toContain('凭据永不导出');
    expect(rejectedExport.message).toContain('apiKey');
    const exported = runtime.persistence.exportCurrent({
      includePrivate: true,
      publicKeysByPlugin: { 'com.example': ['keyboardLayout', 'monkeyPatch'] },
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.text).toContain('kb-intl');
    expect(exported.text).toContain('"off"');
    expect(exported.text).not.toContain('sk-leak-1');
    expect(exported.text).not.toContain('client-secret-2');

    const imported = await runtime.persistence.importPackage(exported.text);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const plugin = (imported.project.pluginData as Record<string, Record<string, string>>)['com.example'];
    expect(plugin.keyboardLayout).toBe('kb-intl');
    expect(plugin.monkeyPatch).toBe('off');
    expect(plugin.tokenizerConfig).toBeUndefined();
    expect(plugin.hotkeyMap).toBeUndefined();
    expect(plugin.apiKey).toBeUndefined();
    expect(plugin.clientSecret).toBeUndefined();

    // 导入结果可正常打开（往返内容与编辑器不变量兼容）
    runtime.openProject(imported.project);
    await settle(40);
    expect(runtime.editor.getProject()!.name).toBe('往返回归');
    await runtime.dispose();
  });
});

describe('ProjectPersistence：facade 事件桥代际失效（第十轮 #1 阻断回归）', () => {
  it('persistence.events 双监听器同步重入 —— 陈旧 clean 不穿过事件桥送达监听器 2', async () => {
    const runtime = await makeRuntime();
    const base = runtime.persistence.createProject('facade 重入');
    runtime.openProject(base);
    await settle(60); // 首存落盘 → clean

    const events = runtime.persistence.events;
    const seq2: string[] = [];
    let reentered = false;
    // 监听器 1 在最终 clean 广播中同步提交编辑（嵌套 dirty 分发立即开始）；
    // 修复前 autosaver 内层代际失效只终止 autosaver 自己的监听器迭代 —— bridge
    // 转发到 persistence.events 后，外层 TypedEventEmitter 分发不终止，监听器 2
    // 在嵌套 dirty 之后仍收到陈旧的 clean（倒置序列 dirty → clean）
    events.on('save-state', (e) => {
      if (e.state.status === 'clean' && !reentered) {
        reentered = true;
        runtime.editor.addObject(createGroupObject());
      }
    });
    events.on('save-state', (e) => seq2.push(e.state.status));

    runtime.editor.addObject(createGroupObject()); // 触发一次保存 → 完成后广播 clean
    await settle(120);
    expect(reentered).toBe(true);

    const statuses = seq2;
    for (let i = 0; i < statuses.length - 1; i += 1) {
      expect([statuses[i], statuses[i + 1]]).not.toEqual(['dirty', 'clean']);
    }
    expect(seq2).toContain('dirty');
    expect(seq2.at(-1)).toBe('clean');
    // 重入编辑保留（两次编辑都在，未被陈旧分发覆盖）
    expect(runtime.editor.getProject()!.objects.length).toBe(base.objects.length + 2);
    await runtime.dispose();
  });

  it('onAny 同边界 —— 陈旧 clean 同样不送达 onAny 监听器', async () => {
    const runtime = await makeRuntime();
    const base = runtime.persistence.createProject('facade onAny');
    runtime.openProject(base);
    await settle(60);

    const events = runtime.persistence.events;
    const anySeq: string[] = [];
    let reentered = false;
    events.on('save-state', (e) => {
      if (e.state.status === 'clean' && !reentered) {
        reentered = true;
        runtime.editor.addObject(createGroupObject());
      }
    });
    events.onAny((event, payload) => {
      if (event === 'save-state') {
        anySeq.push((payload as { state: { status: string } }).state.status);
      }
    });

    runtime.editor.addObject(createGroupObject());
    await settle(120);
    expect(reentered).toBe(true);

    const statuses = anySeq;
    for (let i = 0; i < statuses.length - 1; i += 1) {
      expect([statuses[i], statuses[i + 1]]).not.toEqual(['dirty', 'clean']);
    }
    expect(anySeq).toContain('dirty');
    expect(anySeq.at(-1)).toBe('clean');
    expect(runtime.editor.getProject()!.objects.length).toBe(base.objects.length + 2);
    await runtime.dispose();
  });
});

describe('ProjectPersistence：复制路径保存后统一验证与失败清理（第十一轮严重 #3 回归）', () => {
  /** 故障存储探针：save 永远成功（写入成功 ≠ 数据可用），load 返回损坏记录
   *  （settings.fps 非法 → 校验拒绝），removeIfUnchanged 由断言观测。 */
  function corruptStore(): { store: ProjectStorage; removeIfUnchanged: ReturnType<typeof vi.fn> } {
    const corruptRecord: Project = {
      ...createSampleProject('lumora://project/corrupt', '损坏副本'),
      settings: { fps: 'bad' } as unknown as Project['settings'],
    };
    const removeIfUnchanged = vi.fn(
      async (_uri: string, _expectedFingerprint: string | null) => ({ ok: true, outcome: 'removed' }) as const,
    );
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: true, items: [] })),
      load: vi.fn(async () => ({ ok: true, project: corruptRecord } as const)),
      save: vi.fn(async (_project: Project, _expected?: number | null) => ({ ok: true } as const)),
      remove: vi.fn(async () => ({ ok: true, removed: true } as const)),
      removeIfUnchanged,
      rename: vi.fn(async (_uri: string, _name: string) => ({ ok: true } as const)),
      duplicate: vi.fn(
        async (_uri: string, _name?: string) =>
          ({ ok: false, code: 'not-found', message: 'not mocked' }) as const,
      ),
      close: vi.fn(),
    };
    return { store, removeIfUnchanged };
  }

  it('saveSnapshotAsNew：保存成功但副本无法通过校验 → 返回错误并清除记录', async () => {
    const editor = new SceneEditor();
    const { store, removeIfUnchanged } = corruptStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store });

    const result = await persistence.saveSnapshotAsNew(
      createSampleProject('lumora://project/src', '源项目'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('副本保存失败');
    expect(result.message).toContain('校验');
    expect(store.save).toHaveBeenCalledTimes(1);
    // 清理探针：CAS 清理按创建指纹执行 —— 未通过的副本不得留在最近项目列表
    expect(removeIfUnchanged).toHaveBeenCalledTimes(1);
    expect(removeIfUnchanged).toHaveBeenCalledWith(expect.stringMatching(/^lumora:\/\/project\//), expect.any(String));
    await persistence.dispose();
  });

  it('duplicateProject（当前项目分支）：保存成功但副本无法通过校验 → 返回 storage-error 并清除记录', async () => {
    const editor = new SceneEditor();
    const { store, removeIfUnchanged } = corruptStore();
    const persistence = new ProjectPersistence(editor);
    // 先接监听再打开：openProject 的 project:changed 需被 facade 捕获（currentUri 分流）
    editor.openProject(createSampleProject('lumora://project/open', '打开中项目'));
    await persistence.init({ store });

    const result = await persistence.duplicateProject('lumora://project/open');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('storage-error');
    expect(result.message).toContain('副本保存失败');
    expect(result.message).toContain('校验');
    expect(removeIfUnchanged).toHaveBeenCalledTimes(1);
    await persistence.dispose();
  });

  it('验证阶段 loadProject reject（load 抛异常）→ 类型化失败并清除副本（第十二轮严重 #5）', async () => {
    const editor = new SceneEditor();
    const removeIfUnchanged = vi.fn(
      async (_uri: string, _expectedFingerprint: string | null) => ({ ok: true, outcome: 'removed' }) as const,
    );
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: true, items: [] })),
      load: vi.fn(async () => {
        throw new Error('idb transaction aborted');
      }),
      save: vi.fn(async (_project: Project, _expected?: number | null) => ({ ok: true } as const)),
      remove: vi.fn(async () => ({ ok: true, removed: true } as const)),
      removeIfUnchanged,
      rename: vi.fn(async (_uri: string, _name: string) => ({ ok: true } as const)),
      duplicate: vi.fn(
        async (_uri: string, _name?: string) =>
          ({ ok: false, code: 'not-found', message: 'not mocked' }) as const,
      ),
      close: vi.fn(),
    };
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store });

    const result = await persistence.saveSnapshotAsNew(
      createSampleProject('lumora://project/src', '源项目'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('副本保存失败');
    expect(result.message).toContain('验证异常');
    // 清理探针：reject 的副本同样被清除 —— 绝不遗留损坏/状态未知的副本
    expect(removeIfUnchanged).toHaveBeenCalledTimes(1);
    expect(removeIfUnchanged).toHaveBeenCalledWith(expect.stringMatching(/^lumora:\/\/project\//), expect.any(String));
    await persistence.dispose();
  });

  it('清理阶段 removeIfUnchanged 失败 → 不掩盖验证失败：明确提示「记录保留、可手动删除」，残留记录仍在存储（第十三轮严重 #5）', async () => {
    const editor = new SceneEditor();
    const corruptRecord: Project = {
      ...createSampleProject('lumora://project/corrupt', '损坏副本'),
      settings: { fps: 'bad' } as unknown as Project['settings'],
    };
    let copyUri = '';
    const removeIfUnchanged = vi.fn(async (uri: string, _expectedFingerprint: string | null) => {
      copyUri = uri;
      return { ok: false, message: 'idb transaction aborted' } as const;
    });
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: true, items: [] })),
      load: vi.fn(async () => ({ ok: true, project: corruptRecord } as const)),
      save: vi.fn(async (_project: Project, _expected?: number | null) => ({ ok: true } as const)),
      remove: vi.fn(async () => ({ ok: true, removed: true } as const)),
      removeIfUnchanged,
      rename: vi.fn(async (_uri: string, _name: string) => ({ ok: true } as const)),
      duplicate: vi.fn(
        async (_uri: string, _name?: string) =>
          ({ ok: false, code: 'not-found', message: 'not mocked' }) as const,
      ),
      close: vi.fn(),
    };
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store });

    const result = await persistence.saveSnapshotAsNew(
      createSampleProject('lumora://project/src', '源项目'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 清理失败不掩盖验证失败：调用方仍拿到明确失败，绝不报告成功
    expect(result.message).toContain('副本保存失败');
    expect(result.message).toContain('校验');
    // 清理失败如实提示记录保留、可手动删除（修复前 remove 的 reject 被吞掉，
    // 损坏副本静默残留且无任何提示）
    expect(result.message).toContain('记录保留');
    expect(result.message).toContain('可手动删除');
    // 残留记录断言：CAS 清理被拒 → 损坏副本记录仍在存储中（load 仍可读到）
    expect(removeIfUnchanged).toHaveBeenCalledTimes(1);
    expect(copyUri).toMatch(/^lumora:\/\/project\//);
    expect(await loadStored(store, copyUri)).not.toBeNull();
    await persistence.dispose();
  });

  it('副本清理 CAS：验证失败时记录已被另一会话更新 → 保留记录并如实提示（第十四轮严重 4）', async () => {
    const editor = new SceneEditor();
    const corruptRecord: Project = {
      ...createSampleProject('lumora://project/corrupt', '损坏副本'),
      settings: { fps: 'bad' } as unknown as Project['settings'],
    };
    const removeIfUnchanged = vi.fn(
      async (_uri: string, _expectedFingerprint: string | null) => ({ ok: true, outcome: 'changed' }) as const,
    );
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: true, items: [] })),
      load: vi.fn(async () => ({ ok: true, project: corruptRecord } as const)),
      save: vi.fn(async (_project: Project, _expected?: number | null) => ({ ok: true } as const)),
      remove: vi.fn(async () => ({ ok: true, removed: true } as const)),
      removeIfUnchanged,
      rename: vi.fn(async (_uri: string, _name: string) => ({ ok: true } as const)),
      duplicate: vi.fn(
        async (_uri: string, _name?: string) =>
          ({ ok: false, code: 'not-found', message: 'not mocked' }) as const,
      ),
      close: vi.fn(),
    };
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store });

    const result = await persistence.saveSnapshotAsNew(
      createSampleProject('lumora://project/src', '源项目'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 验证失败结论不变；清理按 CAS 执行，记录已变化时如实提示保留（修复前
    // remove 无条件删除，会误删另一标签页已打开并保存的更新后合法记录）
    expect(result.message).toContain('副本保存失败');
    expect(result.message).toContain('副本记录已变化');
    expect(result.message).toContain('已保留');
    expect(removeIfUnchanged).toHaveBeenCalledTimes(1);
    expect(removeIfUnchanged).toHaveBeenCalledWith(
      expect.stringMatching(/^lumora:\/\/project\//),
      expect.any(String), // 创建时指纹：记录已变化即不删除
    );
    await persistence.dispose();
  });

  it('loadCopyForOpen：load reject → 类型化失败并 CAS 清理副本，不产生未处理 reject（第十四轮严重 5）', async () => {
    const editor = new SceneEditor();
    const removeIfUnchanged = vi.fn(
      async (_uri: string, _expectedFingerprint: string | null) => ({ ok: true, outcome: 'removed' }) as const,
    );
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: true, items: [] })),
      load: vi.fn(async () => {
        throw new Error('idb transaction aborted');
      }),
      save: vi.fn(async (_project: Project, _expected?: number | null) => ({ ok: true } as const)),
      remove: vi.fn(async () => ({ ok: true, removed: true } as const)),
      removeIfUnchanged,
      rename: vi.fn(async (_uri: string, _name: string) => ({ ok: true } as const)),
      duplicate: vi.fn(
        async (_uri: string, _name?: string) =>
          ({ ok: false, code: 'not-found', message: 'not mocked' }) as const,
      ),
      close: vi.fn(),
    };
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store });

    const result = await persistence.loadCopyForOpen('lumora://project/copy', 'fingerprint-at-create');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('无法打开副本');
    // 副本清理按创建时指纹 CAS 执行；load 的 reject 被归一为类型化失败
    expect(removeIfUnchanged).toHaveBeenCalledTimes(1);
    expect(removeIfUnchanged).toHaveBeenCalledWith('lumora://project/copy', 'fingerprint-at-create');
    await persistence.dispose();
  });

  /** 第十五轮严重 5 回归：入口级异常归一专用 store（默认全成功，按需覆盖） */
  function okStore(overrides: Partial<ProjectStorage> = {}): ProjectStorage {
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: true, items: [] })),
      load: vi.fn(async () => ({ ok: true, project: null } as const)),
      save: vi.fn(async () => ({ ok: true }) as const),
      remove: vi.fn(async () => ({ ok: true, removed: true } as const)),
      removeIfUnchanged: vi.fn(async () => ({ ok: true, outcome: 'removed' }) as const),
      rename: vi.fn(async () => ({ ok: true }) as const),
      duplicate: vi.fn(async () => ({ ok: false, code: 'not-found', message: 'not mocked' }) as const),
      close: vi.fn(),
    };
    return { ...store, ...overrides };
  }

  it('saveSnapshotAsNew：store.save 意外 reject → 类型化「另存副本失败」，绝不向上抛（第十五轮严重 5）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({
      store: okStore({
        save: vi.fn(async () => {
          throw new Error('quota exceeded');
        }),
      }),
    });

    const result = await persistence.saveSnapshotAsNew(
      createSampleProject('lumora://project/src', '源项目'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('另存副本失败');
    expect(result.message).toContain('quota exceeded');
    await persistence.dispose();
  });

  it('duplicateProject（当前项目分支）：store.save 意外 reject → 类型化 storage-error（第十五轮严重 5）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    editor.openProject(createSampleProject('lumora://project/open', '打开中项目'));
    await persistence.init({
      store: okStore({
        save: vi.fn(async () => {
          throw new Error('quota exceeded');
        }),
      }),
    });

    const result = await persistence.duplicateProject('lumora://project/open');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('storage-error');
    expect(result.message).toContain('复制失败');
    expect(result.message).toContain('quota exceeded');
    await persistence.dispose();
  });

  it('duplicateProject（存储复制分支）：store.duplicate 意外 reject（源 load 抛错传播）→ 类型化 storage-error（第十五轮严重 5）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({
      store: okStore({
        duplicate: vi.fn(async () => {
          throw new Error('idb transaction aborted');
        }),
      }),
    });

    const result = await persistence.duplicateProject('lumora://project/closed');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('storage-error');
    expect(result.message).toContain('复制失败');
    expect(result.message).toContain('idb transaction aborted');
    await persistence.dispose();
  });

  it('dispose 竞态：释放后调用复制入口返回类型化「本地持久化不可用」，不抛异常（第十五轮严重 5）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store: okStore() });
    await persistence.dispose();

    const dup = await persistence.duplicateProject('lumora://project/x');
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.code).toBe('not-found');
    expect(dup.message).toContain('本地持久化不可用');

    const copy = await persistence.saveSnapshotAsNew(createSampleProject('lumora://project/src', '源项目'));
    expect(copy.ok).toBe(false);
    if (copy.ok) return;
    expect(copy.message).toContain('本地持久化不可用');
  });
});

describe('ProjectPersistence：exportCurrent 全链路逐层负向回归（第十三轮阻断 1 / 严重 3）', () => {
  it('对象子结构（camera/material）嵌套契约外字段默认导出与 includePrivate 一律不进包，契约字段保留', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('逐层投影');
    const object = project.objects[0]!;
    const rich = {
      ...project,
      objects: project.objects.map((o) =>
        o.id === object.id
          ? {
              ...o,
              camera: {
                projection: 'perspective',
                focalLength: 50,
                fov: 45,
                sensorWidth: 36,
                sensorHeight: 24,
                near: 0.1,
                far: 200,
                aspect: null,
                apiKey: 'cam-secret',
                credentials: 'cam-cred',
              },
              material: { color: '#ffffff', apiKey: 'mat-secret' },
            }
          : o,
      ),
    } as unknown as Project;
    const opened = await runtime.openProject(rich);
    expect(opened.ok).toBe(true);
    await settle(40);

    const cases = [
      {},
      { includePrivate: true, publicKeysByPlugin: { 'com.example': [] } },
    ] as Array<Parameters<ProjectPersistence['exportCurrent']>[0]>;
    for (const options of cases) {
      const result = runtime.persistence.exportCurrent(options);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const leaked of ['cam-secret', 'cam-cred', 'mat-secret']) {
        expect(result.text, `${leaked}（${JSON.stringify(options)}）不得进入包`).not.toContain(leaked);
      }
      // 契约字段完整保留：子结构投影不丢公开数据
      expect(result.text).toContain('"focalLength": 50');
      expect(result.text).toContain('"sensorWidth": 36');
      expect(result.text).toContain('"color": "#ffffff"');
    }
    await runtime.dispose();
  });

  it('资产分件数组非索引 own 键 → 类型化失败，不产出丢字段的包', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, dbName: DB });
    const parts = [
      { path: 'mesh.bin', mime: 'application/octet-stream', payload: 'AAA=' },
    ] as unknown as Array<Record<string, unknown>>;
    (parts as unknown as Record<string, unknown>).extra = '非索引键';
    const withParts = {
      ...createSampleProject('lumora://project/parts', '分件项目'),
      assets: [
        {
          id: 'asset-parts-1',
          kind: 'gltf',
          name: '测试模型.gltf',
          format: 'gltf',
          mime: 'model/gltf+json',
          hash: 'deadbeef',
          size: 4,
          source: 'file',
          storageRef: 'blob:runtime-only',
          payload: 'eyJ4Ijo1fQ==',
          parts,
          createdAt: new Date().toISOString(),
        },
      ],
    } as unknown as Project;
    const spy = vi.spyOn(editor, 'getProject').mockReturnValue(withParts);
    try {
      const result = persistence.exportCurrent();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('无法导出');
      expect(result.message).toContain('非索引属性 extra');
    } finally {
      spy.mockRestore();
      await persistence.dispose();
    }
  });
});

describe('ProjectPersistence：facade 对存储故障的统一归一（第十七轮严重 4）', () => {
  it('listRecent/loadProject/deleteProject/hasLocal：存储类型化失败 → 带上下文错误或类型化失败，绝不向上抛裸值', async () => {
    const editor = new SceneEditor();
    const store: ProjectStorage = {
      kind: 'indexeddb',
      list: vi.fn(async (): Promise<ListOutcome> => ({ ok: false, message: 'idb transaction aborted' })),
      load: vi.fn(async (): Promise<LoadOutcome> => ({ ok: false, message: 'idb transaction aborted' })),
      save: vi.fn(async () => ({ ok: true }) as const),
      remove: vi.fn(async (): Promise<RemoveOutcome> => ({ ok: false, message: 'idb transaction aborted' })),
      removeIfUnchanged: vi.fn(async () => ({ ok: true, outcome: 'removed' }) as const),
      rename: vi.fn(async () => ({ ok: true }) as const),
      duplicate: vi.fn(async () => ({ ok: false, code: 'not-found', message: 'not mocked' }) as const),
      close: vi.fn(),
    };
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ store });

    await expect(persistence.listRecent()).rejects.toThrow('最近项目加载失败：idb transaction aborted');
    await expect(persistence.hasLocal('lumora://project/a')).rejects.toThrow(
      '项目存在性检查失败：idb transaction aborted',
    );
    await expect(persistence.deleteProject('lumora://project/a')).rejects.toThrow(
      '项目删除失败：idb transaction aborted',
    );
    const loaded = await persistence.loadProject('lumora://project/a');
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.message).toContain('本地项目加载失败：idb transaction aborted');
    await persistence.dispose();
  });
});

describe('ProjectPersistence：第二十八轮回归（多 fork 恢复 / drain waiter / dispose 传播 / 锁存语义 / generation 绑定）', () => {
  it('阻断2：同 uri 多次保存失败各自保留恢复 fork；重试最新成功后旧 fork 保留、旧内容仍可恢复', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store }); // 长防抖隔离自动保存

    const A = 'lumora://project/multifork';
    const base = createSampleProject(A, '多fork项目');
    editor.openProject(base);
    await settle(10); // 首存成功 → 基线 rev0

    const failSpy = vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));

    // 第一次失败：编辑（rev1）→ 切换走 → drain 失败 → fork1（内容 base+1）
    editor.addObject(createGroupObject());
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/other1', '其他项目'));
    await settle(60);
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();

    // 第二次失败：重开 A（原内容，对账锁存 recovery-available）→ 编辑两次
    // （rev2，内容 base+2，与 fork1 指纹不同）→ 切换走 → drain 失败 → fork2
    editor.openProject({ ...base });
    await settle(60);
    editor.addObject(createGroupObject());
    editor.addObject(createGroupObject());
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/other2', '其他项目二'));
    await settle(60);
    failSpy.mockRestore();

    // 两个 fork 各自保留；getRecoverySnapshot 返回最新代（fork2）
    const latest = persistence.getRecoverySnapshot(A);
    expect(latest).not.toBeNull();
    expect(latest!.objects.length).toBe(base.objects.length + 2);

    // 重试最新 fork2 → 成功落盘，只清除本代 fork
    const outcome = await persistence.retryRecovery(A);
    expect(outcome.ok).toBe(true);
    // 旧 fork1 仍在恢复区（内容仅存恢复区，仍可另存副本）
    const oldFork = persistence.getRecoverySnapshot(A);
    expect(oldFork).not.toBeNull();
    expect(oldFork!.objects.length).toBe(base.objects.length + 1);
    // 旧 fork1 内容已被磁盘较新内容覆盖：重试被 CAS 拒绝（防倒退），fork 保留
    const oldOutcome = await persistence.retryRecovery(A);
    expect(oldOutcome.ok).toBe(false);
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();
    await persistence.dispose();
  });

  it('阻断3：慢保存挂起期间大量 drain 入队（超容量淘汰）时，flush 仍读到本会话代的真实失败，不误报成功', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });

    const A = 'lumora://project/slow-a';
    editor.openProject(createSampleProject(A, '慢速项目'));
    await settle(10); // 首存成功 rev0

    const realSave = store.save.bind(store);
    let call = 0;
    const saveSpy = vi.spyOn(store, 'save').mockImplementation(async (project, expected) => {
      call += 1;
      if (call === 1) {
        // flush 自身保存：慢（50ms）→ 真实成功 —— 磁盘推进到 rev1
        await new Promise((r) => setTimeout(r, 50));
        return realSave(project, expected);
      }
      if (call === 2) {
        // 切换入队的 superseding drain（本会话代）：慢（50ms）→ 失败 ——
        // 本代 drain 结果必须是 flush 读到的最终裁决
        await new Promise((r) => setTimeout(r, 50));
        return { ok: false, code: 'storage-error' as const, message: '保存失败' };
      }
      return realSave(project, expected);
    });

    editor.addObject(createGroupObject()); // A rev1 → dirty
    const flushing = persistence.flushPending(); // 不 await：保存挂起中
    await settle(10); // flush 任务已开始慢保存（call 1）
    // 挂起期间 17 轮切换：每轮入队一个新 epoch 的 drain（超 DRAIN_OUTCOME_KEEP=16），
    // 淘汰循环只淘汰无 waiter 的记录 —— 修复前本代记录被淘汰、flush 回落到基线
    // 比较误报成功；修复后入队时即注册 waiter，读到本代 drain 的真实失败并传播
    for (let i = 0; i < 17; i += 1) {
      editor.addObject(createGroupObject());
      editor.openProject(createSampleProject(`lumora://project/other-${i}`, `其他${i}`));
      await settle(5);
    }
    const outcome = await flushing;
    expect(outcome.ok).toBe(false);
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull(); // A 的失败内容已入录恢复区
    saveSpy.mockRestore();
    await persistence.dispose();
  });

  it('阻断4：dispose 冲刷失败如实返回失败且不 teardown；恢复存储后重试 dispose 成功', async () => {
    const runtime = await makeRuntime();
    const uri = 'lumora://project/dispose-fail';
    await runtime.openProject(createSampleProject(uri, 'dispose项目'));
    await settle(40); // 首存成功

    const store = (runtime.persistence as unknown as { store: ProjectStorage | null }).store!;
    const saveSpy = vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    try {
      runtime.editor.addObject(createGroupObject()); // dirty
      await settle(60); // 自动保存失败 → error 状态

      const outcome = await runtime.dispose();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.message).toContain('保存失败');
      // 不 teardown：编辑器与存储保留（可重试/另存副本），绝不假装已卸载
      expect(runtime.getProject()).not.toBeNull();
      expect(runtime.persistence.available).toBe(true);
    } finally {
      saveSpy.mockRestore();
      // 恢复存储后重试 dispose 成功（teardown 完成）
      const retry = await runtime.dispose();
      expect(retry.ok).toBe(true);
    }
  });

  it('严重5：同 uri 更新代内容落盘成功不清前代恢复 fork —— 仍锁存 recovery-available，绝不发 clean', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });

    const A = 'lumora://project/s5';
    const base = createSampleProject(A, 'S5项目');
    // 全程模拟存储故障：首存失败（无本地记录）→ 编辑 → 切换走 → drain 失败入录 fork
    const failSpy = vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.openProject(base);
    await settle(60);
    editor.addObject(createGroupObject()); // rev1（fork 内容 = base+1）
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/other', '其他项目'));
    await settle(60);
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();
    failSpy.mockRestore();

    // 重开 A（原内容）：对账发现无本地记录 → 首存（创建语义）成功 →
    // applySaveResult 成功路径：落盘指纹（base）≠ 前代恢复 fork 指纹（base+1）
    // → 不清除 fork、仍锁存 recovery-available 且不发 clean —— 修复前直接
    // 清 latch 发 clean，旧 fork 沉没不可恢复
    const states: Array<{ status: string; code?: string }> = [];
    persistence.events.on('save-state', ({ state }) => states.push(state));
    editor.openProject({ ...base });
    await settle(60);
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull(); // 前代 fork 保留
    expect(states[states.length - 1]?.status).toBe('error');
    expect(states[states.length - 1]?.code).toBe('recovery-available');
    expect(states.some((s) => s.status === 'clean')).toBe(false);
    await persistence.dispose();
  });

  it('严重6：重试保存挂起期间恢复记录被清除 → 本次重试取消，不 switchOpen、不报 clean', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });

    const A = 'lumora://project/s6';
    const base = createSampleProject(A, 'S6项目');
    editor.openProject(base);
    await settle(10); // 首存成功 rev0

    // 制造恢复 fork：编辑 → 切换走 → drain 保存失败入录
    const failSpy = vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject());
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/other', '其他项目'));
    await settle(60);
    failSpy.mockRestore();
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();

    // 慢速重试：保存挂起期间恢复记录被清除（用户已「另存副本」等显式决定）
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async (project, expected) => {
      await new Promise((r) => setTimeout(r, 40));
      return realSave(project, expected);
    });
    const retrying = persistence.retryRecovery(A);
    await settle(20); // 保存挂起中
    persistence.clearRecovery(A);
    const outcome = await retrying;
    // 该代恢复记录已不存在：本次重试取消（磁盘已推进无害），不触碰 latch/恢复区
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('revision-conflict');
      expect(outcome.message).toContain('已取消');
    }
    // 编辑器未被 switchOpen 覆盖（仍是其他项目），恢复区已空
    expect(editor.getProject()!.uri).not.toBe(A);
    expect(persistence.getRecoverySnapshot(A)).toBeNull();
    await persistence.dispose();
  });
});
