/**
 * 项目本地存储（FR-011）：OPFS（Origin Private File System）适配器。
 *
 * 存储结构（根目录名与 IndexedDB 的库名一致，测试隔离/清空数据语义相同）：
 * - `<root>/projects/`：每项目一个文件，文件名 = encodeURIComponent(uri)，
 *   内容为 StoredProject 记录 { uri, savedAt, project }（与 IndexedDB 记录同形）；
 * - `<root>/meta/`：预留键值位（与 IndexedDB 的 meta 对象仓库对齐，暂未使用）。
 *
 * 并发安全（NFR-003 / AC2）：与 IndexedDB 的「同一事务内读-比-写 + 事务提交为
 * 完成边界」对齐 —— save 的整个临界区（读已存 → 比对期望基线 → 写入）在互斥锁内
 * 执行，提交边界为 writable.close()（数据落盘）：
 * - 同标签页与跨标签页互斥：优先用 Web Locks（navigator.locks，同源跨标签页互斥），
 *   不可用时退化为进程内 promise 链互斥（至少保证同标签页串行）；
 * - 写入采用「临时文件 + move 覆盖」：配额不足或写入中断时旧记录保持原样，
 *   杜绝半写记录（与 IndexedDB 事务的原子提交对齐）。
 * - expectedStoredRevision 的 CAS 语义与 ProjectStore 完全一致（number = 期望
 *   基线、null = 创建语义、undefined = 无条件写入），见 project-storage.ts 文件头。
 *
 * 损坏记录（IndexedDB 不可能出现、OPFS 文件可能被外部改动/半写产生）：
 * - load 视为缺失（返回 null）；save 拒绝覆盖（storage-error，可删除后重试）；
 * - list 跳过；remove 可正常删除（用户的修复路径）。
 *
 * 配额不足（QuotaExceededError）同样以可操作错误返回，调用方（自动保存）保持脏状态。
 * OPFS 不可用时 create 返回 null（持久化静默降级，与 ProjectStore 一致）。
 */

import type { Project } from '@lumora/core';
import { CURRENT_PROJECT_SCHEMA_VERSION, genId, migrateProjectSchema, validateProjectSchema, validateProjectStructure } from '@lumora/core';
import type {
  DuplicateOutcome,
  ListOutcome,
  LoadOutcome,
  ProjectStorage,
  ProjectSummary,
  RemoveIfOutcome,
  RemoveOutcome,
  RenameOutcome,
  SaveOutcome,
  StoredProject,
} from './project-storage';
import {
  failureMessage,
  findJsonEncodingProblem,
  isMigrationWriteback,
  isQuotaError,
  prepareWriteChange,
  sameProjectContent,
  stableStringify,
} from './project-storage';

/** OPFS 根目录名（与 IndexedDB 的 PROJECT_STORE_DB 同名，切换后端不混淆命名空间） */
export const OPFS_STORE_DIR = 'lumora-studio';
export const PROJECTS_DIR = 'projects';
export const META_DIR = 'meta';

/**
 * 适配器实际使用的 OPFS API 子集（最小结构类型）：真实浏览器对象在运行期满足，
 * 单测用内存 shim 满足 —— 无需完整实现 FileSystemDirectoryHandle 接口。
 */
export interface OpfsFileHandle {
  readonly kind: 'file';
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  move(destination: OpfsDirectoryHandle, name: string): Promise<void>;
}

export interface OpfsDirectoryHandle {
  readonly kind: 'directory';
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, OpfsFileHandle | OpfsDirectoryHandle]>;
}

interface OpfsStorage {
  getDirectory(): Promise<OpfsDirectoryHandle>;
}

/** 互斥锁：Web Locks 优先（跨标签页），不可用时进程内 promise 链退化（同标签页） */
interface OpfsLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function lockManager(): OpfsLockManager | null {
  const locks = (globalThis as unknown as { navigator?: { locks?: OpfsLockManager } }).navigator?.locks;
  return locks?.request ? locks : null;
}

/** 进程内退化互斥：按锁名串行化（同一运行时内所有 OpfsProjectStore 实例共享） */
const fallbackChains = new Map<string, Promise<void>>();

function withFallbackLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = fallbackChains.get(name) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 第十五轮严重 4：前一任务的拒绝（锁内异常）不得毒化整条链 —— 前序 reject
  // 时 gate 永远无人 release，后续任务全部永久挂起。吞掉前序拒绝后照常排队，
  // 任务体串行执行；任务自身的异常仍传播给调用方，但不阻塞队列前进。
  const chain = previous.catch(() => {}).then(() => gate);
  fallbackChains.set(name, chain);
  return previous.catch(() => {}).then(async () => {
    try {
      return await task();
    } finally {
      release();
    }
  });
}

/** FNV-1a 64 位哈希（BigInt）：文件名安全（固定前缀 + 十六进制，与 uri 内容一一对应）。
 *  对任意 uri 输入（含 '..'、'/' 等文件系统敏感字符）都产出安全文件名（第五轮一般项）。 */
export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 项目记录文件名：固定安全前缀 + uri 哈希（encodeURIComponent 曾允许 '..'/'/' 等
 *  保留字符进入文件名，收紧为纯哈希命名；uri 语义由记录内容校验承担） */
export function projectFileName(uri: string): string {
  return `p_${fnv1a64Hex(uri)}.json`;
}

/** 记录结构校验（第五轮 #9）：JSON 能解析 ≠ 是合法记录 —— 外部改动/半写可能留下
 *  形状错误的文件；校验失败视为损坏（load 视为缺失 / list 跳过 / save 拒绝覆盖）。 */
export function isStoredProjectRecord(value: unknown): value is StoredProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const project = record.project as Record<string, unknown> | null | undefined;
  return (
    typeof record.uri === 'string' &&
    typeof record.savedAt === 'string' &&
    project !== null &&
    typeof project === 'object' &&
    !Array.isArray(project) &&
    project.uri === record.uri &&
    typeof project.name === 'string' &&
    typeof project.schemaVersion === 'number' &&
    typeof project.revision === 'number'
  );
}

function isNotFoundError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name;
  return name === 'NotFoundError';
}

/** 明确的能力缺失错误：move 方法存在但后端不支持时按此判定降级（第六轮一般项） */
function isNotSupportedError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name;
  return name === 'NotSupportedError';
}

export class OpfsProjectStore implements ProjectStorage {
  readonly kind = 'opfs' as const;

  private constructor(
    private readonly root: OpfsDirectoryHandle,
    private readonly projectsDir: OpfsDirectoryHandle,
    readonly dbName: string,
  ) {}

  /**
   * 创建存储；OPFS 不可用或打开失败时返回 null（持久化静默降级）。
   * fs 参数仅供测试注入内存 shim；生产路径读取 navigator.storage.getDirectory()。
   * 第十五轮待确认风险固化：Web Locks 是 OPFS 跨标签页互斥的唯一保障 ——
   * navigator.locks 不可用时进程内退化只保证同标签页串行，「A 读旧指纹 → B 写新
   * 记录 → A 删 B 记录」的跨标签页清理窗口仍然存在（数据丢失）。因此生产路径
   * 无 Web Locks 即禁用 OPFS（静默降级 IndexedDB）；测试注入 fs 时信任测试
   * 环境，跳过该检查。
   */
  static async create(dbName = OPFS_STORE_DIR, fs?: OpfsDirectoryHandle): Promise<OpfsProjectStore | null> {
    if (!fs && !lockManager()) return null;
    try {
      const storage = (globalThis as unknown as { navigator?: { storage?: OpfsStorage } }).navigator?.storage;
      const root = fs ?? (storage?.getDirectory ? await storage.getDirectory() : null);
      if (!root) return null;
      const rootDir = await root.getDirectoryHandle(dbName, { create: true });
      const projectsDir = await rootDir.getDirectoryHandle(PROJECTS_DIR, { create: true });
      await rootDir.getDirectoryHandle(META_DIR, { create: true });
      return new OpfsProjectStore(rootDir, projectsDir, dbName);
    } catch {
      return null;
    }
  }

  /** 删除根目录（测试隔离 / 清空本地数据）。 */
  static async drop(dbName = OPFS_STORE_DIR, fs?: OpfsDirectoryHandle): Promise<void> {
    try {
      const storage = (globalThis as unknown as { navigator?: { storage?: OpfsStorage } }).navigator?.storage;
      const root = fs ?? (storage?.getDirectory ? await storage.getDirectory() : null);
      if (!root) return;
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      // 不存在或不可用：视为已清空
    }
  }

  /** 最近项目列表（按保存时间倒序；跳过损坏记录与临时文件）。
   *  锁获取与锁内 I/O 故障一律收口为类型化结果（第十七轮严重 4）。 */
  async list(): Promise<ListOutcome> {
    try {
      return await this.withLock(async () => {
        const summaries: ProjectSummary[] = [];
        for await (const [name, handle] of this.projectsDir.entries()) {
          if (handle.kind !== 'file' || name.startsWith('.')) continue;
          const record = await this.readRecord(name);
          if (!record) continue;
          summaries.push({
            uri: record.uri,
            name: record.project.name,
            savedAt: record.savedAt,
            revision: record.project.revision,
            schemaVersion: record.project.schemaVersion,
          });
        }
        return {
          ok: true,
          items: summaries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0)),
        };
      });
    } catch (error) {
      return { ok: false, message: failureMessage(error) };
    }
  }

  /** 加载项目（返回调用方可自由修改的副本；损坏记录视为缺失）。
   *  显式比对请求 uri 与记录 uri（哈希文件名错位时视为缺失，第七轮 #8）。
   *  锁获取与锁内 I/O 故障一律收口为类型化结果（第十七轮严重 4）。 */
  async load(uri: string): Promise<LoadOutcome> {
    try {
      return await this.withLock(async () => {
        const record = await this.readRecord(projectFileName(uri));
        if (!record) return { ok: true, project: null };
        if (record.uri !== uri) return { ok: true, project: null };
        return { ok: true, project: record.project ? structuredClone(record.project) : null };
      });
    } catch (error) {
      return { ok: false, message: failureMessage(error) };
    }
  }

  /**
   * 保存项目（CAS，NFR-003 / AC2；语义与 ProjectStore 完全一致）：
   * 互斥临界区内读-比-写，写入以「临时文件 + move 覆盖」原子替换旧记录，
   * 提交边界 = writable.close()（落盘）。
   */
  async save(project: Project, expectedStoredRevision?: number | null): Promise<SaveOutcome> {
    // 反射级 JSON 预检必须先于任何克隆（第九轮 #2，PM 复核属实）：structuredClone
    // 会删除 Symbol 键与不可枚举属性、物化访问器 —— 先克隆再检查，原输入中的
    // 这些结构在克隆结果里已不可见，检查形同虚设：OPFS 文件重载后字段静默丢失
    // 而 save 仍返回 { ok: true }。预检作用于原输入本身（getter 属性经描述符
    // 判定为 accessor-property 即拒绝，不会触发 getter 副作用），随后才克隆。
    const encodingProblem = findJsonEncodingProblem(project);
    if (encodingProblem) {
      return {
        ok: false,
        code: 'storage-error',
        message: `项目包含无法本地保存的数据（${encodingProblem}），保存被拒绝`,
      };
    }
    // 首个 await 前同步生成唯一不可变快照（第八轮 #1）：调用方可在保存挂起期间
    // 任意改写入参 project（如改 uri），后续 URI/CAS/指纹/写入全部只读该
    // 快照 —— 杜绝「CAS 按 A 查询、写入按 A'」的静默跨项目覆盖。
    // 结构化克隆抛错（DataCloneError/输入 getter 副作用）归一为类型化失败。
    let snapshot: Project;
    try {
      snapshot = structuredClone(project);
    } catch (error) {
      return {
        ok: false,
        code: 'storage-error',
        message: `项目无法本地保存（不可结构化克隆）：${failureMessage(error)}`,
      };
    }
    // 锁获取本身（locks.request reject / 进程内链故障）也在异常边界内（第十七轮
    // 严重 4）：与锁内 I/O 一样收口为类型化失败，绝不向上 reject
    try {
      return await this.withLock(async () => {
        const name = projectFileName(snapshot.uri);
        const record = await this.readRecord(name);
        if (record === null) {
          return {
            ok: false,
            code: 'storage-error',
            message: '本地项目记录已损坏，拒绝覆盖；可删除该项目后重试',
          };
        }
        const existing = record ?? undefined;
        const storedRevision = existing?.project.revision;
        const mismatch =
          expectedStoredRevision === null
            ? existing !== undefined
            : typeof expectedStoredRevision === 'number' && storedRevision !== expectedStoredRevision;
        if (mismatch) {
          return {
            ok: false,
            code: 'revision-conflict',
            message:
              expectedStoredRevision === null
                ? '本地已存在同 uri 的项目记录，未覆盖'
                : `本地保存内容与期望基线不一致（revision ${storedRevision ?? '无记录'} ≠ ${expectedStoredRevision}），未覆盖`,
            ...(storedRevision !== undefined ? { storedRevision } : {}),
          };
        }
        if (existing) {
          // CAS 通过后仍拒绝倒退与分叉（NFR-003）：旧 revision 覆盖较新记录、
          // 同 revision 写入不同内容都会让多标签页的计数收敛失效
          // 拒绝 schema 降级（第六轮 #6）：迁移只向前推进；旧 schema 内容不得
          // 覆盖较新记录（迁移豁免仅限显式的旧版→当前版操作，见 loadProject）
          if (snapshot.schemaVersion < existing.project.schemaVersion) {
            return {
              ok: false,
              code: 'schema-downgrade',
              message: `不能以旧 schema 版本（${snapshot.schemaVersion}）覆盖较新记录（${existing.project.schemaVersion}），未写入`,
              storedRevision: existing.project.revision,
            };
          }
          if (snapshot.revision < existing.project.revision) {
            return {
              ok: false,
              code: 'revision-conflict',
              message: `不能以旧 revision（${snapshot.revision}）覆盖较新记录（${existing.project.revision}），未写入`,
              storedRevision: existing.project.revision,
            };
          }
          // 分叉保护（第七轮 #5，与 IndexedDB 一致）：同 revision 内容不同一律
          // 拒绝 —— 唯一豁免是 isMigrationWriteback（incoming 精确等于
          // migrateProjectSchema(existing) 的确定性结果，facade loadProject 的
          // 迁移写回）。revision CAS 仍生效，并发更新依旧被拦截。
          if (
            snapshot.revision === existing.project.revision &&
            !sameProjectContent(snapshot, existing.project) &&
            !isMigrationWriteback(snapshot, existing.project)
          ) {
            return {
              ok: false,
              code: 'revision-conflict',
              message: `同 revision（${snapshot.revision}）但内容不同的记录已存在（分叉），未覆盖`,
              storedRevision: existing.project.revision,
            };
          }
        }
        await this.writeRecord(name, {
          uri: snapshot.uri,
          savedAt: new Date().toISOString(),
          project: snapshot,
        });
        return { ok: true };
      });
    } catch (error) {
      if (isQuotaError(error)) {
        return { ok: false, code: 'quota-exceeded', message: '本地存储空间不足，保存失败' };
      }
      return { ok: false, code: 'storage-error', message: `保存失败：${failureMessage(error)}` };
    }
  }

  /** 删除项目；返回是否真的存在并删除（removed；损坏记录同样可删除，作为修复
   *  路径）。锁获取与锁内 I/O 故障一律收口为类型化结果（第十七轮严重 4）。 */
  async remove(uri: string): Promise<RemoveOutcome> {
    try {
      return await this.withLock(async () => {
        const name = projectFileName(uri);
        const record = await this.readRecord(name);
        if (record === undefined) return { ok: true, removed: false };
        await this.projectsDir.removeEntry(name);
        return { ok: true, removed: true };
      });
    } catch (error) {
      return { ok: false, message: failureMessage(error) };
    }
  }

  /** 条件删除（第十四轮严重 4 CAS + 第十五轮严重 4/一般 7 四态）：互斥锁内
   *  读-比-删 —— 副本验证失败后的清理不得误删另一标签页已打开并保存的更新后
   *  合法记录；内容指纹一致才删除，缺失（missing）/已变化或损坏（changed）按
   *  态区分；锁获取与锁内操作的意外 reject 一并归一为类型化失败（记录可能
   *  残留），绝不向 UI 二次抛出。 */
  async removeIfUnchanged(uri: string, expectedFingerprint: string | null): Promise<RemoveIfOutcome> {
    try {
      return await this.withLock(async () => {
        const name = projectFileName(uri);
        const record = await this.readRecord(name);
        // 缺失 = 清理后置条件已满足（可能已被其他会话删除）；损坏 = 无法验证
        // 指纹，fail-closed 保留（与「已变化」同态呈现）
        if (record === undefined) return { ok: true, outcome: 'missing' };
        if (record === null || stableStringify(record.project) !== expectedFingerprint) {
          return { ok: true, outcome: 'changed' };
        }
        await this.projectsDir.removeEntry(name);
        return { ok: true, outcome: 'removed' };
      });
    } catch (error) {
      return { ok: false, message: `副本清理失败：${failureMessage(error)}` };
    }
  }

  /** 直接重命名已存储项目（仅适用于未打开的项目）；语义与 ProjectStore 一致。
   *  写前先迁移/校验（第八轮 #4：未来 schema 拒绝写前变更）。 */
  async rename(uri: string, name: string): Promise<RenameOutcome> {
    const loaded = await this.load(uri);
    if (!loaded.ok) return { ok: false, code: 'storage-error', message: loaded.message };
    const project = loaded.project;
    if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
    const prepared = prepareWriteChange(project, 'rename');
    if (!prepared.ok) return prepared;
    const renamed = { ...prepared.project, name, revision: prepared.project.revision + 1 };
    const result = await this.save(renamed, prepared.project.revision);
    if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
    return { ok: true };
  }

  /** 复制项目：新 uri + 名称（缺省「原名 副本」）+ 重置 revision/createdAt；语义与
   *  ProjectStore 一致（写前迁移/校验 + 复制后加载验证，第八轮 #4）。
   *  复制后验证/清理纳入异常安全类型化流程（第九轮 #5）：验证读取抛错、清理
   *  失败都如实返回，绝不遗留「半成品副本」假象；清理为 CAS（第十四轮严重 4）：
   *  仅当记录内容指纹与创建时一致才删除 —— 验证挂起期间另一标签页已打开并
   *  保存副本时，更新后的合法记录保留。 */
  async duplicate(uri: string, name?: string): Promise<DuplicateOutcome> {
    // 入口级异常归一（第十五轮严重 5）：源加载/克隆/指纹/save 的意外 reject
    // 一律返回类型化 storage-error —— adapter 契约不向上抛异常，UI 无需兜底
    try {
      const loaded = await this.load(uri);
      if (!loaded.ok) return { ok: false, code: 'storage-error', message: `复制失败：${loaded.message}` };
      const project = loaded.project;
      if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
      const prepared = prepareWriteChange(project, 'duplicate');
      if (!prepared.ok) return prepared;
      const source = prepared.project;
      const copy: Project = {
        ...structuredClone(source),
        uri: `lumora://project/${genId('p')}`,
        name: name ?? `${source.name} 副本`,
        createdAt: new Date().toISOString(),
        revision: 0,
      };
      const fingerprint = stableStringify(copy);
      const result = await this.save(copy, null);
      if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
      const reloaded = await this.load(copy.uri);
      if (!reloaded.ok) {
        return {
          ok: false,
          code: 'storage-error',
          message: `复制成功但副本无法加载验证（${reloaded.message}），${await this.cleanupCopy(copy.uri, fingerprint)}`,
        };
      }
      const loadedCopy = reloaded.project;
      if (!loadedCopy || validateProjectSchema(loadedCopy) || validateProjectStructure(loadedCopy)) {
        return {
          ok: false,
          code: 'storage-error',
          message: `复制成功但副本无法通过加载校验，${await this.cleanupCopy(copy.uri, fingerprint)}`,
        };
      }
      return {
        ok: true,
        summary: {
          uri: copy.uri,
          name: copy.name,
          savedAt: new Date().toISOString(),
          revision: 0,
          schemaVersion: copy.schemaVersion,
        },
        fingerprint,
      };
    } catch (error) {
      // 克隆/指纹/清理等意外 reject：如实返回类型化失败（副本残留时如实呈现，
      // 不声称已清理）
      return { ok: false, code: 'storage-error', message: `复制失败：${failureMessage(error)}` };
    }
  }

  /** 清理复制失败留下的副本（CAS，第十四轮严重 4 + 第十五轮一般 7 四态）：仅当
   *  记录内容指纹与创建时一致才删除（另一标签页已打开并保存的更新后记录保留）；
   *  仅在删除落定后声称「已清理」，任何失败如实说明副本保留（可手动删除），
   *  绝不掩盖清理失败（第九轮 #5）；记录已不存在（missing）时清理后置条件已
   *  满足，不声称「已保留」。 */
  private async cleanupCopy(uri: string, expectedFingerprint: string | null): Promise<string> {
    const outcome = await this.removeIfUnchanged(uri, expectedFingerprint);
    if (outcome.ok && outcome.outcome !== 'changed') return '已清理并取消复制';
    if (outcome.ok) return '副本记录已变化（可能已被其他会话保存），已保留该记录，可手动删除';
    return `副本清理失败（${outcome.message}），副本记录保留，可手动删除`;
  }

  /** 关闭连接（幂等；OPFS 无连接语义，应用卸载前调用以对齐接口）。 */
  close(): void {
    // OPFS 句柄不持有连接：无需释放
  }

  /** 互斥临界区：Web Locks 优先（跨标签页），不可用退化进程内互斥（同标签页） */
  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const name = `lumora-opfs:${this.dbName}`;
    const locks = lockManager();
    if (locks) return locks.request(name, task);
    return withFallbackLock(name, task);
  }

  /**
   * 读取记录：文件缺失返回 undefined；损坏返回 null；合法记录原样返回
   * StoredProject（raw/source schema 保留，不提前迁移 —— 迁移由统一 facade
   * （loadProject）完成 migrate → validate → CAS 写回，第七轮 #6）。
   * 损坏判定为版本感知深度校验（第六轮一般项 + 第七轮 #8）：
   * - 记录形状通过后，校验文件名与记录 uri 严格绑定（name === projectFileName(uri)，
   *   错位文件名记录视为损坏，不得进入最近列表或 load 结果）；
   * - 当前版本记录做完整 schema + 图结构校验；
   * - 旧版本记录先迁移到当前版本，对迁移结果做完整校验（可迁移 + 迁移结果合法），
   *   raw 本身原样返回；
   * - 未来版本（schemaVersion > 当前）不做猜测校验、不折叠成 null —— 原样返回，
   *   facade 的迁移失败自然产生与 IndexedDB 一致的升级提示。
   * 缺 settings/scenes/objects/tracks/assets 或图关系损坏的记录不得被
   * list/load/rename/duplicate 使用（各自经 null 路径隔离，remove 可删除作为修复路径）。
   */
  private async readRecord(name: string): Promise<StoredProject | undefined | null> {
    let handle: OpfsFileHandle;
    try {
      handle = await this.projectsDir.getFileHandle(name);
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
    const file = await handle.getFile();
    const text = await file.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isStoredProjectRecord(parsed)) return null;
      if (name !== projectFileName(parsed.uri)) return null;
      const project = parsed.project;
      if (project.schemaVersion < CURRENT_PROJECT_SCHEMA_VERSION) {
        const migrated = migrateProjectSchema(project);
        if (!migrated.ok) return null;
        const migratedProject = migrated.project as Project;
        if (validateProjectSchema(migratedProject)) return null;
        if (validateProjectStructure(migratedProject)) return null;
      } else if (project.schemaVersion === CURRENT_PROJECT_SCHEMA_VERSION) {
        if (validateProjectSchema(project)) return null;
        if (validateProjectStructure(project)) return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 原子写入：临时文件落盘后 move 覆盖目标名；任一步失败旧记录保持原样。
   * move 能力缺失或方法存在但抛 NotSupportedError（受限环境，能力探测，
   * 第六轮一般项）时退化为直接写目标文件 —— 非原子降级，中断可能留下半写
   * 记录，readRecord 的深度校验会将其视为损坏（list 跳过、load 视为缺失、
   * 可删除重试），绝不把半写数据当合法记录用。
   */
  private async writeRecord(name: string, record: StoredProject): Promise<void> {
    const text = JSON.stringify(record);
    const tmpName = `.${name}.tmp`;
    const tmp = await this.projectsDir.getFileHandle(tmpName, { create: true });
    if (typeof tmp.move !== 'function') {
      // 非原子降级路径：清理刚创建的临时文件后直接写目标
      await this.cleanupTmp(tmpName);
      await this.directWrite(name, text);
      return;
    }
    const writable = await tmp.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (error) {
      // 写入失败：尽力清理临时文件后上抛（旧记录未被触碰）
      try {
        await writable.close();
      } catch {
        // 写入本身已失败，close 可能再次拒绝；忽略
      }
      await this.cleanupTmp(tmpName);
      throw error;
    }
    try {
      await tmp.move(this.projectsDir, name);
    } catch (error) {
      // 所有 move 失败路径都先尽力清理 .tmp（第七轮 #7，不留半写临时文件）；
      // 仅明确的能力错误（NotSupportedError）降级直接写，其余错误如实上抛
      await this.cleanupTmp(tmpName);
      if (!isNotSupportedError(error)) throw error;
      await this.directWrite(name, text);
    }
  }

  /** 尽力清理临时文件（move 缺失/失败路径；清理失败不掩盖原始错误） */
  private async cleanupTmp(tmpName: string): Promise<void> {
    try {
      await this.projectsDir.removeEntry(tmpName);
    } catch {
      // 清理失败不掩盖原始错误
    }
  }

  /** 直接写目标文件（move 缺失/不支持时的非原子降级路径，见 writeRecord） */
  private async directWrite(name: string, text: string): Promise<void> {
    const direct = await this.projectsDir.getFileHandle(name, { create: true });
    const directWritable = await direct.createWritable();
    try {
      await directWritable.write(text);
      await directWritable.close();
    } catch (error) {
      try {
        await directWritable.close();
      } catch {
        // 写入本身已失败，close 可能再次拒绝；忽略
      }
      throw error;
    }
  }
}
