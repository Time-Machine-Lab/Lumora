import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupObject, createSampleProject, SceneEditor } from '@lumora/core';
import type { Project } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import type { StudioRuntime } from '../src/runtime/studio-runtime';
import { ProjectStore } from '../src/persistence/project-store';
import { ProjectPersistence } from '../src/persistence/project-persistence';
import { buildProjectPackage, serializeProjectPackage } from '@lumora/core';

const DB = 'lumora-test-persist';

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
  for (const runtime of openRuntimes) await runtime.dispose();
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
    expect((await stored!.load(project.uri))!.name).toBe('新名字');
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
    expect((await reopened!.load(project.uri))!.name).toBe('改名不打开');

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
    const copyProject = await copy!.load(dup.summary.uri);
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
    const stored = await store!.load(project.uri);
    expect(stored!.revision).toBeGreaterThan(0);
  });

  it('closeProject 前冲刷未保存变更（排空屏障：在途保存也等待完成）', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('关闭前项目');
    runtime.openProject(project);
    runtime.editor.addObject(createGroupObject());
    await runtime.closeProject();
    const store = await openStandaloneStore();
    const stored = await store!.load(project.uri);
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
    const stored = await store!.load(project.uri);
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
    const copyProject = await copy!.load(dup.summary.uri);
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
    const stored = await final!.load(project.uri);
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
    const stored = await store.load(project.uri);
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
    const otherStored = await store.load(other.uri);
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
    const after = await store!.load(v3.uri);
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
    const after = await store!.load(v3.uri);
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

  it('exportCurrent 编码预检：数组非索引键（pluginData.arr.extra）与循环引用 → 类型化失败，不产出丢字段的包', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('不可导出');
    // pluginData.arr 数组带非索引自有键（JSON.stringify 会静默丢键）
    const arr = [1, 2] as unknown as Record<string, unknown>;
    arr.extra = 3;
    runtime.openProject({ ...project, pluginData: { arr: arr as unknown as unknown[] } } as Project);
    await settle(40);
    const result = await runtime.persistence.exportCurrent({ includePrivate: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('无法导出');
    expect(result.message).toContain('array-extra-keys');
    // 不含私有设置时 pluginData 不进包：导出成功（插件私有数据不污染公开包）
    expect(runtime.persistence.exportCurrent().ok).toBe(true);
    await runtime.dispose();
  });

  it('exportCurrent 编码预检：循环引用扩展字段 → 类型化失败', async () => {
    const runtime = await makeRuntime();
    const project = runtime.persistence.createProject('循环项目');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    runtime.openProject({ ...project, pluginData: { loop } } as Project);
    await settle(40);
    const result = await runtime.persistence.exportCurrent({ includePrivate: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('circular-reference');
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

    const copyLoaded = await store!.load(saved.project.uri);
    expect(copyLoaded).not.toBeNull();
    expect(copyLoaded!.revision).toBe(0);
    expect(copyLoaded!.objects.length).toBe(base.objects.length + 2);
    // 旧恢复快照内容为 base+1（未被误当副本源）；重试保存已把快照落盘到 A
    const storedA = await store!.load(A);
    expect(storedA!.objects.length).toBe(base.objects.length + 1);
    expect(persistence.getRecoverySnapshot(A)).toBeNull();
    await persistence.dispose();
  });
});
