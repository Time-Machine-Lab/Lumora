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
  RemoveIfOutcome,
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
import { validateProjectSchema, validateProjectStructure } from '@lumora/core';

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
    // 反射级 JSON 预检必须先于任何克隆（第九轮 #2，PM 复核属实）：structuredClone
    // 会删除 Symbol 键与不可枚举属性、物化访问器 —— 先克隆再检查，原输入中的
    // 这些结构在克隆结果里已不可见，检查形同虚设：IDB 重载后字段静默丢失而
    // save 仍返回 { ok: true }。预检作用于原输入本身（getter 属性经描述符
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
    const transaction = this.db.transaction(PROJECTS_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECTS_STORE);
    try {
      const existing = await request(store.get(snapshot.uri) as IDBRequest<StoredProject | undefined>);
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
        // 分叉保护（第七轮 #5）：同 revision 内容不同一律拒绝 —— 唯一豁免是
        // isMigrationWriteback（incoming 精确等于 migrateProjectSchema(existing)
        // 的确定性结果，facade loadProject 的迁移写回）；任意 v3/rev7 divergent
        // 覆盖 v2/rev7 baseline 的场景因此被拒。revision CAS 仍生效，并发更新
        // 依旧被拦截。
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
      const record: StoredProject = {
        uri: snapshot.uri,
        savedAt: new Date().toISOString(),
        project: snapshot,
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

  /** 删除项目；返回是否真的存在并删除。以事务提交为删除完成边界（第九轮 #5）：
   *  请求成功 ≠ 事务已提交 —— 调用方（复制清理）仅在事务提交后才有权声称
   *  「已清理」；事务中止/出错时如实拒绝（抛错），绝不在删除未落定时报成功。 */
  async remove(uri: string): Promise<boolean> {
    const transaction = this.db.transaction(PROJECTS_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECTS_STORE);
    const existing = await request(store.get(uri) as IDBRequest<StoredProject | undefined>);
    if (!existing) return false;
    await request(store.delete(uri) as IDBRequest<undefined>);
    await transactionDone(transaction);
    return true;
  }

  /** 条件删除（第十四轮严重 4）：读-比-删与提交在同一 readwrite 事务内 ——
   *  副本验证失败后的清理不得误删另一标签页已打开并保存的更新后合法记录；
   *  内容指纹一致才删除，已变化/不存在时保留（removed:false），存储故障返回
   *  类型化失败（记录可能残留）。 */
  async removeIfUnchanged(uri: string, expectedFingerprint: string | null): Promise<RemoveIfOutcome> {
    const transaction = this.db.transaction(PROJECTS_STORE, 'readwrite');
    const store = transaction.objectStore(PROJECTS_STORE);
    try {
      const existing = await request(store.get(uri) as IDBRequest<StoredProject | undefined>);
      if (!existing) return { ok: true, removed: false };
      if (stableStringify(existing.project) !== expectedFingerprint) return { ok: true, removed: false };
      await request(store.delete(uri) as IDBRequest<undefined>);
      await transactionDone(transaction);
      return { ok: true, removed: true };
    } catch (error) {
      return { ok: false, message: `副本清理失败：${failureMessage(error)}` };
    }
  }

  /** 直接重命名已存储项目（仅适用于未打开的项目；打开中的重命名走编辑器提交）。
   *  写前先迁移/校验（第八轮 #4：未来 schema 拒绝写前变更）；以迁移后的 revision
   *  为 CAS 期望：读-改-写间被其他写入推进时拒绝，防倒退。 */
  async rename(uri: string, name: string): Promise<RenameOutcome> {
    const project = await this.load(uri);
    if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
    const prepared = prepareWriteChange(project, 'rename');
    if (!prepared.ok) return prepared;
    const renamed = { ...prepared.project, name, revision: prepared.project.revision + 1 };
    const result = await this.save(renamed, prepared.project.revision);
    if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
    return { ok: true };
  }

  /** 复制项目：新 uri + 名称（缺省「原名 副本」）+ 重置 revision/createdAt。
   *  写前先迁移/校验（第八轮 #4）；新 uri 首存走创建语义（null），防与并发创建的碰撞；
   *  保存成功后验证副本可加载，失败清理副本并报错（不留下不可用的半成品复制）。
   *  复制后验证/清理纳入异常安全类型化流程（第九轮 #5）：验证读取抛错、清理
   *  失败都如实返回，绝不遗留「半成品副本」假象；清理为 CAS（第十四轮严重 4）：
   *  仅当记录内容指纹与创建时一致才删除 —— 验证挂起期间另一标签页已打开并
   *  保存副本时，更新后的合法记录保留。 */
  async duplicate(uri: string, name?: string): Promise<DuplicateOutcome> {
    const project = await this.load(uri);
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
    let loaded: Project | null;
    try {
      loaded = await this.load(copy.uri);
    } catch (error) {
      return {
        ok: false,
        code: 'storage-error',
        message: `复制成功但副本无法加载验证（${failureMessage(error)}），${await this.cleanupCopy(copy.uri, fingerprint)}`,
      };
    }
    if (!loaded || validateProjectSchema(loaded) || validateProjectStructure(loaded)) {
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
  }

  /** 清理复制失败留下的副本（CAS，第十四轮严重 4）：仅当记录内容指纹与创建时
   *  一致才删除（另一标签页已打开并保存的更新后记录保留）；仅在删除事务提交后
   *  声称「已清理」，任何失败如实说明副本保留（可手动删除），绝不掩盖清理失败
   *  （第九轮 #5）。 */
  private async cleanupCopy(uri: string, expectedFingerprint: string | null): Promise<string> {
    const outcome = await this.removeIfUnchanged(uri, expectedFingerprint);
    if (outcome.ok && outcome.removed) return '已清理并取消复制';
    if (outcome.ok) return '副本记录已变化（可能已被其他会话保存），已保留该记录，可手动删除';
    return `副本清理失败（${outcome.message}），副本记录保留，可手动删除`;
  }

  /** 关闭连接（幂等；应用卸载前调用）。 */
  close(): void {
    this.db.close();
  }
}
