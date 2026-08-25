/**
 * 版本化 Project schema 与 `.lumora` 工程包格式（MVP-3，TML-53）。
 *
 * 分层版本：
 * - project schemaVersion：项目数据本身的版本（当前 3），未知/未来版本一律拒绝并给出
 *   可操作错误（升级提示），旧版本经 migrate.ts 的迁移管道逐级升级；
 * - 包 formatVersion：`.lumora` 包容器版本（当前 1），与 schemaVersion 解耦——
 *   容器演进（目录结构、压缩、资产引用方式）不要求项目数据版本联动。
 *
 * 包结构（单文件 JSON，扩展名 .lumora）：
 * ```json
 * {
 *   "manifest": { "format": "lumora.project", "formatVersion": 1, ... },
 *   "project":  { ...Project，资产 payload/parts 已摘除，私有字段已剥离... },
 *   "assets":   { "<assetId>": { "payload": "base64", "parts": [...] } }
 * }
 * ```
 * 资产字节与项目元数据分离：project.json 保持轻量，二进制经 assets 段逐条回挂。
 * 单文件 JSON 是 MVP 容器（零依赖、任意浏览器可导入导出）；后续若引入 zip 目录
 * 容器，manifest.formatVersion 递增即可，manifest 字段保持兼容。
 */

import type { AssetPartData, Project } from '../scene/types';

/** 当前项目数据版本（types.ts 的 Project.schemaVersion 字面量与此保持一致） */
export const CURRENT_PROJECT_SCHEMA_VERSION = 4;

/** 包容器格式标识：manifest.format 必须精确匹配 */
export const PROJECT_PACKAGE_FORMAT = 'lumora.project';

/** 包容器版本：当前单文件 JSON 容器 */
export const PACKAGE_FORMAT_VERSION = 1;

/** 默认工程包排除的私有字段：随项目本地持久化、不随包迁移。
 *  pluginData 为插件私有设置，includePrivate 时允许包含（按插件声明剥离）；
 *  credentials/apiKeys/secrets/tokens 等凭据族顶层结构不属于 Project schema，
 *  由公开字段白名单结构性排除 —— 任何情况下不得写入工程包（NFR-008；第十一轮
 *  契约制：结构化隔离取代键名词表猜测）。 */
export const PRIVATE_PROJECT_FIELDS = [
  'pluginData',
  'credentials',
  'apiKeys',
  'apiKey',
  'secrets',
  'tokens',
] as const;

export type PrivateProjectField = (typeof PRIVATE_PROJECT_FIELDS)[number];

export interface PackageAppInfo {
  name: string;
  version: string;
}

export interface ProjectPackageManifest {
  /** 固定 'lumora.project' */
  format: typeof PROJECT_PACKAGE_FORMAT;
  formatVersion: number;
  /** 导出时刻（ISO 8601） */
  exportedAt: string;
  app: PackageAppInfo;
  project: {
    uri: string;
    name: string;
    schemaVersion: number;
    revision: number;
  };
  /** 包内资产条目数（project 引用的资产中有 payload 的条目） */
  assetCount: number;
  /** 导出时是否包含插件私有设置（默认 false） */
  includePrivate: boolean;
}

/** 包内单个资产的二进制载荷（project.json 中摘除的 payload/parts 原样回挂） */
export interface ProjectAssetPayload {
  payload?: string;
  parts?: AssetPartData[];
}

/** `.lumora` 工程包：manifest + 项目元数据 + 资产载荷 */
export interface ProjectPackage {
  manifest: ProjectPackageManifest;
  project: Project;
  assets: Record<string, ProjectAssetPayload>;
}

export const LUMORA_PACKAGE_EXTENSION = '.lumora';
