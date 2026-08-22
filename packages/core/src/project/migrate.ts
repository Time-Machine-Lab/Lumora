/**
 * Project schema 迁移管道（NFR-017）：运行时校验 + 迁移测试。
 *
 * 原则：
 * - schemaVersion 必填；缺失/非法直接拒绝（可操作错误）。
 * - 高于当前版本 → 拒绝并提示升级应用（未知未来数据不得猜测解释）。
 * - 低于当前版本 → 按注册的迁移逐级升级；中途版本缺失 → 拒绝（不可跳级猜测）。
 * - 迁移不可静默丢字段：每级迁移只做文档化的结构变换，输入中的未知字段
 *   保持透传（校验在迁移完成后统一执行，不在此处丢数据）。
 */

import { CURRENT_PROJECT_SCHEMA_VERSION } from './schema';

export type ProjectMigrationErrorKind =
  | 'missing-schema-version'
  | 'invalid-schema-version'
  | 'future-schema-version'
  | 'missing-intermediate-migration';

export interface ProjectMigrationError {
  kind: ProjectMigrationErrorKind;
  /** 面向用户的可操作错误描述 */
  message: string;
  /** 解析出的 schemaVersion（缺失时为 undefined） */
  schemaVersion?: unknown;
}

export type MigrateResult =
  | { ok: true; project: unknown; migratedFrom: number }
  | { ok: false; error: ProjectMigrationError };

/** 一级迁移：vFrom → vFrom+1。返回变换后的数据；抛错视为迁移失败。 */
export type ProjectMigration = (data: unknown) => unknown;

/**
 * 迁移注册表：键为源版本，目标恒为源版本 + 1。
 *
 * v1（历史草案格式，仅用于迁移管道测试与文档）：对象条目缺少 visible/locked
 * 字段（草案期的默认可见、未锁定），场景/资源结构与 v2 一致。迁移补默认值，
 * 不丢弃任何字段。生产数据从首个提交起即为 v2，v1 迁移不会被真实数据触发。
 *
 * v2 → v3：Project 新增 tracks（轨道）字段（v2 无轨道概念，此前以场景/层级
 * 引用替代）。迁移补默认空数组（TML-88）；v2 数据若已携带 tracks（手工构造），
 * 原样透传不丢弃，内容合法性由迁移后的统一校验裁决。
 */
const MIGRATIONS: Record<number, ProjectMigration> = {
  1: (data) => {
    const raw = data as { objects?: unknown };
    const objects = Array.isArray(raw.objects)
      ? raw.objects.map((object) => {
          if (!object || typeof object !== 'object') return object;
          const entry = object as Record<string, unknown>;
          return {
            ...entry,
            visible: typeof entry.visible === 'boolean' ? entry.visible : true,
            locked: typeof entry.locked === 'boolean' ? entry.locked : false,
          };
        })
      : raw.objects;
    return { ...(raw as Record<string, unknown>), schemaVersion: 2, objects };
  },
  2: (data) => {
    const raw = data as Record<string, unknown>;
    return {
      ...raw,
      schemaVersion: 3,
      tracks: Array.isArray(raw.tracks) ? raw.tracks : [],
    };
  },
};

/**
 * 解析输入中的 schemaVersion：缺失 → missing-schema-version；非法 → invalid。
 * 不在此处执行数值范围校验（未来版本与迁移决定由调用方处理）。
 */
export function readSchemaVersion(data: unknown): { version: number } | ProjectMigrationError {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'invalid-schema-version', message: '工程包内容不是有效的项目对象' };
  }
  const raw = (data as Record<string, unknown>).schemaVersion;
  if (raw === undefined) {
    return { kind: 'missing-schema-version', message: '项目缺少必填字段 schemaVersion，无法识别数据版本' };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return { kind: 'invalid-schema-version', message: `schemaVersion 非法（${String(raw)}）：必须是正整数` };
  }
  return { version: raw };
}

/**
 * 迁移管道入口：未知输入 → 逐级迁移到当前版本。
 * 成功返回 { ok: true, project, migratedFrom }（migratedFrom = 输入版本）。
 * 输入不是对象、版本缺失/非法/未来、迁移链缺失任一中间版本时返回可操作错误。
 */
export function migrateProjectSchema(data: unknown): MigrateResult {
  const version = readSchemaVersion(data);
  if ('version' in version) {
    if (version.version > CURRENT_PROJECT_SCHEMA_VERSION) {
      return {
        ok: false,
        error: {
          kind: 'future-schema-version',
          schemaVersion: version.version,
          message: `工程包由更新版本的 Lumora 创建（schemaVersion ${version.version}，当前支持 ${CURRENT_PROJECT_SCHEMA_VERSION}）。请升级应用后重新导入`,
        },
      };
    }
    if (version.version < CURRENT_PROJECT_SCHEMA_VERSION) {
      let cursor: unknown = data;
      for (let from = version.version; from < CURRENT_PROJECT_SCHEMA_VERSION; from += 1) {
        const migration = MIGRATIONS[from];
        if (!migration) {
          return {
            ok: false,
            error: {
              kind: 'missing-intermediate-migration',
              schemaVersion: version.version,
              message: `工程包 schemaVersion ${version.version} 到 ${CURRENT_PROJECT_SCHEMA_VERSION} 缺少迁移路径（${from} → ${from + 1} 未实现），无法导入`,
            },
          };
        }
        cursor = migration(cursor);
      }
      return { ok: true, project: cursor, migratedFrom: version.version };
    }
    return { ok: true, project: data, migratedFrom: version.version };
  }
  return { ok: false, error: version };
}
