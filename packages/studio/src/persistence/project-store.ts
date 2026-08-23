/**
 * 项目本地存储（FR-011）：IndexedDB 适配器。
 *
 * 存储结构：
 * - `projects` 对象仓库：keyPath uri，记录 { uri, savedAt, project }（项目名以
 *   project.name 为唯一来源，不单独冗余，避免重命名/撤销后的摘要漂移）；
 * - `meta` 对象仓库：预留键值位（keyPath key）。
 *
 * 并发安全（NFR-003 / AC2）：save(project, expectedStoredRevision) 在同一
 * readwrite 事务内完成「读已存 → 比对期望基线 → 写入」，提交前等待事务
 * complete（而非仅请求成功），杜绝「声称已保存但事务未提交」的假成功。
 * 语义（CAS 基线 / 创建语义 / 无条件写入 / 防倒退 / 防分叉）见 project-storage.ts 文件头。
 * 配额不足（QuotaExceededError）同样以可操作错误返回，调用方（自动保存）保持脏状态。
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
import { failureMessage, findJsonEncodingProblem, isMigrationWriteback, isQuotaError, sameProjectContent } from './project-storage';

export const PROJECT_STORE_DB = 'lumora-studio';
export const PROJECTS_STORE = 'projects';
export const META_STORE = 'meta';

const STORE_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 等待事务提交完成：请求成功 ≠ 事务已提交，save 必须以此为完成边界 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务中止'));
  });
}

export class ProjectStore implements ProjectStorage {
  readonly kind = 'indexeddb' as const;

  private constructor(
    private readonly db: IDBDatabase,
    readonly dbName: string,
  ) {}

  /** 创建存储；IndexedDB 不可用或打开失败时返回 null（持久化静默降级） */
  static async create(dbName = PROJECT_STORE_DB): Promise<ProjectStore | null> {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, STORE_VERSION);
        open.onupgradeneeded = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
            database.createObjectStore(PROJECTS_STORE, { keyPath: 'uri' });
          }
          if (!database.objectStoreNames.contains(META_STORE)) {
            database.createObjectStore(META_STORE, { keyPath: 'key' });
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error ?? new Error(`无法打开本地数据库 ${dbName}`));
        open.onblocked = () => reject(new Error(`本地数据库 ${dbName} 被其他标签页占用`));
      });
      return new ProjectStore(db, dbName);
    } catch {
      return null;
    }
  }

  /** 删除数据库（测试隔离 / 清空本地数据）。 */
  static async drop(dbName = PROJECT_STORE_DB): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    await new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase(dbName);
      del.onsuccess = () => resolve();
      del.onerror = () => resolve();
      del.onblocked = () => resolve();
    });
  }

  /** 最近项目列表（按保存时间倒序）。 */
  async list(): Promise<ProjectSummary[]> {
    const records = await request(this.db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).getAll() as IDBRequest<StoredProject[]>);
    return records
      .map((record) => ({
        uri: record.uri,
        name: record.project.name,
        savedAt: record.savedAt,
        revision: record.project.revision,
        schemaVersion: record.project.schemaVersion,
      }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  }

  /** 加载项目（返回调用方可自由修改的副本）。 */
  async load(uri: string): Promise<Project | null> {
    const record = await request(
      this.db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(uri) as IDBRequest<StoredProject | undefined>,
    );
    return record?.project ? structuredClone(record.project) : null;
  }

  /**
   * 保存项目（CAS，NFR-003 / AC2）：
   * - expectedStoredRevision 为 number：已存 revision 必须与期望基线一致才写入；
   * - null：创建语义（同 uri 已有记录即冲突）；
   * - undefined：无条件写入。
   * 读-比-写与提交在同一 readwrite 事务内，且以事务 complete 为完成边界。
   */
  async save(project: Project, expectedStoredRevision?: number | null): Promise<SaveOutcome> {
    // 事务前 JSON 可编码性预检：与 OPFS 后端（JSON 文件）契约一致 —— 循环引用/
    // BigInt 会让 JSON 序列化抛错、undefined/非有限数值会静默丢字段或失真，
    // IndexedDB 的 structuredClone 却能原样保存 → 两后端落盘内容不一致（第五轮 #8）
    const encodingProblem = findJsonEncodingProblem(project);
    if (encodingProblem) {
      return {
        ok: false,
        code: 'storage-error',
        message: `项目包含无法本地保存的数据（${encodingProblem}），保存被拒绝`,
      };
    }
    const transaction = this.db.transaction(PROJECTS_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECTS_STORE);
    try {
      const existing = await request(store.get(project.uri) as IDBRequest<StoredProject | undefined>);
      const storedRevision = existing?.project.revision;
      const mismatch =
        expectedStoredRevision === null
          ? existing !== undefined
          : typeof expectedStoredRevision === 'number' && storedRevision !== expectedStoredRevision;
      if (mismatch) {
        // 事务未做任何写入，自动提交；不提供自动恢复路径（冲突须显式解决）
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
        if (project.schemaVersion < existing.project.schemaVersion) {
          return {
            ok: false,
            code: 'schema-downgrade',
            message: `不能以旧 schema 版本（${project.schemaVersion}）覆盖较新记录（${existing.project.schemaVersion}），未写入`,
            storedRevision: existing.project.revision,
          };
        }
        if (project.revision < existing.project.revision) {
          return {
            ok: false,
            code: 'revision-conflict',
            message: `不能以旧 revision（${project.revision}）覆盖较新记录（${existing.project.revision}），未写入`,
            storedRevision: existing.project.revision,
          };
        }
        // 分叉保护（第七轮 #5）：同 revision 内容不同一律拒绝 —— 唯一豁免是
        // isMigrationWriteback（incoming 精确等于 migrateProjectSchema(existing)
        // 的确定性结果，facade loadProject 的迁移写回）；任意 v3/rev7 divergent
        // 覆盖 v2/rev7 baseline 的场景因此被拒。revision CAS 仍生效，并发更新
        // 依旧被拦截。
        if (
          project.revision === existing.project.revision &&
          !sameProjectContent(project, existing.project) &&
          !isMigrationWriteback(project, existing.project)
        ) {
          return {
            ok: false,
            code: 'revision-conflict',
            message: `同 revision（${project.revision}）但内容不同的记录已存在（分叉），未覆盖`,
            storedRevision: existing.project.revision,
          };
        }
      }
      const record: StoredProject = {
        uri: project.uri,
        savedAt: new Date().toISOString(),
        project: structuredClone(project),
      };
      await request(store.put(record) as IDBRequest<IDBValidKey>);
      await transactionDone(transaction);
      return { ok: true };
    } catch (error) {
      if (isQuotaError(error)) {
        return { ok: false, code: 'quota-exceeded', message: '本地存储空间不足，保存失败' };
      }
      return { ok: false, code: 'storage-error', message: `保存失败：${failureMessage(error)}` };
    }
  }

  /** 删除项目；返回是否真的存在并删除。 */
  async remove(uri: string): Promise<boolean> {
    const transaction = this.db.transaction(PROJECTS_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECTS_STORE);
    const existing = await request(store.get(uri) as IDBRequest<StoredProject | undefined>);
    if (!existing) return false;
    await request(store.delete(uri) as IDBRequest<undefined>);
    return true;
  }

  /** 直接重命名已存储项目（仅适用于未打开的项目；打开中的重命名走编辑器提交）。
   *  以加载到的 revision 为 CAS 期望：读-改-写间被其他写入推进时拒绝，防倒退。 */
  async rename(uri: string, name: string): Promise<RenameOutcome> {
    const project = await this.load(uri);
    if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
    const result = await this.save({ ...project, name, revision: project.revision + 1 }, project.revision);
    if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
    return { ok: true };
  }

  /** 复制项目：新 uri + 名称（缺省「原名 副本」）+ 重置 revision/createdAt。
   *  新 uri 首存走创建语义（null），防与并发创建的碰撞。 */
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

  /** 关闭连接（幂等；应用卸载前调用）。 */
  close(): void {
    this.db.close();
  }
}
