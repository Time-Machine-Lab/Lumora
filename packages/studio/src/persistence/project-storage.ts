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
 * 配额不足（QuotaExceededError）同样以可操作错误返回，调用方（自动保存）保持脏状态。
 */

import type { Project } from '@lumora/core';

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
  // autosaver 锁存态：恢复快照待处理（flush/排空与打开屏障同样阻断，见 autosave.flush）
  | 'recovery-available';

export type SaveOutcome =
  | { ok: true }
  | { ok: false; code: SaveFailureCode; message: string; storedRevision?: number };

export type DuplicateOutcome =
  | { ok: true; summary: ProjectSummary }
  | { ok: false; code: 'not-found' | 'storage-error'; message: string };

export type RenameOutcome =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'storage-error'; message: string };

/** 项目本地存储适配器：IndexedDB（ProjectStore）与 OPFS（OpfsProjectStore）的共同契约 */
export interface ProjectStorage {
  readonly kind: StorageBackend;
  /** 最近项目列表（按保存时间倒序）。 */
  list(): Promise<ProjectSummary[]>;
  /** 加载项目（返回调用方可自由修改的副本）。 */
  load(uri: string): Promise<Project | null>;
  /** 保存项目（CAS，见文件头语义）；失败返回类型化错误，绝不静默覆盖较新内容。 */
  save(project: Project, expectedStoredRevision?: number | null): Promise<SaveOutcome>;
  /** 删除项目；返回是否真的存在并删除。 */
  remove(uri: string): Promise<boolean>;
  /** 直接重命名已存储项目（仅适用于未打开的项目）；失败返回类型化错误。 */
  rename(uri: string, name: string): Promise<RenameOutcome>;
  /** 复制项目：新 uri + 名称（缺省「原名 副本」）+ 重置 revision/createdAt。 */
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

/** 键排序稳定序列化：同 revision 分叉判定需要与键序无关的内容比较 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.keys(item as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (item as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return item;
  });
}

/** 同 revision 幂等重存判定：内容逐字段一致（仅 savedAt 等记录字段可漂移） */
export function sameProjectContent(a: Project, b: Project): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function isQuotaError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
