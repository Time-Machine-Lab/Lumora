import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject } from '@lumora/core';
import { ProjectStore } from '../src/persistence/project-store';

const DB = 'lumora-test-store';

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
    const loaded = await reopened.load('lumora://project/a');
    expect(loaded).toEqual(saved);
    // load 返回可自由修改的副本，不得影响存储中的记录
    loaded!.name = '被调用方修改';
    expect((await reopened.load('lumora://project/a'))!.name).toBe('持久化项目');
    reopened.close();
  });

  it('list 按保存时间倒序返回摘要（最近项目列表）', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/old', '旧项目', 1));
    await new Promise((r) => setTimeout(r, 5));
    await store.save(project('lumora://project/new', '新项目', 2));
    const summaries = await store.list();
    expect(summaries.map((s) => s.uri)).toEqual(['lumora://project/new', 'lumora://project/old']);
    expect(summaries[0]).toMatchObject({ name: '新项目', revision: 2, schemaVersion: 2 });
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
    expect((await store.load('lumora://project/a'))!.name).toBe('较新');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('较新');

    // 期望基线匹配（= 已存 5）时允许写入
    const fresh = project('lumora://project/a', '新内容', 6);
    expect((await store.save(fresh, 5)).ok).toBe(true);
    expect((await store.load('lumora://project/a'))!.name).toBe('新内容');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('首个');
    store.close();
  });

  it('同 revision 幂等重存（自动保存抖动）允许且刷新 savedAt', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    const same = project('lumora://project/a', '同名', 7);
    expect((await store.save(same, null)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    // 期望基线 = 已存 7 → 匹配，允许重存
    expect((await store.save(project('lumora://project/a', '同名', 7), 7)).ok).toBe(true);
    expect((await store.load('lumora://project/a'))!.name).toBe('同名');
    store.close();
  });

  it('remove 删除项目，重复删除返回 false', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '待删除', 1));
    expect(await store.remove('lumora://project/a')).toBe(true);
    expect(await store.load('lumora://project/a')).toBeNull();
    expect(await store.remove('lumora://project/a')).toBe(false);
    store.close();
  });

  it('rename 仅作用于已存储项目；不存在时返回 not-found', async () => {
    const store = await ProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '原名', 1));
    const result = await store.rename('lumora://project/a', '新名');
    expect(result.ok).toBe(true);
    const loaded = await store.load('lumora://project/a');
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
    const copy = await store.load(result.summary.uri);
    expect(copy).not.toBeNull();
    expect(copy!.name).toBe('源项目 副本');
    expect(copy!.revision).toBe(0);
    expect((await store.list()).map((s) => s.uri).sort()).toEqual(['lumora://project/a', result.summary.uri]);
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
