/**
 * 项目本地存储（FR-011）：IndexedDB 与 OPFS 两个适配器共享的类型与工具。
 *
 * 两个适配器以同一套并发安全语义（NFR-003 / AC2）实现 ProjectStorage：
 * save(project, expectedStoredRevision) 在同一互斥临界区内完成
 * 「读已存 → 比对期望基线 → 写入」：
 * - expectedStoredRevision 为 number 时是 CAS：已存 revision 必须与期望基线
 *   一致才写入。调用方以「上次确认已存的 revision」为期望，任何不一致（更新
 *   或缺失）都判定冲突，绝不静默覆盖 —— 多标签页下的较新保存不得被旧数据覆盖；
 * - null 为创建语义：同 uri 已有记录即冲突（新建/复制项目的首存防碰撞）；
 * - undefined 为无条件写入（显式迁移/测试等不受 CAS 约束的场景）。
 * 冲突不提供自动恢复路径：必须由用户显式解决（加载较新版本 / 另存副本），
 * 防止「本地计数追平后覆盖较新内容」的数据丢失。
 * 同 revision 分叉保护豁免 schema 升级写回（loadProject 的 v2→v3 迁移：
 * 迁移后内容随 schema 版本合法变化，无法与原记录逐字段一致）；revision
 * CAS 对并发更新仍然生效。
 * 配额不足（QuotaExceededError）同样以可操作错误返回，调用方（自动保存）保持脏状态。
 */

import type { Project } from '@lumora/core';
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  findJsonEncodingProblem,
  migrateProjectSchema,
  validateProjectSchema,
  validateProjectStructure,
} from '@lumora/core';
import type { JsonEncodingProblem } from '@lumora/core';

// JSON 可编码性判定由 core 唯一负责（第六轮 #5：严格 JSON-value 校验/规范化边界，
// 存储两后端与工程包共用同一函数）；此处 re-export 保持既有导入面不变。
export { findJsonEncodingProblem };
export type { JsonEncodingProblem };

/** 本地存储后端：IndexedDB（默认）或 OPFS（Origin Private File System） */
export type StorageBackend = 'indexeddb' | 'opfs';

export interface ProjectSummary {
  uri: string;
  name: string;
  savedAt: string;
  revision: number;
  schemaVersion: number;
}

export interface StoredProject {
  uri: string;
  savedAt: string;
  project: Project;
}

export type SaveFailureCode =
  | 'revision-conflict'
  | 'quota-exceeded'
  | 'storage-error'
  // 以旧 schema 版本覆盖较新记录（第六轮 #6：拒绝 schema 降级）
  | 'schema-downgrade'
  // autosaver 锁存态：恢复快照待处理（flush/排空与打开屏障同样阻断，见 autosave.flush）
  | 'recovery-available';

export type SaveOutcome =
  // 第三十三轮阻断 2：终态 commit 为 best-effort 收敛 —— ok:true 分支允许携带
  // 可选 message（终态释放部分失败明细归档；调用方可安全卸载，失败不阻断终态）
  | { ok: true; message?: string }
  | { ok: false; code: SaveFailureCode; message: string; storedRevision?: number };

export type DuplicateOutcome =
  | { ok: true; summary: ProjectSummary; fingerprint: string }
  | { ok: false; code: 'not-found' | 'storage-error'; message: string };

/** 条件删除结果（第十四轮严重 4 CAS + 第十五轮一般 7 四态）：副本验证失败后
 *  的清理必须 CAS —— 不得误删另一标签页已打开并保存的更新后合法记录；结果按
 *  态区分，调用方（UI）不得把「记录已不存在」误报为「记录已变化、已保留」。
 *  - outcome: 'removed' = 记录存在且内容指纹与期望一致，已删除；
 *  - outcome: 'missing' = 记录不存在 —— 清理后置条件已满足（可能已被其他
 *    会话删除），无需也不得声称「已保留」；
 *  - outcome: 'changed' = 记录存在但内容已变化（指纹不符）或无法验证指纹
 *    （损坏记录），保留；
 *  - ok: false = 存储故障（读/删/锁失败），记录可能残留。 */
export type RemoveIfOutcome =
  | { ok: true; outcome: 'removed' }
  | { ok: true; outcome: 'missing' }
  | { ok: true; outcome: 'changed' }
  | { ok: false; message: string };

export type RenameOutcome =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'storage-error'; message: string };

/** 最近项目列表结果（第十七轮严重 4：锁获取/读取失败一律类型化，绝不向上 reject） */
export type ListOutcome = { ok: true; items: ProjectSummary[] } | { ok: false; message: string };

/** 加载结果（第十七轮严重 4：锁获取/读取失败一律类型化，绝不向上 reject） */
export type LoadOutcome = { ok: true; project: Project | null } | { ok: false; message: string };

/** 删除结果（第十七轮严重 4：锁获取/删除失败一律类型化，绝不向上 reject） */
export type RemoveOutcome = { ok: true; removed: boolean } | { ok: false; message: string };

/** 项目本地存储适配器：IndexedDB（ProjectStore）与 OPFS（OpfsProjectStore）的共同契约。
 *  全部方法的存储/锁故障都以类型化结果返回（或通过调用方显式 catch 处理），
 *  不产生未处理的 reject（第十七轮严重 4）。 */
export interface ProjectStorage {
  readonly kind: StorageBackend;
  /** 最近项目列表（按保存时间倒序）；存储/锁故障返回类型化失败。 */
  list(): Promise<ListOutcome>;
  /** 加载项目（返回调用方可自由修改的副本）；存储/锁故障返回类型化失败。 */
  load(uri: string): Promise<LoadOutcome>;
  /** 保存项目（CAS，见文件头语义）；失败返回类型化错误，绝不静默覆盖较新内容。 */
  save(project: Project, expectedStoredRevision?: number | null): Promise<SaveOutcome>;
  /** 删除项目；返回是否真的存在并删除（removed）；存储/锁故障返回类型化失败。 */
  remove(uri: string): Promise<RemoveOutcome>;
  /** 条件删除（第十四轮严重 4）：仅当记录内容指纹与期望一致时删除（副本验证
   *  失败后的清理不得误删另一标签页已打开并保存的更新后合法记录）。
   *  实现与 save 同一原子边界：IndexedDB 在 readwrite 事务内读-比-删并以事务
   *  提交为完成边界；OPFS 在互斥锁内执行。 */
  removeIfUnchanged(uri: string, expectedFingerprint: string | null): Promise<RemoveIfOutcome>;
  /** 直接重命名已存储项目（仅适用于未打开的项目）；失败返回类型化错误。 */
  rename(uri: string, name: string): Promise<RenameOutcome>;
  /** 复制项目：新 uri + 名称（缺省「原名 副本」）+ 重置 revision/createdAt；
   *  返回副本内容指纹（调用方二次加载失败时的 CAS 清理依据）。 */
  duplicate(uri: string, name?: string): Promise<DuplicateOutcome>;
  /** 关闭连接（幂等；应用卸载前调用）。 */
  close(): void;
}

/** 浏览器存储配额估算（不可用时返回 null，调用方跳过配额预检；与具体后端无关） */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } } })
    .navigator?.storage;
  if (!storage?.estimate) return null;
  try {
    const estimate = await storage.estimate();
    if (typeof estimate.quota !== 'number') return null;
    return { usage: estimate.usage ?? 0, quota: estimate.quota };
  } catch {
    return null;
  }
}

/** 键排序稳定序列化：同 revision 分叉判定需要与键序无关的内容比较。
 *  累加器用 null 原型对象：普通对象字面量的 __proto__ 是原型 setter，
 *  以它为累加器会把名为 __proto__ 的字段静默丢弃（fork 检测绕过，第五轮 #6）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.keys(item as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (item as Record<string, unknown>)[key];
          return acc;
        }, Object.create(null));
    }
    return item;
  });
}

/**
 * 同 revision 幂等重存判定：内容逐字段一致（仅 savedAt 等记录字段可漂移）。
 * 任一方向不可 JSON 编码（undefined/NaN/BigInt/循环引用/数组非索引键）时
 * 无法可靠序列化比较，保守判为内容不同（分叉）—— 不可编码内容绝不因
 * JSON.stringify 丢字段/归一化而误判为与其它内容相同。
 */
export function sameProjectContent(a: Project, b: Project): boolean {
  if (findJsonEncodingProblem(a) || findJsonEncodingProblem(b)) return false;
  return stableStringify(a) === stableStringify(b);
}

/**
 * schema 升级写回豁免判定（第七轮 #5，两个适配器共用）：incoming 必须精确等于
 * migrateProjectSchema(existing) 的确定性结果才允许以同 revision 覆盖 —— 仅
 * schema 版本更高不足以免责，任意同 revision 分叉内容不得借「升级」覆盖旧记录
 * （v2/rev7 baseline 不得被任意 v3/rev7 divergent 覆盖）。facade 的 loadProject
 * 迁移写回（incoming 正是迁移结果本身）通过；其余内容一律按分叉拒绝。
 */
export function isMigrationWriteback(incoming: Project, existing: Project): boolean {
  if (incoming.schemaVersion <= existing.schemaVersion) return false;
  const migrated = migrateProjectSchema(existing);
  if (!migrated.ok) return false;
  return sameProjectContent(incoming, migrated.project as Project);
}

export type WriteChangePrepared =
  | { ok: true; project: Project }
  | { ok: false; code: 'not-found' | 'storage-error'; message: string };

/**
 * 未打开项目的写前变更管道（第八轮 #4，两个适配器共用）：rename/duplicate
 * 先迁移到当前 schema 再做完整校验，任何失败都拒绝写前变更 ——
 * - 未来版本（v > CURRENT）：migrateProjectSchema 返回 future-schema-version
 *   失败，拒绝重命名/复制（未来 schema 只允许列出/删除，与 facade loadProject
 *   的升级提示一致；不得在写前变更中被静默改写）；
 * - 旧版本：逐级迁移到当前版本，对迁移结果做完整校验（迁移结果必须合法）；
 * - 当前版本：完整校验。
 * 校验失败视为项目不可用（not-found，与损坏记录的处理一致）。
 * 变更（改名/复制字段）由调用方在返回的迁移后项目上应用再保存。
 */
export function prepareWriteChange(project: Project, action: 'rename' | 'duplicate'): WriteChangePrepared {
  let current: Project = project;
  if (project.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION) {
    const migrated = migrateProjectSchema(project);
    if (!migrated.ok) {
      return {
        ok: false,
        code: 'storage-error',
        message: `项目 schema 版本（${project.schemaVersion}）不支持${action === 'rename' ? '重命名' : '复制'}：${migrated.error.message}`,
      };
    }
    current = migrated.project as Project;
  }
  const schemaProblem = validateProjectSchema(current);
  if (schemaProblem) {
    return { ok: false, code: 'not-found', message: '项目记录已损坏，不可用' };
  }
  const structureProblem = validateProjectStructure(current);
  if (structureProblem) {
    return { ok: false, code: 'not-found', message: '项目记录已损坏，不可用' };
  }
  return { ok: true, project: current };
}

export function isQuotaError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
