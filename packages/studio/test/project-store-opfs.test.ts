import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, migrateProjectSchema } from '@lumora/core';
import type { Project } from '@lumora/core';
import { OpfsProjectStore, projectFileName } from '../src/persistence/project-store-opfs';
import { MemDirectoryHandle, MemFileHandle, stubOpfsNavigator } from './opfs-fs-shim';
import type { ProjectStorage, ProjectSummary } from '../src/persistence/project-storage';

const DB = 'lumora-test-opfs';
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
  stubOpfsNavigator(new MemDirectoryHandle('root'));
  await OpfsProjectStore.drop(DB);
});

afterEach(async () => {
  await OpfsProjectStore.drop(DB);
  vi.unstubAllGlobals();
});

describe('OpfsProjectStore：OPFS 持久化（FR-011，行为与 IndexedDB 一致）', () => {
  it('保存后可重新打开读取（跨连接持久化）', async () => {
    const store = await OpfsProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    const saved = project('lumora://project/a', '持久化项目', 3);
    expect((await store.save(saved)).ok).toBe(true);
    store.close();

    const reopened = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/old', '旧项目', 1));
    await new Promise((r) => setTimeout(r, 5));
    await store.save(project('lumora://project/new', '新项目', 2));
    const summaries = await listStored(store);
    expect(summaries.map((s) => s.uri)).toEqual(['lumora://project/new', 'lumora://project/old']);
    expect(summaries[0]).toMatchObject({ name: '新项目', revision: 2, schemaVersion: 3 });
    store.close();
  });

  it('防倒退（NFR-003）：期望基线落后于已存 revision 时拒绝写入且不覆盖', async () => {
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '待删除', 1));
    expect(await store.remove('lumora://project/a')).toEqual({ ok: true, removed: true });
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();
    expect(await store.remove('lumora://project/a')).toEqual({ ok: true, removed: false });
    store.close();
  });

  it('rename 仅作用于已存储项目；不存在时返回 not-found', async () => {
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const result = await store.duplicate('lumora://project/nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-found');
    store.close();
  });

  it('跨实例并发（模拟跨标签页）：旧基线保存被互斥临界区后的较新记录拒绝', async () => {
    const storeA = await OpfsProjectStore.create(DB);
    const storeB = await OpfsProjectStore.create(DB);
    if (!storeA || !storeB) return;
    // A 保存 rev5
    const newer = project('lumora://project/a', 'A 的较新内容', 5);
    expect((await storeA.save(newer)).ok).toBe(true);

    // B 持有打开时的旧基线 3：互斥临界区内重读发现已存 5 ≠ 3 → 冲突，不覆盖
    const stale = project('lumora://project/a', 'B 的旧内容', 3);
    const result = await storeB.save(stale, 3);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'revision-conflict') return;
    expect(result.storedRevision).toBe(5);
    expect((await loadStored(storeA, 'lumora://project/a'))!.name).toBe('A 的较新内容');

    // B 重新打开（读到 rev5）后以新基线保存成功
    const fresh = project('lumora://project/a', 'B 基于较新内容', 6);
    expect((await storeB.save(fresh, 5)).ok).toBe(true);
    expect((await loadStored(storeA, 'lumora://project/a'))!.name).toBe('B 基于较新内容');
    storeA.close();
    storeB.close();
  });

  it('损坏记录：load 视为缺失、save 拒绝覆盖、remove 可删除（修复路径）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    // 直接向存储目录写入非法 JSON（模拟外部改动/半写）
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    await projectsDir.getFileHandle(projectFileName('lumora://project/broken'), { create: true });

    expect(await loadStored(store, 'lumora://project/broken')).toBeNull();
    // 创建语义与 CAS 都拒绝覆盖损坏记录
    const result = await store.save(project('lumora://project/broken', '试图覆盖', 1), null);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('损坏');
    // remove 删除损坏文件（用户修复路径）
    expect(await store.remove('lumora://project/broken')).toEqual({ ok: true, removed: true });
    expect((await listStored(store)).map((s) => s.uri)).toEqual([]);
    store.close();
  });

  it('结构损坏记录（合法 JSON 但形状错误）：load 视为缺失、list 跳过、save 拒绝、remove 可删除（第五轮 #9）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    // 缺 project 对象的半写记录
    const incomplete = await projectsDir.getFileHandle(projectFileName('lumora://project/incomplete'), { create: true });
    const writable = await incomplete.createWritable();
    await writable.write(JSON.stringify({ uri: 'lumora://project/incomplete', savedAt: 'x' }));
    await writable.close();
    // 记录外壳与 project.uri 不一致（外部改动）
    const mismatched = await projectsDir.getFileHandle(projectFileName('lumora://project/mismatch'), { create: true });
    const writable2 = await mismatched.createWritable();
    await writable2.write(
      JSON.stringify({
        uri: 'lumora://project/mismatch',
        savedAt: 'x',
        project: { uri: 'lumora://project/other', name: 'n', schemaVersion: 3, revision: 0 },
      }),
    );
    await writable2.close();

    expect(await loadStored(store, 'lumora://project/incomplete')).toBeNull();
    expect(await loadStored(store, 'lumora://project/mismatch')).toBeNull();
    // list 跳过结构损坏记录，不把半写数据当项目
    expect((await listStored(store)).map((s) => s.uri)).toEqual([]);
    const result = await store.save(project('lumora://project/incomplete', '试图覆盖', 1), null);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('损坏');
    expect(await store.remove('lumora://project/incomplete')).toEqual({ ok: true, removed: true });
    store.close();
  });

  it('JSON 不可编码数据：与 IndexedDB 一致事务前拒绝（undefined / 非有限数值 / 循环引用）（第五轮 #8）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const badUndefined = project('lumora://project/a', '含 undefined', 1) as Project & Record<string, unknown>;
    badUndefined.extra = undefined;
    const resultUndefined = await store.save(badUndefined as Project, null);
    expect(resultUndefined).toMatchObject({ ok: false, code: 'storage-error' });
    if (resultUndefined.ok || resultUndefined.code !== 'storage-error') return;
    expect(resultUndefined.message).toContain('undefined');
    expect(await loadStored(store, 'lumora://project/a')).toBeNull();

    const badNaN = project('lumora://project/b', '非有限数值', 1);
    badNaN.settings = { ...badNaN.settings, fps: NaN };
    const resultNaN = await store.save(badNaN, null);
    expect(resultNaN).toMatchObject({ ok: false, code: 'storage-error' });
    if (resultNaN.ok || resultNaN.code !== 'storage-error') return;
    expect(resultNaN.message).toContain('non-finite');

    const badCircular = project('lumora://project/c', '循环引用', 1) as Project & Record<string, unknown>;
    badCircular.loop = badCircular;
    const resultCircular = await store.save(badCircular as Project, null);
    expect(resultCircular).toMatchObject({ ok: false, code: 'storage-error' });
    if (resultCircular.ok || resultCircular.code !== 'storage-error') return;
    expect(resultCircular.message).toContain('circular');
    store.close();
  });

  it('move 能力缺失（受限环境）：非原子降级直接写目标，保存/读取语义不变', async () => {
    // 构造 move 缺失的文件系统：root/DB/projects 链上，projects 目录的
    // getFileHandle 返回去掉 move 能力的包装句柄（能力探测 → 降级路径）
    const root = new MemDirectoryHandle('root');
    const noMoveFile = (handle: MemFileHandle) =>
      new Proxy(handle, {
        get(h, hp, hr) {
          if (hp === 'move') return undefined;
          return Reflect.get(h, hp, hr);
        },
      });
    const noMoveDir = (dir: MemDirectoryHandle) =>
      new Proxy(dir, {
        get(t, p, r) {
          if (p === 'getFileHandle') {
            return async (name: string, options?: { create?: boolean }) => {
              const handle = await (t as MemDirectoryHandle).getFileHandle(name, options);
              return noMoveFile(handle as MemFileHandle);
            };
          }
          const value = Reflect.get(t, p, r);
          return typeof value === 'function' ? value.bind(t) : value;
        },
      });
    const rootProxy = new Proxy(root, {
      get(t, p, r) {
        if (p === 'getDirectoryHandle') {
          return async (name: string, options?: { create?: boolean }) => {
            if (name === DB) {
              const dir = await (t as MemDirectoryHandle).getDirectoryHandle(name, options);
              // 再包一层：使其 getDirectoryHandle('projects') 返回去 move 的目录
              return new Proxy(dir as MemDirectoryHandle, {
                get(d, dp, dr) {
                  if (dp === 'getDirectoryHandle') {
                    return async (subName: string, subOpts?: { create?: boolean }) => {
                      const sub = await (d as MemDirectoryHandle).getDirectoryHandle(subName, subOpts);
                      return subName === 'projects' ? noMoveDir(sub as MemDirectoryHandle) : sub;
                    };
                  }
                  const value = Reflect.get(d, dp, dr);
                  return typeof value === 'function' ? value.bind(d) : value;
                },
              });
            }
            return (t as MemDirectoryHandle).getDirectoryHandle(name, options);
          };
        }
        const value = Reflect.get(t, p, r);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
    const store = await OpfsProjectStore.create(DB, rootProxy);
    if (!store) return;

    const saved = project('lumora://project/a', '降级保存', 3);
    expect((await store.save(saved)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/a'))).toEqual(saved);
    // 覆盖写入（CAS 通过）也走降级路径
    expect((await store.save(project('lumora://project/a', '降级更新', 4), 3)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('降级更新');
    store.close();
  });

  it('move 方法存在但抛 NotSupportedError（受限后端）：清理 .tmp 后降级直接写目标，不残留临时文件（第六轮一般项）', async () => {
    // 与上一测试相同的代理链，但 move 存在且明确抛能力错误（而非缺失）
    const root = new MemDirectoryHandle('root');
    const throwingMoveFile = (handle: MemFileHandle) =>
      new Proxy(handle, {
        get(h, hp, hr) {
          if (hp === 'move') {
            return async () => {
              throw new DOMException('该后端不支持 move', 'NotSupportedError');
            };
          }
          return Reflect.get(h, hp, hr);
        },
      });
    const throwingMoveDir = (dir: MemDirectoryHandle) =>
      new Proxy(dir, {
        get(t, p, r) {
          if (p === 'getFileHandle') {
            return async (name: string, options?: { create?: boolean }) => {
              const handle = await (t as MemDirectoryHandle).getFileHandle(name, options);
              return throwingMoveFile(handle as MemFileHandle);
            };
          }
          const value = Reflect.get(t, p, r);
          return typeof value === 'function' ? value.bind(t) : value;
        },
      });
    const rootProxy = new Proxy(root, {
      get(t, p, r) {
        if (p === 'getDirectoryHandle') {
          return async (name: string, options?: { create?: boolean }) => {
            const dir = await (t as MemDirectoryHandle).getDirectoryHandle(name, options);
            if (name === DB) {
              return new Proxy(dir as MemDirectoryHandle, {
                get(d, dp, dr) {
                  if (dp === 'getDirectoryHandle') {
                    return async (subName: string, subOpts?: { create?: boolean }) => {
                      const sub = await (d as MemDirectoryHandle).getDirectoryHandle(subName, subOpts);
                      return subName === 'projects' ? throwingMoveDir(sub as MemDirectoryHandle) : sub;
                    };
                  }
                  const value = Reflect.get(d, dp, dr);
                  return typeof value === 'function' ? value.bind(d) : value;
                },
              });
            }
            return dir;
          };
        }
        const value = Reflect.get(t, p, r);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
    const store = await OpfsProjectStore.create(DB, rootProxy);
    if (!store) return;

    const saved = project('lumora://project/a', '降级保存', 3);
    expect((await store.save(saved)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/a'))).toEqual(saved);
    expect((await store.save(project('lumora://project/a', '降级更新', 4), 3)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('降级更新');
    // 仅对明确能力错误降级后不留 .tmp
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const names: string[] = [];
    for await (const [name] of projectsDir.entries()) names.push(name);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    store.close();
  });

  it('深度损坏记录（缺 settings/scenes/objects/tracks/assets 或图关系损坏）：load 视为缺失、list 跳过、rename/duplicate 不传播、save 拒绝（第六轮一般项）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const writeFile = async (uri: string, project: unknown) => {
      const handle = await projectsDir.getFileHandle(projectFileName(uri), { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify({ uri, savedAt: 'x', project }));
      await writable.close();
    };
    // 记录形状合法（isStoredProjectRecord 通过）但缺 settings/scenes/objects/tracks/assets
    await writeFile('lumora://project/missing-sections', {
      uri: 'lumora://project/missing-sections',
      name: '缺字段',
      schemaVersion: 3,
      revision: 0,
    });
    // 图关系损坏：父级不存在（孤儿对象）
    const good = project('lumora://project/good', '合法项目', 0);
    const orphan = {
      ...good,
      uri: 'lumora://project/orphan',
      objects: [{ ...good.objects[0]!, parentId: 'nonexistent' }],
    };
    await writeFile('lumora://project/orphan', orphan);

    expect(await loadStored(store, 'lumora://project/missing-sections')).toBeNull();
    expect(await loadStored(store, 'lumora://project/orphan')).toBeNull();
    // 最近列表不出现损坏记录
    expect((await listStored(store)).map((s) => s.uri)).toEqual([]);
    // rename/duplicate 不得传播损坏内容
    expect(await store.rename('lumora://project/missing-sections', '改名')).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(await store.duplicate('lumora://project/orphan')).toMatchObject({ ok: false, code: 'not-found' });
    // save 拒绝覆盖（可删除后重试）
    const result = await store.save(project('lumora://project/missing-sections', '试图覆盖', 1), null);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('损坏');
    store.close();
  });

  it('未来 schema 记录（v>CURRENT）：raw 原样返回不折叠为 null（第七轮 #6），迁移提示由 facade 统一给出', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const good = project('lumora://project/future', '合法项目', 3);
    const future = { ...good, uri: 'lumora://project/future', schemaVersion: 99 };
    const handle = await projectsDir.getFileHandle(projectFileName('lumora://project/future'), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify({ uri: 'lumora://project/future', savedAt: 'x', project: future }));
    await writable.close();

    // 不做猜测校验、不折叠：raw 原样返回（facade 的 migrate 失败自然给出升级提示）
    const loaded = await loadStored(store, 'lumora://project/future');
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(99);
    expect(loaded!.name).toBe('合法项目');
    expect(loaded!.revision).toBe(3);
    // 最近列表同样呈现（list 不因版本折叠未来记录）
    expect((await listStored(store)).map((s) => s.uri)).toEqual(['lumora://project/future']);
    store.close();
  });

  it('版本感知读取（第七轮 #6）：v2 记录 raw 原样返回（不提前迁移，迁移写回由 facade 统一完成）；迁移结果仍损坏的记录视为损坏', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const writeFile = async (uri: string, project: unknown) => {
      const handle = await projectsDir.getFileHandle(projectFileName(uri), { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify({ uri, savedAt: 'x', project }));
      await writable.close();
    };
    const v3 = project('lumora://project/v2', '旧版本', 2);
    const v2: Record<string, unknown> = { ...v3, schemaVersion: 2 };
    delete v2.tracks; // v2 无 tracks 字段
    await writeFile('lumora://project/v2', v2);
    const loaded = await loadStored(store, 'lumora://project/v2');
    expect(loaded).not.toBeNull();
    // raw/source schema 保留：适配器层不提前迁移（否则迁移写回与 migratedFrom 丢失）
    expect(loaded!.schemaVersion).toBe(2);
    expect((loaded as unknown as Record<string, unknown>).tracks).toBeUndefined();
    expect(loaded!.revision).toBe(2);
    expect(loaded!.name).toBe('旧版本');
    // 迁移后仍缺 settings：深度校验拒绝，不把旧版本半写数据当合法记录
    await writeFile('lumora://project/v2bad', {
      uri: 'lumora://project/v2bad',
      name: '坏',
      schemaVersion: 2,
      revision: 0,
    });
    expect(await loadStored(store, 'lumora://project/v2bad')).toBeNull();
    store.close();
  });

  it('schema 升级写回豁免（第七轮 #5）：v2/rev7 baseline 仅接受精确迁移结果的同 revision 覆盖，任意分叉拒绝', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const writeFile = async (uri: string, project: unknown) => {
      const handle = await projectsDir.getFileHandle(projectFileName(uri), { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify({ uri, savedAt: 'x', project }));
      await writable.close();
    };
    const v3 = project('lumora://project/a', '旧版', 7);
    const { tracks: _tracks, ...v2 } = v3;
    const baseline = { ...v2, schemaVersion: 2 } as unknown as Project;
    await writeFile('lumora://project/a', baseline);

    // 任意 v3/rev7 分叉（仅升级 schemaVersion + 场景内容被改写）：不得借「升级」覆盖
    const divergent = {
      ...v3,
      schemaVersion: 3,
      scenes: [{ ...v3.scenes[0]!, name: '被篡改的场景' }],
    } as unknown as Project;
    const forked = await store.save(divergent, 7);
    expect(forked.ok).toBe(false);
    if (forked.ok || forked.code !== 'revision-conflict') return;
    expect((await loadStored(store, 'lumora://project/a'))!.schemaVersion).toBe(2);

    // 精确迁移结果（migrateProjectSchema(baseline)）：放行（facade loadProject 的迁移写回）
    const migrated = migrateProjectSchema(baseline);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect((await store.save(migrated.project as Project, 7)).ok).toBe(true);
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.schemaVersion).toBe(3);
    expect(stored!.revision).toBe(7);
    store.close();
  });

  it('文件名与记录 uri 严格绑定（第七轮 #8）：错位文件名的合法记录视为缺失，load/list/save 隔离', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    // 内容完全合法的记录，但文件名与 uri 哈希错位（外部复制/重命名产生）
    const good = project('lumora://project/real', '真实项目', 3);
    const handle = await projectsDir.getFileHandle(projectFileName('lumora://project/other'), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify({ uri: 'lumora://project/real', savedAt: 'x', project: good }));
    await writable.close();

    // 显式比对请求 uri 与记录 uri：错误文件不得返回错误记录
    expect(await loadStored(store, 'lumora://project/real')).toBeNull();
    // list 跳过错位记录（不把错误文件当最近项目）
    expect((await listStored(store)).map((s) => s.uri)).toEqual([]);
    // save 到正确文件名不受错位文件影响（创建语义）
    expect((await store.save(good, null)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/real'))).toEqual(good);
    store.close();
  });

  it('move 抛非 NotSupported 的通用错误：保存如实失败、.tmp 清理、旧记录保持原样（第七轮 #7）', async () => {
    // 代理链与 NotSupportedError 测试相同，但 move 抛普通错误（不得降级直接写）
    const throwingMoveFile = (handle: MemFileHandle) =>
      new Proxy(handle, {
        get(h, hp, hr) {
          if (hp === 'move') {
            return async () => {
              throw new Error('文件系统 move 失败');
            };
          }
          return Reflect.get(h, hp, hr);
        },
      });
    const throwingMoveDir = (dir: MemDirectoryHandle) =>
      new Proxy(dir, {
        get(t, p, r) {
          if (p === 'getFileHandle') {
            return async (name: string, options?: { create?: boolean }) => {
              const handle = await (t as MemDirectoryHandle).getFileHandle(name, options);
              return throwingMoveFile(handle as MemFileHandle);
            };
          }
          const value = Reflect.get(t, p, r);
          return typeof value === 'function' ? value.bind(t) : value;
        },
      });
    const root = new MemDirectoryHandle('root');
    const rootProxy = new Proxy(root, {
      get(t, p, r) {
        if (p === 'getDirectoryHandle') {
          return async (name: string, options?: { create?: boolean }) => {
            const dir = await (t as MemDirectoryHandle).getDirectoryHandle(name, options);
            if (name === DB) {
              return new Proxy(dir as MemDirectoryHandle, {
                get(d, dp, dr) {
                  if (dp === 'getDirectoryHandle') {
                    return async (subName: string, subOpts?: { create?: boolean }) => {
                      const sub = await (d as MemDirectoryHandle).getDirectoryHandle(subName, subOpts);
                      return subName === 'projects' ? throwingMoveDir(sub as MemDirectoryHandle) : sub;
                    };
                  }
                  const value = Reflect.get(d, dp, dr);
                  return typeof value === 'function' ? value.bind(d) : value;
                },
              });
            }
            return dir;
          };
        }
        const value = Reflect.get(t, p, r);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
    const store = await OpfsProjectStore.create(DB, rootProxy);
    if (!store) return;
    // 预置已落盘记录（绕过 move 路径直接写入）
    const saved = project('lumora://project/a', '已落盘内容', 3);
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const handle = await projectsDir.getFileHandle(projectFileName('lumora://project/a'), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify({ uri: 'lumora://project/a', savedAt: 'x', project: saved }));
    await writable.close();

    // 覆盖保存（CAS 通过）→ move 通用错误 → 如实失败，不降级直接写
    const result = await store.save(project('lumora://project/a', '更新内容', 4), 3);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'storage-error') return;
    // 旧记录保持原样；.tmp 被尽力清理
    expect((await loadStored(store, 'lumora://project/a'))).toEqual(saved);
    const names: string[] = [];
    for await (const [name] of projectsDir.entries()) names.push(name);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    store.close();
  });

  it('拒绝 schema 降级（第六轮 #6）：以旧 schema 版本覆盖较新记录返回 schema-downgrade，不写入', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const current = project('lumora://project/a', 'v3', 0);
    expect((await store.save(current)).ok).toBe(true);
    const old = { ...current, schemaVersion: 2 } as unknown as Project;
    const result = await store.save(old, 0);
    expect(result).toMatchObject({ ok: false, code: 'schema-downgrade' });
    if (result.ok || result.code !== 'schema-downgrade') return;
    expect(result.message).toContain('schema');
    const stored = await loadStored(store, 'lumora://project/a');
    expect(stored!.schemaVersion).toBe(3);
    store.close();
  });

  it('JSON 不可编码数据扩展：BigInt 与数组非索引键（pluginData.arr.extra）与 IndexedDB 一致拒绝（第六轮 #5）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const badBigInt = project('lumora://project/a', 'BigInt', 1) as Project & Record<string, unknown>;
    badBigInt.extra = { value: 1n };
    const resultBigInt = await store.save(badBigInt as Project, null);
    expect(resultBigInt).toMatchObject({ ok: false, code: 'storage-error' });
    if (resultBigInt.ok || resultBigInt.code !== 'storage-error') return;
    expect(resultBigInt.message).toContain('bigint');

    const badArr = project('lumora://project/b', '数组扩展键', 1);
    const arr = [1, 2] as unknown as Record<string, unknown>;
    arr.extra = 3;
    (badArr as { pluginData?: Record<string, unknown> }).pluginData = { arr: arr as unknown as unknown[] };
    const resultArr = await store.save(badArr, null);
    expect(resultArr).toMatchObject({ ok: false, code: 'storage-error' });
    if (resultArr.ok || resultArr.code !== 'storage-error') return;
    expect(resultArr.message).toContain('array-extra-keys');
    expect(await loadStored(store, 'lumora://project/b')).toBeNull();
    store.close();
  });

  it('文件名固定前缀 + uri 哈希：任意 uri（含文件系统敏感字符）都映射为安全文件名', () => {
    const a = projectFileName('lumora://project/安全中文名');
    const b = projectFileName('lumora://project/../%2e%2e/x');
    expect(a).toMatch(/^p_[0-9a-f]{16}\.json$/);
    expect(b).toMatch(/^p_[0-9a-f]{16}\.json$/);
    expect(a).not.toBe(b);
    // 同 uri 稳定映射
    expect(projectFileName('lumora://project/安全中文名')).toBe(a);
  });

  it('配额不足：写入失败返回 quota-exceeded，旧记录保持原样且无临时文件残留', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const saved = project('lumora://project/a', '已落盘内容', 2);
    expect((await store.save(saved)).ok).toBe(true);

    // 注入写入失败（QuotaExceededError）后重存同 uri 内容
    const root = (await navigator.storage.getDirectory()) as unknown as MemDirectoryHandle;
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    projectsDir.failNextWrite(new DOMException('磁盘配额不足', 'QuotaExceededError'));

    const result = await store.save(project('lumora://project/a', '放不下的内容', 3), 2);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'quota-exceeded') return;
    // 原子写保护：旧记录未被半写覆盖
    expect((await loadStored(store, 'lumora://project/a'))!.name).toBe('已落盘内容');
    // 临时文件被清理：list 不受影响
    expect((await listStored(store)).map((s) => s.uri)).toEqual(['lumora://project/a']);
    const names: string[] = [];
    for await (const [name] of projectsDir.entries()) names.push(name);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    store.close();
  });

  it('OPFS 不可用时 create 返回 null（持久化静默降级）', async () => {
    vi.stubGlobal(
      'navigator',
      Object.create(navigator, {
        storage: { value: {}, configurable: true },
      }),
    );
    expect(await OpfsProjectStore.create(DB)).toBeNull();
  });

  it('无 Web Locks 禁用 OPFS（第十五轮待确认风险固化）：生产路径无跨标签页互斥保障即降级，测试注入 fs 跳过该检查', async () => {
    // 先还原 jsdom 原生 navigator（无 locks）再仅挂 storage（Object.create
    // 会继承 beforeEach 的 locks stub）：Web Locks 是 OPFS 跨标签页互斥的
    // 唯一保障，缺失时进程内退化锁只保证同标签页串行（清理竞态窗口仍在）→
    // 禁用 OPFS
    vi.unstubAllGlobals();
    const root = new MemDirectoryHandle('root');
    vi.stubGlobal(
      'navigator',
      Object.create(navigator, {
        storage: { value: { getDirectory: async () => root }, configurable: true },
      }),
    );
    expect(await OpfsProjectStore.create(DB)).toBeNull();
    // 测试注入 fs 时信任测试环境（互斥由测试桩保证），不执行该检查
    const injected = await OpfsProjectStore.create(DB, new MemDirectoryHandle('root2'));
    expect(injected).not.toBeNull();
    injected?.close();
  });

  it('退化锁（无 Web Locks + fs 注入）：锁内任务 reject 后队列不被毒化，后续任务照常执行（第十五轮严重 4）', async () => {
    // 先还原 jsdom 原生 navigator（无 locks）再仅挂 storage；注入 fs 绕过
    // Web Locks 启用检查 → 锁退化到进程内 promise 链（withFallbackLock），
    // 验证锁内异常后队列仍前进
    vi.unstubAllGlobals();
    const root = new MemDirectoryHandle('root');
    vi.stubGlobal(
      'navigator',
      Object.create(navigator, {
        storage: { value: { getDirectory: async () => root }, configurable: true },
      }),
    );
    const store = await OpfsProjectStore.create(DB, root);
    expect(store).not.toBeNull();
    if (!store) return;
    expect((await store.save(project('lumora://project/chain', '队列项目', 1))).ok).toBe(true);

    // 第一个任务在锁内 reject：list 的目录 entries 抛错 —— 第十七轮严重 4 起
    // list 与其余方法一样把锁内故障收口为类型化结果，异常不再向外传播
    const rootDir = await root.getDirectoryHandle(DB);
    const projectsDir = await rootDir.getDirectoryHandle('projects');
    const originalEntries = projectsDir.entries;
    projectsDir.entries = (() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error('entries boom');
          },
        };
      },
    })) as unknown as typeof projectsDir.entries;
    const listOutcome = await store.list();
    expect(listOutcome.ok).toBe(false);
    if (listOutcome.ok) return;
    expect(listOutcome.message).toContain('entries boom');
    projectsDir.entries = originalEntries;

    // 修复前：前序任务 reject 使退化锁链上的 gate 无人 release，后续任务永久挂起；
    // 修复后：队列前进，后续保存照常执行
    expect((await store.save(project('lumora://project/chain', '队列项目', 2), 1)).ok).toBe(true);
    expect((await loadStored(store, 'lumora://project/chain'))!.revision).toBe(2);
    store.close();
  });

  it('Web Locks 获取失败（锁管理器 reject）：removeIfUnchanged 返回类型化结果，不向调用方二次抛出（第十五轮严重 4）', async () => {
    const store = await OpfsProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    const locks = (navigator as unknown as { locks: { request: (...args: unknown[]) => Promise<unknown> } }).locks;
    const realRequest = locks.request.bind(locks);
    locks.request = async () => {
      throw new Error('locks unavailable');
    };
    try {
      const result = await store.removeIfUnchanged('lumora://project/a', 'fp');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('副本清理失败');
      const dup = await store.duplicate('lumora://project/a');
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.message).toContain('复制失败');
    } finally {
      locks.request = realRequest;
      store.close();
    }
  });

  it('Web Locks 获取失败（锁管理器 reject）：list/load/save/remove/rename/removeIfUnchanged/duplicate 公开 API 矩阵全部类型化失败，无一向上 reject（第十七轮严重 4）', async () => {
    const store = await OpfsProjectStore.create(DB);
    expect(store).not.toBeNull();
    if (!store) return;
    await store.save(project('lumora://project/a', '矩阵项目', 1));
    const locks = (navigator as unknown as { locks: { request: (...args: unknown[]) => Promise<unknown> } }).locks;
    const realRequest = locks.request.bind(locks);
    locks.request = async () => {
      throw new Error('locks unavailable');
    };
    try {
      const checks: Array<{ name: string; run: () => Promise<unknown> }> = [
        { name: 'list', run: () => store.list() },
        { name: 'load', run: () => store.load('lumora://project/a') },
        { name: 'save', run: () => store.save(project('lumora://project/b', '矩阵保存', 1), null) },
        { name: 'remove', run: () => store.remove('lumora://project/a') },
        { name: 'rename', run: () => store.rename('lumora://project/a', '矩阵改名') },
        { name: 'removeIfUnchanged', run: () => store.removeIfUnchanged('lumora://project/a', 'fp') },
        { name: 'duplicate', run: () => store.duplicate('lumora://project/a') },
      ];
      for (const { name, run } of checks) {
        const outcome = await run();
        const typed = outcome as { ok: boolean; message?: string };
        expect(typed.ok, `${name} 应返回类型化失败，不得向上 reject`).toBe(false);
        expect(typed.message, `${name} 的失败消息应如实包含锁故障原因`).toContain('locks unavailable');
      }
    } finally {
      locks.request = realRequest;
      store.close();
    }
  });

  it('save 同步不可变快照（第八轮 #1）：保存挂起期间改写入参 uri 不改变落盘目标（OPFS）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const p = project('lumora://project/a', '快照测试', 0);
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (incoming, expected) => {
      // 真实 save 同步执行完预检与快照生成（首个 await 前）；此刻改写入参
      // uri —— 后续文件名/锁名/CAS/写入必须仍按入口快照（a），不得落到 b
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

  it('访问器属性项目 —— 反射预检先于克隆拒绝（第九轮 #2：先克隆再检查会物化访问器，检查形同虚设）（OPFS）', async () => {
    const store = await OpfsProjectStore.create(DB);
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
      // 反射级预检先于任何克隆：访问器（JSON 序列化会调用 getter、结构化克隆
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

  it('save 同步不可变快照（第八轮 #1）：保存挂起期间注入循环引用 —— 入口快照隔离入参变异（OPFS）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    const p = project('lumora://project/a', '注入测试', 0);
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (incoming, expected) => {
      // 真实 save 同步执行到首个 await（互斥锁）后返回 promise；此刻注入循环
      // 引用 —— 修复前写入阶段对入参做 JSON 序列化会抛错（保存失败）；
      // 修复后入口快照已生成，注入不影响本次保存
      const promise = realSave(incoming, expected);
      const cyclic: Record<string, unknown> = { self: null };
      cyclic.self = cyclic;
      (incoming as Project & Record<string, unknown>).pluginData = { cyclic };
      return promise;
    });
    const result = await store.save(p, null);
    expect(result.ok).toBe(true);
    const loaded = await loadStored(store, 'lumora://project/a');
    expect(loaded).not.toBeNull();
    expect((loaded as Project & Record<string, unknown>).pluginData?.cyclic).toBeUndefined();
    store.close();
  });

  it('未打开项目的写前变更管道（第八轮 #4）：未来 schema 拒绝 rename/duplicate，记录保持原样（OPFS）', async () => {
    const store = await OpfsProjectStore.create(DB);
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
});

describe('反射预检先于克隆（第九轮 #2）：结构化克隆会删除/物化这些结构，克隆后再检查形同虚设（OPFS）', () => {
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
    it(`${shape.name} —— save 拒绝且不落盘（修复前被克隆删除/物化，重载后字段丢失而 save 仍报成功）（OPFS）`, async () => {
      const store = await OpfsProjectStore.create(DB);
      if (!store) return;
      try {
        const p = project('lumora://project/a', '预检测试', 0);
        shape.tamper(p);
        const result = await store.save(p, null);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('storage-error');
        expect(result.message).toContain(shape.problem);
        // 预检在任何克隆/写入之前：拒绝后无任何记录
        expect(await loadStored(store, 'lumora://project/a')).toBeNull();
        expect(await listStored(store)).toEqual([]);
      } finally {
        store.close();
      }
    });
  }
});

describe('复制后验证/清理异常安全（第九轮 #5，OPFS）', () => {
  it('duplicate：验证读取抛错（load reject）→ 清理副本并如实报错，绝不遗留半成品复制', async () => {
    const store = await OpfsProjectStore.create(DB);
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

  it('duplicate：副本清理 remove 抛错 —— 如实说明清理失败与副本保留，绝不掩盖', async () => {
    const store = await OpfsProjectStore.create(DB);
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
    vi.spyOn(store, 'removeIfUnchanged').mockResolvedValue({ ok: false, message: '删除失败' });
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
