import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectPackage, createBlankProject, migrateProjectSchema } from '@lumora/core';
import type { Project } from '@lumora/core';
import { ProjectStore } from '../src/persistence/project-store';
import { OpfsProjectStore, projectFileName } from '../src/persistence/project-store-opfs';
import { MemDirectoryHandle } from './opfs-fs-shim';
import { findJsonEncodingProblem, sameProjectContent, stableStringify } from '../src/persistence/project-storage';
import type { ProjectStorage, ProjectSummary } from '../src/persistence/project-storage';

const DB = 'lumora-test-store';
/** 便捷读取/列表（第十七轮严重 4：list/load 收口为类型化结果后直接取数据字段） */
async function loadStored(store: ProjectStorage, uri: string): Promise<Project | null> {
  const result = await store.load(uri);
  return result.ok ? result.project : null;
}

async function listStored(store: ProjectStorage): Promise<ProjectSummary[]> {
  const result = await store.list();
  return result.ok ? result.items : [];
}

function project(uri: string, name: string, revision: number) {
  return { ...createBlankProject(uri, name), revision };
}

beforeEach(async () => {
  await ProjectStore.drop(DB);
});

afterEach(async () => {
  await ProjectStore.drop(DB);
});

describe('ProjectStore：IndexedDB 持久化（FR-011）', () => {
  it('保存后可重新打开数据库读取（跨连接持久化）', async () => {
    const store = await ProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    const saved = project('lumora://project/a', '持久化项目', 3);
    expect((await store.save(saved)).ok).toBe(true);
    store.close();

    const reopened = await ProjectStore.create(DB);
    expect(reopened).not.toBeNull();
    if (!reopened) return;
    const loaded = await loadStored(reopened, 'lumora://project/a');
    expect(loaded).toEqual(saved);
    // load 返回可自由修改的副本，不得影响存储中的记录
    loaded!.name = '被调用方修改';
    expect((await loadStored(reopened, 'lumora://project/a'))!.name).toBe('持久化项目');
    reopened.close();
  });

  it('list 按保存时间倒序返回摘要（最近项目列表）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/old', '旧项目', 1));
    await new Promise((r) => setTimeout(r, 5));
    await store.save(project('lumora://project/new', '新项目', 2));
    const summaries = await listStored(store);
    expect(summaries.map((s) => s.uri)).toEqual(['lumora://project/new', 'lumora://project/old']);
    expect(summaries[0]).toMatchObject({ name: '新项目', revision: 2, schemaVersion: 4 });
    store.close();
  });

  it('防倒退（NFR-003）：期望基线落后于已存 revision 时拒绝写入且不覆盖', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const newer = project('lumora://project/a', '较新', 5);
    expect((await store.save(newer)).ok).toBe(true);

    // 调用方期望基线 = 3（打开时读到 rev3）：已存 5 ≠ 3 → 拒绝
    const stale = project('lumora://project/a', '较旧', 3);
    const result = await store.save(stale, 3);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'revision-conflict') return;
    expect(result.storedRevision).toBe(5);
    expect(result.message).toContain('5');

    // 存储内容未被旧数据覆盖（名称仍是较新的保存内容）
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('较新');
    store.close();
  });

  it('CAS 按期望基线校验：本地 revision 追平已存也不能覆盖（评审阻断项回归）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const newer = project('lumora://project/a', '较新', 5);
    expect((await store.save(newer)).ok).toBe(true);

    // 旧实现漏洞场景：客户端本地编辑把 revision 追平到 5（A 追平 B 的已存），
    // 但期望基线仍是打开时的 3 —— 按 revision 大小比较会误判「已追平可覆盖」；
    // CAS 必须按期望基线拒绝，杜绝 A 覆盖 B 的保存内容
    const caughtUp = project('lumora://project/a', '本地追平', 5);
    const result = await store.save(caughtUp, 3);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'revision-conflict') return;
    expect(result.storedRevision).toBe(5);
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('较新');

    // 期望基线匹配（= 已存 5）时允许写入
    const fresh = project('lumora://project/a', '新内容', 6);
    expect((await store.save(fresh, 5)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('新内容');
    store.close();
  });

  it('create-only（expected null）：同 uri 已存在时拒绝创建，不覆盖已有记录', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const first = project('lumora://project/a', '首个', 0);
    expect((await store.save(first, null)).ok).toBe(true);

    const second = project('lumora://project/a', '重复创建', 0);
    const result = await store.save(second, null);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'revision-conflict') return;
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('首个');
    store.close();
  });

  it('同 revision 幂等重存（自动保存抖动）允许且刷新 savedAt', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const same = project('lumora://project/a', '同名', 7);
    expect((await store.save(same, null)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    // 期望基线 = 已存 7 → 匹配；内容逐字节一致（自动保存抖动重发同一内容）→ 允许重存
    const jitter = { ...same };
    expect((await store.save(jitter, 7)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('同名');
    store.close();
  });

  it('同 revision 内容分叉拒绝（评审阻断项回归：禁止同 revision 分叉覆盖）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const first = project('lumora://project/a', '分叉前', 7);
    expect((await store.save(first, null)).ok).toBe(true);
    // 同 revision 7 但内容不同（改场景名）→ 视为分叉，拒绝且不覆盖
    const fork = { ...first, scenes: [{ ...first.scenes[0]!, name: '被改名的场景' }] };
    const result = await store.save(fork, 7);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'revision-conflict') return;
    expect(result.storedRevision).toBe(7);
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('分叉前');
    store.close();
  });

  it('remove 删除项目，重复删除返回 false', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '待删除', 1));
    expect(await store.remove('lumora://project/a')).toEqual({ ok: true, removed: true });
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();
    expect(await store.remove('lumora://project/a')).toEqual({ ok: true, removed: false });
    store.close();
  });

  it('rename 仅作用于已存储项目；不存在时返回 not-found', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '原名', 1));
    const result = await store.rename('lumora://project/a', '新名');
    expect(result.ok).toBe(true);
    const loaded = await loadStored(store, 'lumora://project/a');
    expect(loaded!.name).toBe('新名');
    // 重命名也是一次变更：revision 递增
    expect(loaded!.revision).toBe(2);

    const missing = await store.rename('lumora://project/nope', 'X');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('not-found');
    store.close();
  });

  it('duplicate 生成新 uri、副本名与重置后的 revision', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '源项目', 4));
    const result = await store.duplicate('lumora://project/a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.uri).not.toBe('lumora://project/a');
    expect(result.summary.name).toBe('源项目 副本');
    expect(result.summary.revision).toBe(0);
    const copy = await loadStored(store, result.summary.uri);
    expect(copy).not.toBeNull();
    expect(copy!.name).toBe('源项目 副本');
    expect(copy!.revision).toBe(0);
    expect((await listStored(store)).map((s) => s.uri).sort()).toEqual(['lumora://project/a', result.summary.uri]);
    store.close();
  });

  it('duplicate 不存在的项目返回 not-found', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const result = await store.duplicate('lumora://project/nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-found');
    store.close();
  });

  it('IndexedDB 不可用时 create 返回 null（持久化静默降级）', async () => {
    const idb = (globalThis as { indexedDB?: unknown }).indexedDB;
    try {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
      expect(await ProjectStore.create(DB)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true });
    }
  });
});

describe('ProjectStore：JSON 可编码性契约（第五轮 #8，与 OPFS 后端一致）', () => {
  it('含 undefined 字段的项目：事务前拒绝，不产生记录', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const bad = project('lumora://project/a', '含 undefined', 1) as Project & Record<string, unknown>;
    bad.extra = undefined;
    const result = await store.save(bad as Project, null);
    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('undefined');
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();
    store.close();
  });

  it('含非有限数值的项目：拒绝（JSON 会静默失真为 null）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const bad = project('lumora://project/a', '非有限数值', 1);
    bad.settings = { ...bad.settings, fps: Infinity };
    const result = await store.save(bad, null);
    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('non-finite');
    store.close();
  });

  it('含循环引用的项目：拒绝（structuredClone 能存但 JSON 契约不能编码）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const bad = project('lumora://project/a', '循环引用', 1) as Project & Record<string, unknown>;
    bad.loop = bad;
    const result = await store.save(bad as Project, null);
    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('circular');
    store.close();
  });

  it('含 BigInt 字段的项目：拒绝（JSON.stringify 会抛错，两端一致，第六轮 #5）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const bad = project('lumora://project/a', 'BigInt', 1) as Project & Record<string, unknown>;
    bad.extra = { value: 1n };
    const result = await store.save(bad as Project, null);
    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('bigint');
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();
    store.close();
  });

  it('含数组非索引键（pluginData.arr.extra）的项目：拒绝（JSON.stringify 静默丢键，两端一致，第六轮 #5）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const bad = project('lumora://project/a', '数组扩展键', 1);
    const arr = [1, 2] as unknown as Record<string, unknown>;
    arr.extra = 3;
    (bad as { pluginData?: Record<string, unknown> }).pluginData = { arr: arr as unknown as unknown[] };
    const result = await store.save(bad, null);
    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('array-extra-keys');
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();
    store.close();
  });
});

describe('ProjectStore：拒绝 schema 降级（第六轮 #6）', () => {
  it('以旧 schema 版本覆盖较新记录：返回 schema-downgrade 类型化错误，不写入', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const current = project('lumora://project/a', 'v3', 0);
    expect((await store.save(current)).ok).toBe(true);
    const old = { ...current, schemaVersion: 2 } as unknown as Project;
    const result = await store.save(old, 0);
    expect(result).toMatchObject({ ok: false, code: 'schema-downgrade' });
    if (result.ok || result.code !== 'schema-downgrade') return;
    expect(result.message).toContain('schema');
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.schemaVersion).toBe(4);
    expect(stored!.revision).toBe(0);
    store.close();
  });

  it('无条件写入（expected undefined）同样拒绝 schema 降级', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const current = project('lumora://project/a', 'v3', 0);
    expect((await store.save(current)).ok).toBe(true);
    const old = { ...current, schemaVersion: 2, revision: 1 } as unknown as Project;
    const result = await store.save(old);
    expect(result).toMatchObject({ ok: false, code: 'schema-downgrade' });
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.schemaVersion).toBe(4);
    store.close();
  });
});

describe('project-storage 共享工具（第五轮 #6 / #8）', () => {
  it('stableStringify 保留名为 __proto__ 的自有字段（null 原型累加器，防 fork 检测绕过）', () => {
    const plain = JSON.parse('{"a":1}');
    const withProto = JSON.parse('{"a":1,"__proto__":{"x":1}}');
    expect(stableStringify(withProto)).toContain('__proto__');
    expect(stableStringify(plain)).not.toBe(stableStringify(withProto));
    // 仅 __proto__ 字段差异的两个项目：内容指纹必须不同（分叉检测不可绕过）
    const base = JSON.parse(
      '{"uri":"lumora://project/a","name":"n","schemaVersion":3,"createdAt":"t","revision":0,"settings":{"fps":30,"aspect":[16,9]},"activeSceneId":"s1","scenes":[],"objects":[],"tracks":[],"assets":[],"pluginData":{}}',
    ) as Project;
    const forked = JSON.parse(
      '{"uri":"lumora://project/a","name":"n","schemaVersion":3,"createdAt":"t","revision":0,"settings":{"fps":30,"aspect":[16,9]},"activeSceneId":"s1","scenes":[],"objects":[],"tracks":[],"assets":[],"pluginData":{"__proto__":{"x":1}}}',
    ) as Project;
    expect(sameProjectContent(base, forked)).toBe(false);
  });

  it('findJsonEncodingProblem：循环/DAG 判定正确，各类不可编码值识别', () => {
    const dag: Record<string, unknown> = { a: { n: 1 } };
    dag.b = dag.a; // 同一对象两处引用（DAG）：JSON.stringify 可正常处理，不误判循环
    expect(findJsonEncodingProblem(dag)).toBeNull();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(findJsonEncodingProblem(circular)).toBe('circular-reference');
    expect(findJsonEncodingProblem({ u: undefined })).toBe('undefined-value');
    expect(findJsonEncodingProblem({ n: NaN })).toBe('non-finite-number');
    expect(findJsonEncodingProblem({ n: Infinity })).toBe('non-finite-number');
    expect(findJsonEncodingProblem({ b: 1n })).toBe('bigint-value');
    expect(findJsonEncodingProblem({ f: () => undefined })).toBe('function-value');
    expect(findJsonEncodingProblem({ s: Symbol('x') })).toBe('symbol-value');
    expect(findJsonEncodingProblem({ ok: [1, 'a', null, { deep: true }] })).toBeNull();
  });

  it('findJsonEncodingProblem（第七轮 #4）：品牌对象（Date/Map/Set/RegExp/typed array）与 -0 拒绝，JSON.parse 产物接受', () => {
    expect(findJsonEncodingProblem({ d: new Date('2026-01-01T00:00:00Z') })).toBe('non-plain-object');
    expect(findJsonEncodingProblem({ m: new Map([['a', 1]]) })).toBe('non-plain-object');
    expect(findJsonEncodingProblem({ s: new Set([1]) })).toBe('non-plain-object');
    expect(findJsonEncodingProblem({ r: /x+/ })).toBe('non-plain-object');
    expect(findJsonEncodingProblem({ t: new Uint8Array([1, 2]) })).toBe('non-plain-object');
    expect(findJsonEncodingProblem({ e: new Error('x') })).toBe('non-plain-object');
    expect(findJsonEncodingProblem({ z: -0 })).toBe('negative-zero');
    expect(findJsonEncodingProblem(-0)).toBe('negative-zero');
    expect(findJsonEncodingProblem({ z: 0 })).toBeNull();
    // 普通对象与 null 原型 record（JSON.parse 产物）可编码
    const nullProto = JSON.parse('{"n":1}');
    expect(findJsonEncodingProblem({ p: nullProto })).toBeNull();
  });
});

describe('schema 升级写回豁免 isMigrationWriteback（第七轮 #5，两个适配器共享判定）', () => {
  it('迁移写回（incoming 精确等于 migrateProjectSchema(existing) 的确定性结果）：同 revision 覆盖被放行', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const v3 = project('lumora://project/a', '旧版', 7);
    const { tracks: _tracks, ...v2 } = v3;
    const baseline = { ...v2, schemaVersion: 2 } as unknown as Project;
    expect((await store.save(baseline)).ok).toBe(true);

    const migrated = migrateProjectSchema(baseline);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const result = await store.save(migrated.project as Project, 7);
    expect(result.ok).toBe(true);
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.schemaVersion).toBe(4);
    expect(stored!.revision).toBe(7);
    store.close();
  });

  it('v2/rev7 baseline 被任意 v3/rev7 divergent 覆盖：按分叉拒绝（第七轮 #5 回归，不得借「升级」覆盖）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const v3 = project('lumora://project/a', '旧版', 7);
    const { tracks: _tracks, ...v2 } = v3;
    const baseline = { ...v2, schemaVersion: 2 } as unknown as Project;
    expect((await store.save(baseline)).ok).toBe(true);

    // 仅升级 schemaVersion、场景内容被改写的任意 v3/rev7 分叉：不是迁移结果 → 拒绝
    const divergent = {
      ...v3,
      schemaVersion: 4,
      scenes: [{ ...v3.scenes[0]!, name: '被篡改的场景' }],
    } as unknown as Project;
    const result = await store.save(divergent, 7);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'revision-conflict') return;
    expect(result.storedRevision).toBe(7);
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.schemaVersion).toBe(2);
    expect(stored!.name).toBe('旧版');
    store.close();
  });
});

describe('removeIfUnchanged：条件删除 CAS（第十四轮严重 4）', () => {
  it('IDB：指纹一致删除、记录已变化保留、记录不存在保留（同事务内读-比-删）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const record = project('lumora://project/cas', 'CAS 项目', 2);
    expect((await store.save(record)).ok).toBe(true);

    // 指纹不一致（验证挂起期间另一标签页已打开并保存更新后的记录）→ 保留
    expect(await store.removeIfUnchanged('lumora://project/cas', 'stale-fingerprint')).toEqual({
      ok: true,
      outcome: 'changed',
    });
    expect((await loadStored(store, 'lumora://project/cas'))!.name).toBe('CAS 项目');

    // 指纹一致（记录仍是创建时的内容）→ 删除
    expect(await store.removeIfUnchanged('lumora://project/cas', stableStringify(record))).toEqual({
      ok: true,
      outcome: 'removed',
    });
    expect(await loadStored(store, 'lumora://project/cas')).toBeNull();

    // 记录不存在 → outcome:'missing'（幂等，清理后置条件已满足，不报错）
    expect(await store.removeIfUnchanged('lumora://project/cas', null)).toEqual({ ok: true, outcome: 'missing' });
    store.close();
  });

  it('OPFS：指纹一致删除、记录已变化保留、损坏记录保留（互斥锁内读-比-删，fail-closed）', async () => {
    const root = new MemDirectoryHandle('root');
    const opfs = await OpfsProjectStore.create(DB, root);
    if (!opfs) return;
    const record = project('lumora://project/opfs-cas', 'CAS 项目', 2);
    expect((await opfs.save(record)).ok).toBe(true);

    // 指纹不一致 → 保留
    expect(await opfs.removeIfUnchanged('lumora://project/opfs-cas', 'stale')).toEqual({
      ok: true,
      outcome: 'changed',
    });
    expect((await loadStored(opfs, 'lumora://project/opfs-cas'))!.name).toBe('CAS 项目');

    // 指纹一致 → 删除
    expect(await opfs.removeIfUnchanged('lumora://project/opfs-cas', stableStringify(record))).toEqual({
      ok: true,
      outcome: 'removed',
    });
    expect(await loadStored(opfs, 'lumora://project/opfs-cas')).toBeNull();

    // 损坏记录（空文件，无法验证指纹）→ 保留：绝不误删无法验证的记录
    const rootDir = await root.getDirectoryHandle(DB, { create: true });
    const projectsDir = await rootDir.getDirectoryHandle('projects', { create: true });
    await projectsDir.getFileHandle(projectFileName('lumora://project/opfs-broken'), { create: true });
    expect(await opfs.removeIfUnchanged('lumora://project/opfs-broken', 'whatever')).toEqual({
      ok: true,
      outcome: 'changed',
    });
    expect(await loadStored(opfs, 'lumora://project/opfs-broken')).toBeNull();
    opfs.close();
  });
});

describe('JSON 编码契约三路共享矩阵（第七轮 #4：IDB / OPFS / 导出 对同一数据一致拒绝）', () => {
  const cases: Array<[string, () => unknown, string, string]> = [
    ['Date', () => ({ d: new Date('2026-01-01T00:00:00Z') }), 'non-plain-object', 'd'],
    ['Map', () => ({ m: new Map([['a', 1]]) }), 'non-plain-object', 'm'],
    ['Set', () => ({ s: new Set([1]) }), 'non-plain-object', 's'],
    ['RegExp', () => ({ r: /x+/ }), 'non-plain-object', 'r'],
    ['typed array', () => ({ t: new Uint8Array([1, 2]) }), 'non-plain-object', 't'],
    ['-0', () => ({ z: -0 }), 'negative-zero', 'z'],
  ];
  for (const [label, corrupt, problem, allowKey] of cases) {
    it(`${label}：IDB 保存 / OPFS 保存 / 导出 三路一致拒绝（${problem}）`, async () => {
      // 1) IndexedDB 后端
      const idb = await ProjectStore.create(DB);
      expect(idb).not.toBeNull();
      if (!idb) return;
      const badIdb = project(`lumora://project/idb-${label}`, '坏数据', 1) as Project & Record<string, unknown>;
      badIdb.extra = corrupt();
      const r1 = await idb.save(badIdb as Project, null);
      expect(r1).toMatchObject({ ok: false, code: 'storage-error' });
      if (!r1.ok) expect(r1.message).toContain(problem);
      expect(await loadStored(idb, `lumora://project/idb-${label}`)).toBeNull();
      idb.close();

      // 2) OPFS 后端
      const opfs = await OpfsProjectStore.create(DB, new MemDirectoryHandle('root'));
      expect(opfs).not.toBeNull();
      if (!opfs) return;
      const badOpfs = project(`lumora://project/opfs-${label}`, '坏数据', 1) as Project & Record<string, unknown>;
      badOpfs.extra = corrupt();
      const r2 = await opfs.save(badOpfs as Project, null);
      expect(r2).toMatchObject({ ok: false, code: 'storage-error' });
      if (!r2.ok) expect(r2.message).toContain(problem);
      expect(await loadStored(opfs, `lumora://project/opfs-${label}`)).toBeNull();
      opfs.close();

      // 3) 工程包导出：编辑器 openProject 的 assertJsonPlainDeep/deepFreeze 已
      // 先行拒绝这些值（损坏数据无法经编辑器持有），因此直接验证
      // exportCurrent 的检查链（buildProjectPackage → findJsonEncodingProblem），
      // 导出表面共享同一编码契约。损坏值经 settings 契约字段（契约投影不做值
      // 类型校验）进入包 → 预检照常拒绝（第十三轮：预检只对进入最终投影视图的
      // 数据生效）
      const exportProject = project(`lumora://project/export-${label}`, '导出坏数据', 1) as Project &
        Record<string, unknown>;
      exportProject.settings = { fps: corrupt() as never } as unknown as Project['settings'];
      const pkg = buildProjectPackage(exportProject as Project, { includePrivate: true });
      const encodingProblem = findJsonEncodingProblem(pkg);
      expect(encodingProblem).not.toBeNull();
      expect(encodingProblem).toContain(problem);

      // 4) 同一损坏值经 pluginData 字符串声明（includePrivate）：非 primitive
      // 叶值被叶值校验剥离（第十五轮阻断 1 —— 整对象声明不得绕过递归投影进包）
      const cleanProject = project(`lumora://project/clean-${label}`, '干净数据', 1) as Project &
        Record<string, unknown>;
      cleanProject.pluginData = { 'com.example': corrupt() };
      const pkg2 = buildProjectPackage(cleanProject as Project, {
        includePrivate: true,
        publicKeysByPlugin: { 'com.example': [allowKey] },
      });
      if (problem === 'negative-zero') {
        // -0 是合法 primitive 叶值：经声明导出，预检仍如实拒绝（叶值不豁免编码检查）
        expect(findJsonEncodingProblem(pkg2)).toContain(problem);
      } else {
        expect(findJsonEncodingProblem(pkg2)).toBeNull();
        expect('pluginData' in pkg2.project).toBe(false);
      }
    });
  }
});

describe('save 同步不可变快照（第八轮 #1）：保存挂起期间改写入参不改变落盘内容', () => {
  it('IDB：保存挂起期间改写入参 uri —— CAS 与写入都按入口快照（落盘目标不被改写）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const p = project('lumora://project/a', '快照测试', 0);
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (incoming, expected) => {
      // 真实 save 已同步完成预检与快照生成（首个 await 前）；此刻改写入参
      // uri —— 后续 CAS/写入必须仍按入口快照（a），不得写成 b（跨项目覆盖）
      const promise = realSave(incoming, expected);
      incoming.uri = 'lumora://project/b';
      return promise;
    });
    const result = await store.save(p, null);
    expect(result.ok).toBe(true);
    expect(await loadStored(store, 'lumora://project/a')).not.toBeNull();
    expect(await loadStored(store, 'lumora://project/b')).toBeNull();
    vi.mocked(store.save).mockRestore();
    store.close();
  });

  it('IDB：访问器属性项目 —— 反射预检先于克隆拒绝（第九轮 #2：先克隆再检查会物化访问器，检查形同虚设）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    try {
      const p = project('lumora://project/a', '快照测试', 0);
      let reads = 0;
      Object.defineProperty(p, 'uri', {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? 'lumora://project/a' : 'lumora://project/b';
        },
      });
      // 反射级预检先于任何克隆：访问器（JSON.stringify 会调用 getter、结构化克隆
      // 会物化）直接拒绝 —— 绝不静默落盘 getter 物化结果（原第八轮 #1 的
      // 「读一次固定」语义被第九轮 #2 的访问器拒绝语义取代）
      const result = await store.save(p, null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('storage-error');
      expect(result.message).toContain('accessor-property');
      expect(await loadStored(store, 'lumora://project/a')).toBeNull();
      expect(await loadStored(store, 'lumora://project/b')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('IDB：保存挂起期间注入不可编码值 —— 落盘内容与入口一致（不产生两后端失真的记录）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const p = project('lumora://project/a', '注入测试', 0);
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (incoming, expected) => {
      // 真实 save 同步执行到首个 await（CAS 查询）后返回 promise；此刻注入
      // 不可编码值 —— 修复前 record 构造时 structuredClone(project) 会把
      // undefined 字段原样落盘（IDB 能存、JSON 契约失真）；修复后入口快照
      // 在注入前已生成，落盘内容不含注入字段
      const promise = realSave(incoming, expected);
      (incoming as Project & Record<string, unknown>).extra = undefined;
      return promise;
    });
    const result = await store.save(p, null);
    expect(result.ok).toBe(true);
    const loaded = await loadStored(store, 'lumora://project/a');
    expect(loaded).not.toBeNull();
    expect('extra' in loaded!).toBe(false);
    store.close();
  });
});

describe('反射预检先于克隆（第九轮 #2）：结构化克隆会删除/物化这些结构，克隆后再检查形同虚设', () => {
  const SHAPES: Array<{ name: string; problem: string; tamper: (p: Project) => void }> = [
    {
      name: 'Symbol 键',
      problem: 'symbol-key',
      tamper: (p) => {
        (p as unknown as Record<symbol, unknown>)[Symbol('私有')] = '仅 Symbol 可见';
      },
    },
    {
      name: '不可枚举属性',
      problem: 'non-enumerable-property',
      tamper: (p) => {
        Object.defineProperty(p, 'hiddenField', { value: '不可枚举', enumerable: false });
      },
    },
    {
      name: '非纯对象（Date 实例）',
      problem: 'non-plain-object',
      tamper: (p) => {
        (p.settings as unknown as Record<string, unknown>).expiresAt = new Date('2030-01-01T00:00:00Z');
      },
    },
  ];

  for (const shape of SHAPES) {
    it(`IDB：${shape.name} —— save 拒绝且不落盘（修复前被克隆删除/物化，IDB 重载后字段丢失而 save 仍报成功）`, async () => {
      const store = await ProjectStore.create(DB);
      if (!store) return;
      try {
        const p = project('lumora://project/a', '预检测试', 0);
        shape.tamper(p);
        const result = await store.save(p, null);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('storage-error');
        expect(result.message).toContain(shape.problem);
        // 预检在任何克隆/事务之前：拒绝后无任何记录写入
        expect(await loadStored(store, 'lumora://project/a')).toBeNull();
        expect(await listStored(store)).toEqual([]);
      } finally {
        store.close();
      }
    });
  }
});

describe('未打开项目的写前变更管道（第八轮 #4）：未来 schema 拒绝写前变更', () => {
  it('future schema（v > 当前）：rename/duplicate 拒绝，记录保持原样（仅允许列出/删除）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const future = { ...project('lumora://project/a', '未来版本', 0), schemaVersion: 99 } as unknown as Project;
    expect((await store.save(future)).ok).toBe(true);

    const renamed = await store.rename('lumora://project/a', '新名');
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) {
      expect(renamed.code).toBe('storage-error');
      expect(renamed.message).toContain('schema');
    }
    const duplicated = await store.duplicate('lumora://project/a');
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.code).toBe('storage-error');

    const loaded = await loadStored(store, 'lumora://project/a');
    expect(loaded!.schemaVersion).toBe(99);
    expect(loaded!.name).toBe('未来版本');
    expect((await listStored(store)).map((s) => s.uri)).toEqual(['lumora://project/a']);
    store.close();
  });

  it('duplicate：复制后验证副本可加载，加载失败清理副本并报错（不留半成品复制）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '源项目', 1));
    const realLoad = store.load.bind(store);
    let loadCount = 0;
    // 第一次 load = 源项目读取；第二次 = 副本加载验证 → 注入失败
    vi.spyOn(store, 'load').mockImplementation(async (uri) => {
      loadCount += 1;
      if (loadCount === 2) return { ok: true, project: null };
      return realLoad(uri);
    });
    const result = await store.duplicate('lumora://project/a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('storage-error');
      expect(result.message).toContain('清理');
    }
    // 副本已被清理：只剩源项目
    expect((await listStored(store)).map((s) => s.uri)).toEqual(['lumora://project/a']);
    store.close();
  });

  it('duplicate：验证读取抛错（load reject）→ 清理副本并如实报错，绝不遗留半成品复制（第九轮 #5）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '源项目', 1));
    const realLoad = store.load.bind(store);
    let loadCount = 0;
    let copyUri: string | null = null;
    vi.spyOn(store, 'load').mockImplementation(async (uri) => {
      loadCount += 1;
      if (loadCount === 2) {
        copyUri = uri;
        return { ok: false, message: '读取验证失败' };
      }
      return realLoad(uri);
    });
    const result = await store.duplicate('lumora://project/a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('storage-error');
      expect(result.message).toContain('复制成功但副本无法加载验证');
      expect(result.message).toContain('已清理'); // 清理成功才声称「已清理」
    }
    vi.mocked(store.load).mockRestore();
    expect(copyUri).not.toBeNull();
    expect(await loadStored(store, copyUri!)).toBeNull(); // 半成品副本确实被删除
    expect((await listStored(store)).map((s) => s.uri)).toEqual(['lumora://project/a']);
    store.close();
  });

  it('duplicate：副本清理 removeIfUnchanged 抛错 —— 如实说明清理失败与副本保留，绝不掩盖（第九轮 #5）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '源项目', 1));
    const realLoad = store.load.bind(store);
    let loadCount = 0;
    let copyUri: string | null = null;
    vi.spyOn(store, 'load').mockImplementation(async (uri) => {
      loadCount += 1;
      if (loadCount === 2) {
        copyUri = uri;
        return { ok: true, project: null }; // 校验失败路径进入清理
      }
      return realLoad(uri);
    });
    vi.spyOn(store, 'removeIfUnchanged').mockResolvedValue({ ok: false, message: '删除事务中止' });
    try {
      const result = await store.duplicate('lumora://project/a');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('storage-error');
        expect(result.message).toContain('副本清理失败');
        expect(result.message).toContain('副本记录保留');
        expect(result.message).not.toContain('已清理');
      }
      expect(copyUri).not.toBeNull();
      expect(await loadStored(store, copyUri!)).not.toBeNull(); // 清理失败：副本记录确实保留
    } finally {
      vi.mocked(store.removeIfUnchanged).mockRestore();
      vi.mocked(store.load).mockRestore();
      store.close();
    }
  });
});

describe('findJsonEncodingProblem 反射级检查（第八轮 #7）', () => {
  it('Symbol 键 / 不可枚举属性 / 访问器属性拒绝；Proxy trap 抛错归一 reflection-error', () => {
    const symKey: Record<string | symbol, unknown> = { a: 1 };
    symKey[Symbol('x')] = 2;
    expect(findJsonEncodingProblem(symKey)).toBe('symbol-key');

    const nonEnum: Record<string, unknown> = { a: 1 };
    Object.defineProperty(nonEnum, 'hidden', { value: 2, enumerable: false });
    expect(findJsonEncodingProblem(nonEnum)).toBe('non-enumerable-property');

    const accessor: Record<string, unknown> = { a: 1 };
    Object.defineProperty(accessor, 'derived', { get: () => 42, enumerable: true });
    expect(findJsonEncodingProblem(accessor)).toBe('accessor-property');

    const trapOwnKeys = new Proxy({ a: 1 }, { ownKeys: () => { throw new Error('trap'); } });
    expect(findJsonEncodingProblem(trapOwnKeys)).toBe('reflection-error');
    const trapDescriptor = new Proxy({ a: 1 }, { getOwnPropertyDescriptor: () => { throw new Error('trap'); } });
    expect(findJsonEncodingProblem(trapDescriptor)).toBe('reflection-error');
    const trapProto = new Proxy({ a: 1 }, { getPrototypeOf: () => { throw new Error('trap'); } });
    expect(findJsonEncodingProblem(trapProto)).toBe('reflection-error');

    // 数组含 Symbol 键 → symbol-key；稀疏空槽（for-of 表现为 undefined）→ undefined-value
    const arrWithSymbol = [1] as unknown as Record<string | symbol, unknown>;
    arrWithSymbol[Symbol('i')] = 3;
    expect(findJsonEncodingProblem(arrWithSymbol)).toBe('symbol-key');
    // eslint-disable-next-line no-sparse-arrays
    expect(findJsonEncodingProblem([, 1])).toBe('undefined-value');
    // 正常对象与 JSON.parse 产物仍可编码
    expect(findJsonEncodingProblem({ a: 1, nested: { b: [1, 2, 3] } })).toBeNull();
  });
});

describe('ProjectStore：连接关闭后的公开 API（第十七轮严重 4 收口回归）', () => {
  it('连接关闭后事务创建同步抛错 → save/load/list/remove/removeIfUnchanged/rename/duplicate 全部类型化失败，无一向上 reject', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '关闭前', 1));
    store.close();
    const checks: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: 'save', run: () => store.save(project('lumora://project/b', '关闭后', 1), null) },
      { name: 'load', run: () => store.load('lumora://project/a') },
      { name: 'list', run: () => store.list() },
      { name: 'remove', run: () => store.remove('lumora://project/a') },
      { name: 'removeIfUnchanged', run: () => store.removeIfUnchanged('lumora://project/a', 'fp') },
      { name: 'rename', run: () => store.rename('lumora://project/a', '关闭后改名') },
      { name: 'duplicate', run: () => store.duplicate('lumora://project/a') },
    ];
    for (const { name, run } of checks) {
      const outcome = await run();
      const typed = outcome as { ok: boolean; message?: string };
      expect(typed.ok, `${name} 应返回类型化失败，不得向上 reject`).toBe(false);
      expect(typed.message, `${name} 应携带可呈现的失败消息`).toBeTruthy();
    }
  });
});
