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
    expect(source!.source.objects.length).toBe(base.objects.length + 2);
    expect(source!.generation).toBeNull(); // 编辑器现场源：不绑定代数
    const saved = await persistence.saveSnapshotAsNew(source!.source);
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

describe('ProjectPersistence：第三十轮回归（重试代隔离：陈旧失败不锁存不广播 / 陈旧成功不清较新锁存）', () => {
  // 第三十一轮阻断 2 后锁存按 uri 分键：缺省读当前 uri（等价旧单一 getter），
  // 显式传 uri 可读非当前项目的锁存（该 uri 的解决入口仍保留在 latchedByUri 中）
  const latchedOf = (
    p: ProjectPersistence,
    uri?: string,
  ): { uri: string; code: string } | null => {
    const autosaver = (
      p as unknown as {
        autosaver: {
          currentUri: string | null;
          latchedByUri: Map<string, { uri: string; code: string }>;
        };
      }
    ).autosaver;
    const key = uri ?? autosaver.currentUri;
    if (key === null) return null;
    return autosaver.latchedByUri.get(key) ?? null;
  };

  it('阻断4：重试保存失败期间恢复记录被清除 → 取消且不锁存冲突、不向当前项目广播（非当前 uri）', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });

    const A = 'lumora://project/r30a';
    editor.openProject(createSampleProject(A, 'A项目'));
    await settle(10); // 首存成功 rev0

    // 制造恢复 fork：编辑 → 切换走 → drain 保存失败入录（当前已切到 other）
    const failSpy = vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject());
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/r30a-other', '其他项目'));
    await settle(60);
    failSpy.mockRestore();
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();
    expect(latchedOf(persistence)).toBeNull();

    // 慢速失败重试（revision-conflict）：保存挂起期间恢复记录被清除 → 该代已失效
    const states: Array<{ status: string; code?: string }> = [];
    persistence.events.on('save-state', ({ state }) => states.push(state));
    vi.spyOn(store, 'save').mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { ok: false, code: 'revision-conflict' as const, message: 'CAS 冲突' };
    });
    const retrying = persistence.retryRecovery(A);
    await settle(20); // 保存挂起中
    persistence.clearRecovery(A);
    const outcome = await retrying;
    // 陈旧失败不得锁存冲突（修复前直接 latch revision-conflict 并广播）：
    // 取消返回，锁存保持原状（null），恢复区已空
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('revision-conflict');
      expect(outcome.message).toContain('恢复快照已被清除或更新');
    }
    expect(latchedOf(persistence)).toBeNull();
    // 非当前 uri 的重试失败绝不向当前项目的监听器广播（latch() 仅对当前 uri emit）
    expect(states).toHaveLength(0);
    expect(editor.getProject()!.uri).not.toBe(A);
    expect(persistence.getRecoverySnapshot(A)).toBeNull();
    // 无剩余 fork / 锁存：释放成功
    const disposed = await persistence.dispose();
    expect(disposed.ok).toBe(true);
  });

  it('阻断4：陈旧成功不清较新锁存 —— 重试代被消费后取消，剩余 fork 的 recovery-available 锁存保留，显式解决后释放成功', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });

    const A = 'lumora://project/r30b';
    const base = createSampleProject(A, '双fork项目');
    editor.openProject(base);
    await settle(10); // 首存成功 rev0

    // 两个恢复 fork：gen1（base+1）与 gen2（base+2）
    const failSpy = vi.spyOn(store, 'save').mockImplementation(async () => ({
      ok: false,
      code: 'storage-error' as const,
      message: '保存失败',
    }));
    editor.addObject(createGroupObject());
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/r30b-other1', '其他一'));
    await settle(60);
    editor.openProject({ ...base });
    await settle(60);
    editor.addObject(createGroupObject());
    editor.addObject(createGroupObject());
    await settle(60);
    editor.openProject(createSampleProject('lumora://project/r30b-other2', '其他二'));
    await settle(60);
    failSpy.mockRestore();

    // 最新代 gen2 绑定（重试以最新代为准；「另存副本」决策同一入口）
    const source2 = persistence.resolveSaveAsCopySource(A);
    expect(source2).not.toBeNull();
    expect(source2!.source.objects.length).toBe(base.objects.length + 2);
    // A 非当前 uri：「另存副本」来源绑定该代 fork（generation 必为 number）
    const gen2 = source2!.generation!;
    const fp2 = source2!.fingerprint;

    // 慢速成功重试 gen2：保存挂起期间该代被「另存副本」消费（clearRecoveryGeneration
    // 只消费这一代，gen1 仍在恢复区 → 锁存 recovery-available）
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async (project, expected) => {
      await new Promise((r) => setTimeout(r, 40));
      return realSave(project, expected);
    });
    const retrying = persistence.retryRecovery(A);
    await settle(20); // 保存挂起中
    persistence.clearRecoveryGeneration(A, gen2, fp2);
    expect(latchedOf(persistence, A)).toMatchObject({ uri: A, code: 'recovery-available' });
    const outcome = await retrying;
    // 落盘虽成功，但保存 await 期间该代已被消费 → 本次重试取消
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('revision-conflict');
      expect(outcome.message).toContain('恢复快照已被清除或更新');
    }
    // 陈旧成功不得清除较新锁存（修复前 advanceBaseline 直接清 latch）：剩余 fork
    // gen1 仍以 recovery-available 锁存呈现解决入口，绝不假报已保存
    expect(latchedOf(persistence, A)).toMatchObject({ uri: A, code: 'recovery-available' });
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();
    expect(persistence.getRecoverySnapshot(A)!.objects.length).toBe(base.objects.length + 1);
    // 锁存保留 → 释放仍被拒绝（gen1 内容仅存恢复区，绝不因 teardown 沉没）
    const refused = await persistence.dispose();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('recovery-available');
    // 显式解决（放弃恢复快照）后：锁存解除，释放成功
    persistence.clearRecovery(A);
    expect(latchedOf(persistence, A)).toBeNull();
    const disposed = await persistence.dispose();
    expect(disposed.ok).toBe(true);
  });
});

describe('ProjectPersistence：dispose 幂等合并 single-flight（第三十一轮严重 3）', () => {
  it('并发 dispose 共享同一 in-flight 执行；失败后清空缓存可重试，成功后永久复用', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r31-sf', '并发释放'));

    const autosaver = (
      persistence as unknown as {
        autosaver: {
          preflightDispose: () => Promise<{ ok: boolean; code?: string; message?: string }>;
          dispose: () => Promise<{ ok: boolean; code?: string; message?: string }>;
        };
      }
    ).autosaver;
    // 第三十五轮阻断 1：preflight = autosaver.dispose() 原子封存（flush 失败即
    // 未 teardown、autosaver 完整保留 —— 修复前 commit 段二次调用 dispose()
    // 失败仍强制 teardown 返回 {ok:true}，「可重试」名存实亡）
    const disposeSpy = vi.spyOn(autosaver, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: false, code: 'storage-error', message: '模拟冲刷失败' });

    const first = persistence.dispose();
    const second = persistence.dispose();
    // 非 async 直接返回缓存 promise：并发调用拿到同一对象（发布先行，只执行一次）
    expect(second).toBe(first);
    const outcome = await first;
    expect(outcome).toMatchObject({ ok: false, message: '模拟冲刷失败' });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // 失败后不 teardown：编辑器/store/事件总线都保留，可重试保全内容
    expect(editor.getProject()).not.toBeNull();

    // 失败 settle 后缓存清空 → 重试执行新一轮，成功（编辑器归运行时所有，
    // persistence 层不重置；teardown 证据：store 置空、currentUri 清空）
    disposeSpy.mockRestore();
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
    expect((persistence as unknown as { store: unknown }).store).toBeNull();
    expect((persistence as unknown as { currentUri: unknown }).currentUri).toBeNull();

    // 成功后永久复用成功结果：重复调用幂等，不再触碰 autosaver
    const retrySpy = vi.spyOn(autosaver, 'dispose');
    const again = persistence.dispose();
    const again2 = persistence.dispose();
    expect(again2).toBe(again);
    await expect(again).resolves.toEqual({ ok: true });
    expect(retrySpy).not.toHaveBeenCalled();
    retrySpy.mockRestore();
  });
});

describe('ProjectPersistence：终态释放 best-effort 收敛（第三十二轮阻断 2 + 第三十三轮阻断 2）', () => {
  it('store.close() 抛错：终态仍收敛返回 {ok:true} 并携带失败明细，不冒充可编辑（修复前 {ok:false} 但 autosaver 已永久释放 —— 死壳）', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r33-close-throw', '释放失败'));

    const closeSpy = vi.spyOn(store, 'close');
    closeSpy.mockImplementationOnce(() => {
      throw new Error('模拟关闭失败');
    });
    const outcome = await persistence.dispose();
    // commit 阶段失败不再以 {ok:false} 冒充「运行态完整」：终态已收敛
    // （autosaver 释放、订阅拆除、store 断开、events 清空），失败明细并入
    // message —— 宿主拿到 {ok:true} 即可安全卸载，不会保持挂载面对
    // 「可编辑但不可保存」的死壳（修复前返回 {ok:false}、宿主保持挂载重试，
    // 新编辑不再进 autosave、随重试的编辑器销毁丢失）
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('模拟关闭失败');
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // 终态后 dispose 幂等短路：重试不再触碰 store —— 成功裁决连同失败明细
    // 一并归档复用（与第三十一轮「成功后永久复用同一成功结果对象」同语义，
    // 首轮 message 随裁决保留）
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true, message: '终态释放部分失败：模拟关闭失败' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((persistence as unknown as { store: unknown }).store).toBeNull();
    closeSpy.mockRestore();
  });
});

describe('ProjectPersistence：init/dispose 竞态 —— 晚到 store 收敛关闭（第三十二轮严重 4 + 第三十三轮严重 4）', () => {
  it('存储创建挂起期间 dispose 开始：dispose 与 initPromise 收敛到同一完成点，晚到 store 关闭、不挂到已销毁 persistence', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const lateStore = await openStandaloneStore();
    const closeSpy = vi.spyOn(lateStore, 'close');

    let releaseCreate!: (store: ProjectStore | null) => void;
    const createSpy = vi.spyOn(ProjectStore, 'create').mockImplementationOnce(
      () => new Promise<ProjectStore | null>((resolve) => {
        releaseCreate = resolve;
      }),
    );

    const initPromise = persistence.init({ dbName: 'r33-race' });
    // dispose 在存储创建挂起期间开始：preflight 通过后等待 in-flight init 收敛
    // （第三十三轮严重 4：dispose 与 initPromise 收敛到同一完成点 —— 晚到 store
    // 的关闭由 dispose 的 commit 收敛点执行，失败可传播/重试；修复前 dispose
    // 不等待 init，晚到 store 在 init 内部空 catch 后丢弃唯一引用）
    const disposePromise = persistence.dispose();
    releaseCreate(lateStore); // 晚到的 store 到达 → init 重查发现已释放 → lateStore
    await initPromise;
    const disposeOutcome = await disposePromise;
    expect(disposeOutcome).toEqual({ ok: true });
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    // 晚到 store 真实关闭并丢弃：不挂入、不泄漏
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(persistence.available).toBe(false);
    expect(persistence.backend).toBeNull();
    createSpy.mockRestore();
    closeSpy.mockRestore();
  });

  it('晚到 store 的 close 抛错：并入终态 best-effort message —— ok 仍 true（第三十四轮阻断 3：修复前在 commit 前返回 {ok:false} 可重试，但 autosaver 已终态化 —— 失败与重试间的新编辑不落盘、死壳）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const lateStore = await openStandaloneStore();
    const closeSpy = vi.spyOn(lateStore, 'close');
    closeSpy.mockImplementationOnce(() => {
      throw new Error('模拟晚到存储关闭失败');
    });

    let releaseCreate!: (store: ProjectStore | null) => void;
    const createSpy = vi.spyOn(ProjectStore, 'create').mockImplementationOnce(
      () => new Promise<ProjectStore | null>((resolve) => {
        releaseCreate = resolve;
      }),
    );

    const initPromise = persistence.init({ dbName: 'r33-race-throw' });
    const disposePromise = persistence.dispose();
    releaseCreate(lateStore);
    await initPromise;
    const outcome = await disposePromise;
    // 第三十四轮阻断 3：late close 在 commit 段内（不可回退）—— 失败归档进
    // message、ok 仍为 true：宿主拿到终态即可安全卸载，不存在「可编辑但不可
    // 保存」死壳（修复前返回 {ok:false}，但 autosaver 的 dispose 已置 disposed、
    // 移除监听 —— 宿主保持 UI 重试时 changed() 已 no-op，新编辑不落盘）
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('模拟晚到存储关闭失败');
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    // 终态后幂等短路：重试复用同一裁决（成功裁决连同失败明细归档），不再触碰 store
    const retried = await persistence.dispose();
    expect(retried).toEqual(outcome);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
    closeSpy.mockRestore();
  });

  it('严重 4（第三十四轮）：init 挂起期间 dispose 开始且 preflight 延迟失败 —— 晚到 store 已挂载，编辑可真实落盘（修复前 store 既不挂载也不关闭，连接悬挂、编辑静默退化内存模式）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const lateStore = await openStandaloneStore();
    const closeSpy = vi.spyOn(lateStore, 'close');

    // preflight 延迟失败：dispose 的收敛点先等 init settle（store 挂载），
    // 再跑 preflight（autosaver.dispose 原子封存）并失败 —— 失败后运行态完整
    // （store 已挂载、autosaver 活跃）
    const autosaver = (
      persistence as unknown as {
        autosaver: {
          dispose: () => Promise<{ ok: boolean; code?: string; message?: string }>;
        };
      }
    ).autosaver;
    const preflightSpy = vi.spyOn(autosaver, 'dispose');
    preflightSpy.mockResolvedValueOnce({ ok: false, code: 'storage-error', message: '模拟冲刷失败' });

    let releaseCreate!: (store: ProjectStore | null) => void;
    const createSpy = vi.spyOn(ProjectStore, 'create').mockImplementationOnce(
      () => new Promise<ProjectStore | null>((resolve) => {
        releaseCreate = resolve;
      }),
    );

    const initPromise = persistence.init({ dbName: 'r34-init-preflight-fail' });
    const disposePromise = persistence.dispose();
    releaseCreate(lateStore); // init settle：dispose 尚在收敛点等待（未进 preflighting）→ 正常挂载
    await initPromise;
    expect(persistence.available).toBe(true); // 修复前被转 lateStore 且无人关闭 → available false
    const outcome = await disposePromise;
    expect(outcome).toMatchObject({ ok: false, code: 'storage-error', message: '模拟冲刷失败' });
    // preflight 失败：无任何 teardown —— store 保留挂载、连接不悬挂
    expect(closeSpy).not.toHaveBeenCalled();
    expect(persistence.available).toBe(true);
    // 编辑可真实落盘（修复前编辑静默退化内存模式）
    editor.openProject(createSampleProject('lumora://project/r34-prefail', '延迟失败'));
    editor.addObject(createGroupObject());
    const flush = await persistence.flushPending();
    expect(flush.ok).toBe(true);
    const loaded = await persistence.loadProject('lumora://project/r34-prefail');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }
    preflightSpy.mockRestore();
    createSpy.mockRestore();
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
    closeSpy.mockRestore();
  });

  it('并发 init 共享同一 in-flight 执行（修复前并发调用重复创建存储，早到者泄漏）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const store = await openStandaloneStore();

    let releaseCreate!: (s: ProjectStore | null) => void;
    const createSpy = vi.spyOn(ProjectStore, 'create').mockImplementationOnce(
      () => new Promise<ProjectStore | null>((resolve) => {
        releaseCreate = resolve;
      }),
    );
    const first = persistence.init({ dbName: 'r32-double-init' });
    const second = persistence.init({ dbName: 'r32-double-init' });
    expect(second).toBe(first); // single-flight：同一 in-flight 执行
    releaseCreate(store);
    await first;
    await second;
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(persistence.available).toBe(true);
    const outcome = await persistence.dispose();
    expect(outcome).toEqual({ ok: true });
    createSpy.mockRestore();
  });

  it('严重 3（第三十五轮）：dispose-first/init-second —— dispose 开始后晚到 init 不再穿过屏障（修复前 init 在 preflight/commit 期间仍被允许：dispose 返回 {ok:true} 后 store 才到达、close() 抛错在 init 内部被吞、公开 close 永久成功但连接泄漏）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const createSpy = vi.spyOn(ProjectStore, 'create');
    // dispose 先开始：同步关闭新 init 准入（返回 promise 之前生效）
    const disposePromise = persistence.dispose();
    // dispose 开始后启动 init：准入已关 → no-op，不启动任何创建任务
    await persistence.init({ dbName: 'r35-dispose-first' });
    expect(createSpy).not.toHaveBeenCalled();
    const outcome = await disposePromise;
    expect(outcome).toEqual({ ok: true });
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(persistence.available).toBe(false);
    createSpy.mockRestore();
  });

  it('严重 3（第三十五轮）：preflight 失败后准入重新开放 —— 晚到 init 恢复可用、编辑可真实落盘（修复前 dispose 后 init 永久 no-op，运行态无法恢复持久化）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const store = await openStandaloneStore();
    const autosaver = (
      persistence as unknown as {
        autosaver: { dispose: () => Promise<{ ok: boolean; code?: string; message?: string }> };
      }
    ).autosaver;
    const disposeSpy = vi.spyOn(autosaver, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: false, code: 'storage-error', message: '模拟冲刷失败' });
    const failed = await persistence.dispose();
    expect(failed.ok).toBe(false);
    // 准入已重新开放：init 恢复可用
    await persistence.init({ debounceMs: 60_000, store });
    expect(persistence.available).toBe(true);
    editor.openProject(createSampleProject('lumora://project/r35-reopen', '准入重开'));
    editor.addObject(createGroupObject());
    const flush = await persistence.flushPending();
    expect(flush.ok).toBe(true);
    disposeSpy.mockRestore();
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
  });
});

describe('ProjectPersistence：init 拒绝不污染 single-flight（第三十三轮一般 5）', () => {
  it('init 拒绝后缓存清理：无未处理拒绝、后续 init 重试成功（修复前 success-only then 派生未处理拒绝且永久复用 rejected promise）', async () => {
    const editor = new SceneEditor();
    const persistence = new ProjectPersistence(editor);
    const store = await openStandaloneStore();

    const rejectSpy = vi.spyOn(ProjectStore, 'create').mockRejectedValueOnce(new Error('模拟存储打开失败'));
    await expect(persistence.init({ dbName: 'r33-init-reject' })).rejects.toThrow('模拟存储打开失败');
    // 拒绝后 initPromise 已清空（双分支 settle 清理）：不残留 rejected promise
    expect((persistence as unknown as { initPromise: unknown }).initPromise).toBeNull();

    // 重试：存储创建恢复 → init 正常完成、store 挂载（修复前第二次 init 直接
    // 拿到缓存的 rejected promise，永远失败）
    const resolveSpy = vi.spyOn(ProjectStore, 'create').mockResolvedValueOnce(store);
    await persistence.init({ dbName: 'r33-init-reject' });
    expect(persistence.available).toBe(true);
    rejectSpy.mockRestore();
    resolveSpy.mockRestore();
    await persistence.dispose();
  });
});

describe('ProjectPersistence：preflight 失败后运行态完整可落盘（第三十三轮阻断 2 + 第三十四轮阻断 3）', () => {
  it('recovery 锁存被拒返回 {ok:false}：无任何 teardown —— 编辑仍进 autosave、恢复后可落盘、重试 dispose 成功', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r33-prefail', 'preflight 失败'));

    const autosaver = (
      persistence as unknown as {
        autosaver: {
          dispose: () => Promise<{ ok: boolean; code?: string; message?: string }>;
        };
      }
    ).autosaver;
    // 第三十五轮阻断 1：preflight = autosaver.dispose()（封存失败即原样返回、
    // 无 teardown —— 修复前 commit 段二次冲刷失败被强制 teardown 改写成成功）
    const preflightSpy = vi.spyOn(autosaver, 'dispose');
    preflightSpy.mockResolvedValueOnce({ ok: false, code: 'recovery-available', message: '存在未解决恢复 fork' });

    const outcome = await persistence.dispose();
    expect(outcome.ok).toBe(false);
    // preflight 失败：autosaver/订阅/store 全部保留 —— 编辑仍进 autosave 且
    // 可落盘（修复前 commit 阶段失败返回 {ok:false} 但 autosaver 已永久释放：
    // 新编辑不再进 autosave、随重试的编辑器销毁丢失 —— 审查员点名「可编辑
    // 但不可保存」死壳；第三十四轮阻断 3：preflight 改走无 teardown 的
    // preflightDispose，失败后 autosaver 连 disposed 都未置位、监听保留）
    editor.addObject(createGroupObject());
    const flush = await persistence.flushPending();
    expect(flush.ok).toBe(true);
    const loaded = await persistence.loadProject('lumora://project/r33-prefail');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }

    preflightSpy.mockRestore();
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
  });

  it('flush 冲刷失败（storage-error）：失败后编辑并真实验盘 —— 修复前 preflight 调 autosaver.dispose()，flush 失败虽未置 disposed，但「preflight 成功后」的路径才是死壳来源；本用例验证纯冲刷失败路径运行态同样完整', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r34-prefail-flush', '冲刷失败'));

    const autosaver = (
      persistence as unknown as {
        autosaver: {
          dispose: () => Promise<{ ok: boolean; code?: string; message?: string }>;
        };
      }
    ).autosaver;
    const preflightSpy = vi.spyOn(autosaver, 'dispose');
    preflightSpy.mockResolvedValueOnce({ ok: false, code: 'storage-error', message: '磁盘瞬时错误' });

    const outcome = await persistence.dispose();
    expect(outcome).toMatchObject({ ok: false, code: 'storage-error', message: '磁盘瞬时错误' });
    // 失败后编辑：autosaver 完整活跃（changed 非 no-op），重试冲刷成功、内容落盘
    editor.addObject(createGroupObject());
    const flush = await persistence.flushPending();
    expect(flush.ok).toBe(true);
    const loaded = await persistence.loadProject('lumora://project/r34-prefail-flush');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }
    preflightSpy.mockRestore();
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
  });

  it('第三十五轮阻断 1：最终冲刷失败原样返回 {ok:false}、无任何 teardown —— 首轮成功→间隙编辑→二次保存失败→仍可编辑→重试后真实验盘（修复前 commit 段二次冲刷失败被归档 message、强制 forceTeardown、改写成 {ok:true} —— 内存 recovery 中的新编辑随 runtime 销毁丢失）', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r35-seal', '封存失败'));
    // 首轮成功：内容真实落盘
    const initial = await persistence.flushPending();
    expect(initial.ok).toBe(true);
    // 间隙编辑：出现 preflight 与最终冲刷之间的新内容
    editor.addObject(createGroupObject());
    // 二次保存失败：最终冲刷（autosaver.dispose 内 flush）落盘失败
    const saveSpy = vi.spyOn(store, 'save');
    saveSpy.mockRejectedValueOnce(new Error('磁盘瞬时错误'));
    const outcome = await persistence.dispose();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('storage-error');
      expect(outcome.message).toBe('磁盘瞬时错误');
    }
    // 原样失败：persistence 与 autosaver 两层都未进入终态（修复前 persistence
    // disposed=true、autosaver 被强制 forceTeardown —— 假完成）
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(false);
    const autosaver = (persistence as unknown as { autosaver: { disposed: boolean } }).autosaver;
    expect(autosaver.disposed).toBe(false);
    // 仍可编辑：运行态完整
    editor.addObject(createGroupObject());
    // 重试后真实验盘（存储恢复）：两轮编辑都落盘
    saveSpy.mockRestore();
    const flush = await persistence.flushPending();
    expect(flush.ok).toBe(true);
    const loaded = await persistence.loadProject('lumora://project/r35-seal');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.project.objects.length).toBe(createSampleProject().objects.length + 2);
    }
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
  });

  it('严重 4（第三十五轮）：autosaver.dispose() reject 归一为可恢复失败 —— 两层 disposed 一致、重试终态后窗口监听完整移除（修复前 persistence 置 disposed=true 假完成、autosaver 仍 disposed=false、pagehide/visibilitychange 监听残留）', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r35-reject', 'reject 归一'));

    const autosaver = (
      persistence as unknown as {
        autosaver: { disposed: boolean; dispose: () => Promise<{ ok: boolean; code?: string; message?: string }> };
      }
    ).autosaver;
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    const rejectSpy = vi.spyOn(autosaver, 'dispose');
    rejectSpy.mockRejectedValueOnce(new Error('模拟释放崩溃'));

    const outcome = await persistence.dispose();
    expect(outcome).toMatchObject({ ok: false, code: 'storage-error', message: '模拟释放崩溃' });
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(false);
    expect(autosaver.disposed).toBe(false);
    // 运行态保留：编辑仍可落盘（修复后 autosaver 未终态化）
    editor.addObject(createGroupObject());
    const flush = await persistence.flushPending();
    expect(flush.ok).toBe(true);

    rejectSpy.mockRestore();
    const retried = await persistence.dispose();
    expect(retried).toEqual({ ok: true });
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(autosaver.disposed).toBe(true);
    // 终态清理逐项完成：pagehide（window）/visibilitychange（document）监听已移除
    const removed = removeSpy.mock.calls.map((call) => call[0]);
    expect(removed).toContain('pagehide');
    const removedDoc = removeDocSpy.mock.calls.map((call) => call[0]);
    expect(removedDoc).toContain('visibilitychange');
    removeSpy.mockRestore();
    removeDocSpy.mockRestore();
  });
});

describe('ProjectPersistence：第三十六轮修复回归（审查员 8/24 07:18 复审）', () => {
  it('阻断 1：clean 项目 dispose 与微任务编辑竞态 —— flush 判 clean 与 seal 原子化，窗口内编辑真实落盘（修复前 dispose 返回 {ok:true} 但重开真实 IndexedDB 对象数未增）', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r36-seal-race', '封存竞态'));
    // 先落盘到 clean：与 dispose 的 await 续体（flush 判 clean → 封存）构成
    // 微任务窗口 —— 修复前全部续体先于编辑微任务执行，flush 复查看不到编辑
    const initial = await persistence.flushPending();
    expect(initial.ok).toBe(true);
    // 审查员探针时序：项目 clean 时 dispose，随后紧跟微任务编辑。修复前该编辑
    // 在 dispose 置 disposed 后才执行（persistence 监听已 no-op），进不了 autosave
    const closing = persistence.dispose();
    queueMicrotask(() => editor.addObject(createGroupObject()));
    const outcome = await closing;
    expect(outcome.ok).toBe(true);
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    // 重开真实存储验证窗口内编辑已落盘（修复前对象数未增）
    const reopened = await ProjectStore.create(DB);
    expect(reopened).not.toBeNull();
    const stored = await reopened!.load('lumora://project/r36-seal-race');
    expect(stored.ok).toBe(true);
    if (stored.ok && stored.project) {
      expect(stored.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }
    reopened!.close();
  });

  it('严重 2：dispose 挂起期间 runtime.init 等待裁决 —— dispose 失败后真实初始化、store 可用并真实落盘（修复前 init 从 persistence 得 resolved no-op 无条件写 initialized=true，再次 init 短路、持久化永久仅内存）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const persistence = runtime.persistence;
    const autosaver = (
      persistence as unknown as {
        autosaver: { dispose: () => Promise<{ ok: boolean; code?: string; message?: string }> };
      }
    ).autosaver;
    // dispose 先开始且 preflight 将失败：dispose 挂起期间准入已关
    const disposeSpy = vi.spyOn(autosaver, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: false, code: 'storage-error', message: '模拟冲刷失败' });
    const closing = runtime.dispose();
    // dispose 挂起（准入已关）期间启动 init：修复前直接 resolved no-op →
    // runtime 无条件 initialized=true → dispose 失败后 runtime 层永久短路
    const initPromise = runtime.init({ debounceMs: 60_000, dbName: 'r36-gate-wait' });
    const disposeOutcome = await closing;
    expect(disposeOutcome.ok).toBe(false);
    // init 等待 dispose 裁决（失败、准入重开）后真实初始化：store 挂载
    await initPromise;
    expect(runtime.persistence.available).toBe(true);
    expect(runtime.persistence.backend).toBe('indexeddb');
    // 真实落盘验证：编辑经 flush 排空写入存储
    runtime.openProject(createSampleProject('lumora://project/r36-gate', '准入等待'));
    runtime.editor.addObject(createGroupObject());
    const flush = await runtime.persistence.flushPending();
    expect(flush.ok).toBe(true);
    const loaded = await runtime.persistence.loadProject('lumora://project/r36-gate');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }
    disposeSpy.mockRestore();
    const final = await runtime.dispose();
    expect(final).toEqual({ ok: true });
    await ProjectStore.drop('r36-gate-wait');
  });

  it('严重 3：forceTeardown 真实 removeEventListener 抛错 —— 终态化开始后异常归档 terminal {ok:true,message}，两层 disposed 一致、其余清理补做（修复前异常越过 autosaver 使 persistence 误判可恢复 {ok:false} 重开准入：autosave no-op、重试假成功、监听清理不补做 —— 两层死壳）', async () => {
    const editor = new SceneEditor();
    const store = await openStandaloneStore();
    const persistence = new ProjectPersistence(editor);
    await persistence.init({ debounceMs: 60_000, store });
    editor.openProject(createSampleProject('lumora://project/r36-teardown-throw', 'teardown 抛错'));
    await persistence.flushPending(); // clean：dispose 直达终态化
    const autosaver = (persistence as unknown as { autosaver: { disposed: boolean } }).autosaver;
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    // 真实内部 throw-once 注入：第一次 window.removeEventListener（pagehide）抛错
    removeSpy.mockImplementationOnce(() => {
      throw new Error('模拟移除监听失败');
    });
    const outcome = await persistence.dispose();
    // 修复前：异常越过 autosaver.dispose() → persistence catch 判可恢复
    // {ok:false} 重开准入，但 autosaver 已 disposed —— UI 保留但 autosave no-op
    expect(outcome.ok).toBe(true);
    if (outcome.message) expect(outcome.message).toContain('模拟移除监听失败');
    // 两层都进入终态：persistence/autosaver disposed 一致
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(autosaver.disposed).toBe(true);
    // 逐步骤 best-effort：pagehide 移除抛错后 visibilitychange（document）仍补做
    const removed = removeSpy.mock.calls.map((call) => call[0]);
    expect(removed).toContain('pagehide');
    const removedDoc = removeDocSpy.mock.calls.map((call) => call[0]);
    expect(removedDoc).toContain('visibilitychange');
    // 重试（幂等缓存）不假报可恢复、不再触碰 teardown
    const retried = await persistence.dispose();
    expect(retried.ok).toBe(true);
    expect((persistence as unknown as { disposed: boolean }).disposed).toBe(true);
    removeSpy.mockRestore();
    removeDocSpy.mockRestore();
  });
});

describe('ProjectPersistence：第三十七轮修复回归（审查员 8/24 08:17 复审）', () => {
  it('阻断 1：task-turn 密封屏障 —— 四层嵌套 queueMicrotask 编辑在 close settle 前被接受并真实落盘，线性化点后写入被 editor 拒绝（修复前 await null 只让出一个微任务位置：深度 3-8 的编辑在复查 + forceTeardown 之后才执行 —— addObject().ok === true、closing {ok:true}、编辑器对象数 +1，但重开真实 IndexedDB 仍为初始值，内容静默丢失）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    await runtime.init({ debounceMs: 60_000, dbName: 'r37-task-turn' });
    await runtime.openProject(createSampleProject('lumora://project/r37-task-turn', '任务边界封存'));
    // 先落盘到 clean：dispose 的 preflight flush 判净，随后进入密封裁决窗口
    const initial = await runtime.persistence.flushPending();
    expect(initial.ok).toBe(true);
    const order: string[] = [];
    let editAccepted: boolean | null = null;
    const closing = runtime.dispose();
    // 审查员复现时序：四次连续嵌套 queueMicrotask 提交编辑。修复前该编辑在
    // 复查（epoch 未变）→ forceTeardown（autosaver disposed）之后才执行 ——
    // 编辑被 autosaver 丢弃，但 runtime 未完成关闭、editor 仍接受写入
    queueMicrotask(() => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            editAccepted = runtime.editor.addObject(createGroupObject()).ok;
            order.push('edit');
          });
        });
      });
    });
    const outcome = await closing;
    order.push('closed');
    expect(outcome.ok).toBe(true);
    // 编辑发生在 close settle 前（线性化点前）且写入被接受
    expect(order).toEqual(['edit', 'closed']);
    expect(editAccepted).toBe(true);
    // 线性化点后：runtime 终态已释放 editor —— 写入不再被接受（修复前 editor
    // 未释放，静默丢失；现在显式拒绝，宿主可感知）
    const rejected = runtime.editor.addObject(createGroupObject());
    expect(rejected.ok).toBe(false);
    // 重开真实 IndexedDB：窗口内编辑已真实落盘（修复前对象数仍为初始值）
    const reopened = await ProjectStore.create('r37-task-turn');
    expect(reopened).not.toBeNull();
    const stored = await reopened!.load('lumora://project/r37-task-turn');
    expect(stored.ok).toBe(true);
    if (stored.ok && stored.project) {
      expect(stored.project.objects.length).toBe(createSampleProject().objects.length + 1);
    }
    reopened!.close();
    await ProjectStore.drop('r37-task-turn');
  });
});

describe('ProjectPersistence：第三十八轮修复回归（审查员 8/24 08:43 复审）', () => {
  it('阻断 1a：seal 后 editor 拒写 —— 真实 deferred 插件 deactivate 挂起期间写入被明确拒绝，放行后关闭成功、磁盘无假成功（修复前 host.dispose 的 async deactivate 挂起窗口内 addObject().ok === true、内存对象数 +1，但 autosave/store 已封存 —— 重开真实 IndexedDB 仍为初始值，产品可达的静默丢盘）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    await runtime.init({ debounceMs: 60_000, dbName: 'r38-deferred-plugin' });
    await runtime.openProject(createSampleProject('lumora://project/r38-plugin', '延迟停用插件'));
    const initial = await runtime.persistence.flushPending();
    expect(initial.ok).toBe(true);
    let releaseDeactivate!: () => void;
    let markDeactivateStarted!: () => void;
    const deactivateEntered = new Promise<void>((resolve) => {
      markDeactivateStarted = resolve;
    });
    // 真实插件：deactivate 返回 deferred —— 挂起 host.dispose() 的等待
    await runtime.host.register({
      manifest: {
        schemaVersion: '1',
        id: 'com.lumora.r38deferred',
        name: '延迟停用插件',
        version: '0.1.0',
        entry: './dist/index.js',
      },
      entry: async () => ({
        activate: async () => undefined,
        deactivate: () =>
          new Promise<void>((resolve) => {
            markDeactivateStarted();
            releaseDeactivate = resolve;
          }),
      }),
    });
    const closing = runtime.dispose();
    // host.dispose 已进入插件停用：persistence 已 seal、editor 写准入已关闭
    await deactivateEntered;
    const accepted = runtime.editor.addObject(createGroupObject());
    // 停用挂起期间写入被明确拒绝（修复前 ok === true 但内容永不落盘）
    expect(accepted.ok).toBe(false);
    releaseDeactivate();
    const outcome = await closing;
    expect(outcome.ok).toBe(true);
    // 重开真实 IndexedDB：无假成功 —— 拒绝的编辑未落盘，对象数仍为初始值
    const reopened = await ProjectStore.create('r38-deferred-plugin');
    expect(reopened).not.toBeNull();
    const stored = await reopened!.load('lumora://project/r38-plugin');
    expect(stored.ok).toBe(true);
    if (stored.ok && stored.project) {
      expect(stored.project.objects.length).toBe(createSampleProject().objects.length);
    }
    reopened!.close();
    await ProjectStore.drop('r38-deferred-plugin');
  });

  it('阻断 1b：seal 后 teardown 回调（注入式 store.close）同步重入写入被明确拒绝 —— 重开真实 IndexedDB 内容不变（修复前 commitDispose 的 store.close 与 editor 拒写之间存在窗口，teardown 回调可同步重入提交 mutation）', async () => {
    const runtime = createStudioRuntime();
    openRuntimes.push(runtime);
    const created = await ProjectStore.create('r38-reentry');
    expect(created).not.toBeNull();
    const real: ProjectStore = created!;
    openStores.push(real);
    let reentryOutcome: { ok: boolean } | null = null;
    const reentrantStore: ProjectStorage = {
      kind: 'indexeddb',
      list: () => real.list(),
      load: (uri) => real.load(uri),
      save: (project, expected) => real.save(project, expected),
      remove: (uri) => real.remove(uri),
      removeIfUnchanged: (uri, fingerprint) => real.removeIfUnchanged(uri, fingerprint),
      rename: (uri, name) => real.rename(uri, name),
      duplicate: (uri, name) => real.duplicate(uri, name),
      close: () => {
        // seal 后的 teardown 回调同步重入写入：必须被 editor 明确拒绝
        reentryOutcome = runtime.editor.addObject(createGroupObject());
        real.close();
      },
    };
    await runtime.init({ debounceMs: 60_000, store: reentrantStore });
    await runtime.openProject(createSampleProject('lumora://project/r38-reentry', '关闭重入'));
    const initial = await runtime.persistence.flushPending();
    expect(initial.ok).toBe(true);
    const closing = runtime.dispose();
    const outcome = await closing;
    expect(outcome.ok).toBe(true);
    expect(reentryOutcome).not.toBeNull();
    expect(reentryOutcome!.ok).toBe(false);
    // 重开真实 IndexedDB：重入写入未提交，对象数仍为初始值
    const reopened = await ProjectStore.create('r38-reentry');
    expect(reopened).not.toBeNull();
    const stored = await reopened!.load('lumora://project/r38-reentry');
    expect(stored.ok).toBe(true);
    if (stored.ok && stored.project) {
      expect(stored.project.objects.length).toBe(createSampleProject().objects.length);
    }
    reopened!.close();
    await ProjectStore.drop('r38-reentry');
  });
});
