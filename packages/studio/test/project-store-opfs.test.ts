import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import { OpfsProjectStore, projectFileName } from '../src/persistence/project-store-opfs';
import { MemDirectoryHandle, MemFileHandle } from './opfs-fs-shim';

const DB = 'lumora-test-opfs';

function project(uri: string, name: string, revision: number) {
  return { ...createBlankProject(uri, name), revision };
}

/** 把内存根目录挂到 navigator.storage.getDirectory（生产代码的注入点） */
function stubNavigatorWithRoot(root: MemDirectoryHandle): void {
  vi.stubGlobal(
    'navigator',
    Object.create(navigator, {
      storage: {
        value: { getDirectory: async () => root },
        configurable: true,
      },
    }),
  );
}

beforeEach(async () => {
  stubNavigatorWithRoot(new MemDirectoryHandle('root'));
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
    const loaded = await reopened.load('lumora://project/a');
    expect(loaded).toEqual(saved);
    // load 返回可自由修改的副本，不得影响存储中的记录
    loaded!.name = '被调用方修改';
    expect((await reopened.load('lumora://project/a'))!.name).toBe('持久化项目');
    reopened.close();
  });

  it('list 按保存时间倒序返回摘要（最近项目列表）', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/old', '旧项目', 1));
    await new Promise((r) => setTimeout(r, 5));
    await store.save(project('lumora://project/new', '新项目', 2));
    const summaries = await store.list();
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
    expect((await store.load('lumora://project/a'))!.name).toBe('较新');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('较新');

    // 期望基线匹配（= 已存 5）时允许写入
    const fresh = project('lumora://project/a', '新内容', 6);
    expect((await store.save(fresh, 5)).ok).toBe(true);
    expect((await store.load('lumora://project/a'))!.name).toBe('新内容');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('首个');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('同名');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('分叉前');
    store.close();
  });

  it('remove 删除项目，重复删除返回 false', async () => {
    const store = await OpfsProjectStore.create(DB);
    if (!store) return;
    await store.save(project('lumora://project/a', '待删除', 1));
    expect(await store.remove('lumora://project/a')).toBe(true);
    expect(await store.load('lumora://project/a')).toBeNull();
    expect(await store.remove('lumora://project/a')).toBe(false);
    store.close();
  });

  it('rename 仅作用于已存储项目；不存在时返回 not-found', async () => {
    const store = await OpfsProjectStore.create(DB);
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
    const store = await OpfsProjectStore.create(DB);
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
    expect((await storeA.load('lumora://project/a'))!.name).toBe('A 的较新内容');

    // B 重新打开（读到 rev5）后以新基线保存成功
    const fresh = project('lumora://project/a', 'B 基于较新内容', 6);
    expect((await storeB.save(fresh, 5)).ok).toBe(true);
    expect((await storeA.load('lumora://project/a'))!.name).toBe('B 基于较新内容');
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

    expect(await store.load('lumora://project/broken')).toBeNull();
    // 创建语义与 CAS 都拒绝覆盖损坏记录
    const result = await store.save(project('lumora://project/broken', '试图覆盖', 1), null);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('损坏');
    // remove 删除损坏文件（用户修复路径）
    expect(await store.remove('lumora://project/broken')).toBe(true);
    expect((await store.list()).map((s) => s.uri)).toEqual([]);
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

    expect(await store.load('lumora://project/incomplete')).toBeNull();
    expect(await store.load('lumora://project/mismatch')).toBeNull();
    // list 跳过结构损坏记录，不把半写数据当项目
    expect((await store.list()).map((s) => s.uri)).toEqual([]);
    const result = await store.save(project('lumora://project/incomplete', '试图覆盖', 1), null);
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'storage-error') return;
    expect(result.message).toContain('损坏');
    expect(await store.remove('lumora://project/incomplete')).toBe(true);
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
    expect(await store.load('lumora://project/a')).toBeNull();

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
    expect((await store.load('lumora://project/a'))).toEqual(saved);
    // 覆盖写入（CAS 通过）也走降级路径
    expect((await store.save(project('lumora://project/a', '降级更新', 4), 3)).ok).toBe(true);
    expect((await store.load('lumora://project/a'))!.name).toBe('降级更新');
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
    expect((await store.load('lumora://project/a'))!.name).toBe('已落盘内容');
    // 临时文件被清理：list 不受影响
    expect((await store.list()).map((s) => s.uri)).toEqual(['lumora://project/a']);
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
});
