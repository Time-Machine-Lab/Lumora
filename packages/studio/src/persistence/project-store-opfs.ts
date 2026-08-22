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
import { genId } from '@lumora/core';
import type {
  DuplicateOutcome,
  ProjectStorage,
  ProjectSummary,
  RenameOutcome,
  SaveOutcome,
  StoredProject,
} from './project-storage';
import { failureMessage, findJsonEncodingProblem, isQuotaError, sameProjectContent } from './project-storage';

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
  const chain = previous.then(() => gate);
  fallbackChains.set(name, chain);
  return previous.then(async () => {
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
   */
  static async create(dbName = OPFS_STORE_DIR, fs?: OpfsDirectoryHandle): Promise<OpfsProjectStore | null> {
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

  /** 最近项目列表（按保存时间倒序；跳过损坏记录与临时文件）。 */
  async list(): Promise<ProjectSummary[]> {
    return this.withLock(async () => {
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
      return summaries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    });
  }

  /** 加载项目（返回调用方可自由修改的副本；损坏记录视为缺失）。 */
  async load(uri: string): Promise<Project | null> {
    return this.withLock(async () => {
      const record = await this.readRecord(projectFileName(uri));
      if (!record) return null;
      return record.project ? structuredClone(record.project) : null;
    });
  }

  /**
   * 保存项目（CAS，NFR-003 / AC2；语义与 ProjectStore 完全一致）：
   * 互斥临界区内读-比-写，写入以「临时文件 + move 覆盖」原子替换旧记录，
   * 提交边界 = writable.close()（落盘）。
   */
  async save(project: Project, expectedStoredRevision?: number | null): Promise<SaveOutcome> {
    // 写入前 JSON 可编码性预检：与 IndexedDB 后端契约一致（第五轮 #8）——
    // OPFS 以 JSON 文本落盘，循环引用/BigInt 会抛错、undefined/非有限数值会静默
    // 失真；两后端对同一数据必须有一致的接受/拒绝语义
    const encodingProblem = findJsonEncodingProblem(project);
    if (encodingProblem) {
      return {
        ok: false,
        code: 'storage-error',
        message: `项目包含无法本地保存的数据（${encodingProblem}），保存被拒绝`,
      };
    }
    return this.withLock(async () => {
      const name = projectFileName(project.uri);
      try {
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
          if (project.revision < existing.project.revision) {
            return {
              ok: false,
              code: 'revision-conflict',
              message: `不能以旧 revision（${project.revision}）覆盖较新记录（${existing.project.revision}），未写入`,
              storedRevision: existing.project.revision,
            };
          }
          // 分叉保护豁免 schema 升级写回（loadProject 迁移：同 revision 内容随
          // schema 版本合法变化）；revision CAS 仍生效，并发更新依旧被拦截
          if (
            project.revision === existing.project.revision &&
            existing.project.schemaVersion === project.schemaVersion &&
            !sameProjectContent(project, existing.project)
          ) {
            return {
              ok: false,
              code: 'revision-conflict',
              message: `同 revision（${project.revision}）但内容不同的记录已存在（分叉），未覆盖`,
              storedRevision: existing.project.revision,
            };
          }
        }
        await this.writeRecord(name, {
          uri: project.uri,
          savedAt: new Date().toISOString(),
          project: structuredClone(project),
        });
        return { ok: true };
      } catch (error) {
        if (isQuotaError(error)) {
          return { ok: false, code: 'quota-exceeded', message: '本地存储空间不足，保存失败' };
        }
        return { ok: false, code: 'storage-error', message: `保存失败：${failureMessage(error)}` };
      }
    });
  }

  /** 删除项目；返回是否真的存在并删除（损坏记录同样可删除，作为修复路径）。 */
  async remove(uri: string): Promise<boolean> {
    return this.withLock(async () => {
      const name = projectFileName(uri);
      const record = await this.readRecord(name);
      if (record === undefined) return false;
      await this.projectsDir.removeEntry(name);
      return true;
    });
  }

  /** 直接重命名已存储项目（仅适用于未打开的项目）；语义与 ProjectStore 一致。 */
  async rename(uri: string, name: string): Promise<RenameOutcome> {
    const project = await this.load(uri);
    if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
    const result = await this.save({ ...project, name, revision: project.revision + 1 }, project.revision);
    if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
    return { ok: true };
  }

  /** 复制项目：新 uri + 名称（缺省「原名 副本」）+ 重置 revision/createdAt；语义与 ProjectStore 一致。 */
  async duplicate(uri: string, name?: string): Promise<DuplicateOutcome> {
    const project = await this.load(uri);
    if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
    const copy: Project = {
      ...structuredClone(project),
      uri: `lumora://project/${genId('p')}`,
      name: name ?? `${project.name} 副本`,
      createdAt: new Date().toISOString(),
      revision: 0,
    };
    const result = await this.save(copy, null);
    if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
    return {
      ok: true,
      summary: {
        uri: copy.uri,
        name: copy.name,
        savedAt: new Date().toISOString(),
        revision: 0,
        schemaVersion: copy.schemaVersion,
      },
    };
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
   * 读取记录：文件缺失返回 undefined；损坏（无法解析或结构校验失败）返回 null；
   * 合法记录返回 StoredProject。个体损坏可隔离：load 视为缺失、list 跳过、
   * save 拒绝覆盖、remove 可删除（用户的修复路径）。
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
      return isStoredProjectRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 原子写入：临时文件落盘后 move 覆盖目标名；任一步失败旧记录保持原样。
   * move 能力缺失（受限环境，能力探测）时退化为直接写目标文件 —— 非原子降级，
   * 中断可能留下半写记录，readRecord 的结构校验会将其视为损坏（list 跳过、
   * load 视为缺失、可删除重试），绝不把半写数据当合法记录用。
   */
  private async writeRecord(name: string, record: StoredProject): Promise<void> {
    const text = JSON.stringify(record);
    const tmpName = `.${name}.tmp`;
    const tmp = await this.projectsDir.getFileHandle(tmpName, { create: true });
    if (typeof tmp.move !== 'function') {
      // 非原子降级路径：不创建临时文件（上一行已创建，先清理），直接写目标
      try {
        await this.projectsDir.removeEntry(tmpName);
      } catch {
        // 清理失败不掩盖写入
      }
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
      try {
        await this.projectsDir.removeEntry(tmpName);
      } catch {
        // 清理失败不掩盖原始错误
      }
      throw error;
    }
    await tmp.move(this.projectsDir, name);
  }
}
