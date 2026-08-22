/**
 * `.lumora` 工程包构建与解析（FR-011）：
 *
 * 导出 = 打包：project.json 按公开字段白名单构建（私有字段与运行时缓存引用剥离，
 *         扩展数据递归清除凭据族键）+ manifest + assets 载荷段。
 * 导入 = 解析：文本长度上限 → JSON → manifest 校验 → schema 迁移 → 载荷完整性校验
 *         （先于解码的长度上限 / 规范 base64 / size 精确核对 / 组合内容哈希 /
 *         资源上限）→ 载荷回挂 → 完整校验 → 缺失资产报告（warning 明细，不阻断）。
 * 任何校验失败都返回可操作错误明细，由调用方保证当前项目不被覆盖（失败回滚）。
 * 损坏载荷（非法 base64 / size 不符 / hash 不符 / 超限 / 空分件 / 未引用孤儿包）
 * 一律拒绝导入，绝不把损坏资产判为导入成功。
 */

import type { Project } from '../scene/types';
import { compositeContentHash, hashBytes } from '../scene/assets';
import { validateProjectSchema } from '../scene/validate';
import { migrateProjectSchema } from './migrate';
import { PACKAGE_FORMAT_VERSION, PROJECT_PACKAGE_FORMAT, CURRENT_PROJECT_SCHEMA_VERSION } from './schema';
import type { ProjectAssetPayload, ProjectPackage } from './schema';

export interface PackageBuildOptions {
  /** 是否包含插件私有设置（pluginData）。凭据族字段任何情况下都不包含（NFR-008）。 */
  includePrivate?: boolean;
  appName?: string;
  appVersion?: string;
  /** 可注入导出时刻（测试确定性）；缺省取当前时间 */
  exportedAt?: string;
}

export type PackageImportErrorCode =
  | 'not-json'
  | 'not-object'
  | 'invalid-manifest'
  | 'unsupported-format-version'
  | 'migration-failed'
  | 'invalid-project'
  | 'too-large';

export interface PackageImportError {
  code: PackageImportErrorCode;
  /** 面向用户的可操作错误描述 */
  message: string;
  /** 附加技术细节（如校验失败的字段路径） */
  detail?: string;
}

export interface MissingAssetWarning {
  assetId: string;
  name: string;
  reason: 'payload-missing';
}

export type PackageParseResult =
  | { ok: true; project: Project; warnings: MissingAssetWarning[]; migratedFrom: number }
  | { ok: false; error: PackageImportError };

/** 导入资源上限（防御性基准，超限一律拒绝，防止解码/结构攻击）：
 *  单资产解码字节、单包累计解码字节、外部分件数、资产数、对象数、层级深度。 */
export const MAX_ASSET_PAYLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_TOTAL_PAYLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_ASSET_PARTS = 512;
export const MAX_ASSETS_PER_PROJECT = 1000;
export const MAX_OBJECTS_PER_PROJECT = 50000;
export const MAX_SCENE_DEPTH = 256;

/** 包文本长度上限（字符数）：总载荷 base64 上限 + JSON 结构/字段开销余量。
 *  先于 JSON.parse 检查，防止超长文本解码攻击。 */
export const MAX_PACKAGE_TEXT_BYTES = Math.ceil((MAX_TOTAL_PAYLOAD_BYTES * 4) / 3) + 16 * 1024 * 1024;

/**
 * 先于解码的长度上限预检（base64 字符数 → 解码字节上界，base64 解码只减不增）。
 * 单资产字符上限与累计剩余预算任一超限即拒绝，防止超长文本进入 atob 解码。
 */
export function preDecodePayloadFailure(
  payloadLength: number,
  maxAssetBytes: number,
  maxTotalBytes: number,
  cumulativeBytes: number,
): string | null {
  if (payloadLength > Math.ceil((maxAssetBytes * 4) / 3)) {
    return `编码长度超过单资产上限（解码字节将超过 ${maxAssetBytes}）`;
  }
  if (Math.ceil((payloadLength * 3) / 4) > maxTotalBytes - cumulativeBytes) {
    return `载荷累计字节数超过上限（${maxTotalBytes}）`;
  }
  return null;
}

/** 导出时递归清除的凭据族键名（插件扩展数据可携带任意嵌套键） */
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|secret|password|credential|authorization|token)/i;

/** 工程包仅携带的公开项目字段（白名单：未知顶层字段一律不进包） */
const PUBLIC_PROJECT_FIELDS = [
  'uri',
  'name',
  'schemaVersion',
  'createdAt',
  'revision',
  'settings',
  'activeSceneId',
  'scenes',
  'objects',
  'assets',
] as const;

function failure(code: PackageImportErrorCode, message: string, detail?: string): PackageParseResult {
  return { ok: false, error: { code, message, detail } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 递归清除敏感键（凭据族，NFR-008）：命中敏感键名即删除整个子树。
 * 循环引用安全（visited 集）；仅用于导出克隆，不影响原始项目。
 */
export function stripSensitiveFields(value: unknown, visited = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stripSensitiveFields(item, visited);
    return;
  }
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      delete (value as Record<string, unknown>)[key];
    } else {
      stripSensitiveFields((value as Record<string, unknown>)[key], visited);
    }
  }
}

/**
 * 构建工程包：
 * - 白名单构建 project 段：仅公开字段进入包；pluginData 默认排除（includePrivate
 *   时保留）；凭据族键名（apiKey/token/secret/…）在任何嵌套深度递归清除
 *   （NFR-008：API Key 不写入工程包）；
 * - 资产字节从 project.json 摘出，按 assetId 挂入 assets 段；
 * - storageRef 为运行期缓存引用（object URL），跨环境不可重建，导出恒置空。
 */
export function buildProjectPackage(project: Project, options: PackageBuildOptions = {}): ProjectPackage {
  const includePrivate = options.includePrivate ?? false;
  const exportedAt = options.exportedAt ?? new Date().toISOString();

  // 深克隆后构造白名单字段（未知顶层字段一律丢弃），随后递归清除凭据族键
  const source = structuredClone(project) as unknown as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const field of PUBLIC_PROJECT_FIELDS) {
    if (source[field] !== undefined) stripped[field] = source[field];
  }
  if (includePrivate && source.pluginData !== undefined) stripped.pluginData = source.pluginData;
  stripSensitiveFields(stripped);

  const assets: Record<string, ProjectAssetPayload> = {};
  let assetCount = 0;
  const strippedAssets = Array.isArray(stripped.assets)
    ? (stripped.assets as Array<Record<string, unknown>>).map((asset) => {
        const payload = typeof asset.payload === 'string' ? asset.payload : undefined;
        const parts = Array.isArray(asset.parts) ? asset.parts : undefined;
        if (payload !== undefined || (parts !== undefined && parts.length > 0)) {
          assets[String(asset.id)] = {
            ...(payload !== undefined ? { payload } : {}),
            ...(parts !== undefined && parts.length > 0 ? { parts } : {}),
          };
          assetCount += 1;
        }
        const { payload: _payload, parts: _parts, storageRef: _storageRef, ...meta } = asset;
        return { ...meta, storageRef: '' };
      })
    : [];

  const packageProject = { ...stripped, assets: strippedAssets } as unknown as Project;

  return {
    manifest: {
      format: PROJECT_PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      exportedAt,
      app: { name: options.appName ?? 'Lumora Studio', version: options.appVersion ?? '0.1.0' },
      project: {
        uri: project.uri,
        name: project.name,
        schemaVersion: project.schemaVersion,
        revision: project.revision,
      },
      assetCount,
      includePrivate,
    },
    project: packageProject,
    assets,
  };
}

/** 序列化为 `.lumora` 单文件文本（UTF-8 JSON）。 */
export function serializeProjectPackage(pkg: ProjectPackage): string {
  return JSON.stringify(pkg, null, 2);
}

/** 包文本的字节量估算（UTF-16 两字节/字符，用于配额预估）。 */
export function estimatePackageBytes(text: string): number {
  return text.length * 2;
}

/** 规范 base64 校验：字符集 + 长度对齐 + 填充规范（解码再编码必须逐字节一致）。 */
function checkCanonicalBase64(payload: string): { ok: true; decoded: string; bytes: number } | { ok: false; reason: string } {
  if (payload.length === 0) return { ok: false, reason: '空载荷' };
  if (payload.length % 4 !== 0) return { ok: false, reason: 'base64 长度非 4 的倍数' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return { ok: false, reason: 'base64 含非法字符' };
  try {
    const decoded = atob(payload);
    if (btoa(decoded) !== payload) return { ok: false, reason: 'base64 填充不规范' };
    return { ok: true, decoded, bytes: decoded.length };
  } catch {
    return { ok: false, reason: 'base64 解码失败' };
  }
}

/** 二进制字符串 → 字节数组（atob 产物逐字符对应一字节，不可用 TextEncoder） */
function binaryStringToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 对象层级深度与环校验（导入上限）：沿 parentId 回溯，超深或成环即超限 */
function hasExcessiveHierarchy(objects: readonly unknown[]): boolean {
  const parents = new Map<string, string | null>();
  for (const object of objects) {
    if (!isPlainRecord(object) || typeof object.id !== 'string') continue;
    parents.set(object.id, typeof object.parentId === 'string' ? object.parentId : null);
  }
  for (const id of parents.keys()) {
    let cursor: string | null = id;
    let depth = 0;
    const path = new Set<string>();
    while (cursor !== null) {
      if (depth > MAX_SCENE_DEPTH || path.has(cursor)) return true;
      path.add(cursor);
      cursor = parents.get(cursor) ?? null;
      depth += 1;
    }
  }
  return false;
}

/**
 * 解析并校验 `.lumora` 工程包文本（失败时返回可操作错误，不产生任何副作用）。
 * 成功时返回恢复的 Project（含回挂载荷）与缺失资产明细。
 * 载荷完整性：先于解码的长度上限、规范 base64、size 精确核对（主载荷 + 分件）、
 * 组合内容哈希（与模型导入同一算法，任何环境不跳过）。
 */
export async function parseProjectPackage(text: string): Promise<PackageParseResult> {
  if (text.length > MAX_PACKAGE_TEXT_BYTES) {
    return failure(
      'too-large',
      `工程包文件过大（字符数 ${text.length} 超过上限 ${MAX_PACKAGE_TEXT_BYTES}），无法导入`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failure(
      'not-json',
      '文件不是有效的 JSON，无法解析为工程包',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isPlainRecord(parsed)) {
    return failure('not-object', '工程包内容不是对象，文件已损坏');
  }
  const manifest = parsed.manifest;
  if (!isPlainRecord(manifest)) {
    return failure('invalid-manifest', '工程包缺少 manifest，文件已损坏');
  }
  if (manifest.format !== PROJECT_PACKAGE_FORMAT) {
    return failure(
      'invalid-manifest',
      `不是 Lumora 工程包（manifest.format = ${JSON.stringify(manifest.format)}，期望 ${PROJECT_PACKAGE_FORMAT}）`,
    );
  }
  const formatVersion = manifest.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion <= 0) {
    return failure('invalid-manifest', `manifest.formatVersion 非法（${JSON.stringify(formatVersion)}）`);
  }
  if (formatVersion > PACKAGE_FORMAT_VERSION) {
    return failure(
      'unsupported-format-version',
      `工程包由更新版本的 Lumora 导出（格式版本 ${formatVersion}，当前支持 ${PACKAGE_FORMAT_VERSION}）。请升级应用后重新导入`,
    );
  }
  if (formatVersion < PACKAGE_FORMAT_VERSION) {
    return failure(
      'unsupported-format-version',
      `工程包格式版本过旧（${formatVersion}，当前 ${PACKAGE_FORMAT_VERSION}），无法导入`,
    );
  }
  const rawProject = parsed.project;
  if (!isPlainRecord(rawProject)) {
    return failure('invalid-project', '工程包缺少 project 段，文件已损坏');
  }
  const migrated = migrateProjectSchema(rawProject);
  if (!migrated.ok) {
    return failure('migration-failed', migrated.error.message);
  }
  const project = migrated.project as Record<string, unknown>;
  if (!isPlainRecord(project)) {
    return failure('invalid-project', '迁移后的项目数据不是对象');
  }

  // 资源上限：对象数 / 层级深度 / 资产数
  if (Array.isArray(project.objects) && project.objects.length > MAX_OBJECTS_PER_PROJECT) {
    return failure('too-large', `工程包对象数超过上限（${project.objects.length} > ${MAX_OBJECTS_PER_PROJECT}），无法导入`);
  }
  if (Array.isArray(project.objects) && hasExcessiveHierarchy(project.objects)) {
    return failure('too-large', `工程包对象层级超过上限（${MAX_SCENE_DEPTH} 层）或存在环，无法导入`);
  }
  if (Array.isArray(project.assets) && project.assets.length > MAX_ASSETS_PER_PROJECT) {
    return failure('too-large', `工程包资产数超过上限（${project.assets.length} > ${MAX_ASSETS_PER_PROJECT}），无法导入`);
  }

  // 载荷回挂：包内 assets 段按 assetId 恢复 payload/parts。
  // 缺失报告只针对被模型对象引用的资产（缺失即内容无法恢复）；未被引用的
  // 无载荷资产（URL 来源等可重建缓存）不产生噪音。
  const referencedAssetIds = new Set<string>();
  if (Array.isArray(project.objects)) {
    for (const object of project.objects) {
      if (isPlainRecord(object) && object.type === 'model' && typeof object.assetId === 'string') {
        referencedAssetIds.add(object.assetId);
      }
    }
  }
  const packageAssets = isPlainRecord(parsed.assets) ? parsed.assets : {};
  const warnings: MissingAssetWarning[] = [];
  const warnMissing = (assetId: string, name: string) => {
    if (referencedAssetIds.has(assetId)) {
      warnings.push({ assetId, name, reason: 'payload-missing' });
    }
  };

  // 载荷完整性校验（失败即拒绝，绝不把损坏资产判为导入成功）
  let cumulativePayloadBytes = 0;
  let integrityFailure: string | null = null;
  /** 哈希校验队列：解码完成后再统一验证（组合哈希 = 主载荷 + 分件） */
  const hashChecks: Array<{
    assetId: string;
    name: string;
    hash: string;
    main: string | null;
    parts: Array<{ path: string; decoded: string }>;
  }> = [];
  /** 已被项目资产条目认领的包内 bundle；认领集之外 = 未引用孤儿包，同样全量校验 */
  const claimedBundleIds = new Set<string>();

  const checkBundlePayload = (
    label: string,
    payload: unknown,
  ): { ok: true; decoded: string; bytes: number } | { ok: false; reason: string } => {
    if (typeof payload !== 'string') return { ok: false, reason: `${label} 非字符串` };
    // 先于解码的长度上限检查：base64 字符数换算的解码字节上界，超限直接拒绝（拒绝解码攻击）
    const pre = preDecodePayloadFailure(
      payload.length,
      MAX_ASSET_PAYLOAD_BYTES,
      MAX_TOTAL_PAYLOAD_BYTES,
      cumulativePayloadBytes,
    );
    if (pre) return { ok: false, reason: pre };
    const checked = checkCanonicalBase64(payload);
    if (!checked.ok) return { ok: false, reason: `${label} ${checked.reason}` };
    if (checked.bytes > MAX_ASSET_PAYLOAD_BYTES) {
      return { ok: false, reason: `${label} 解码字节数超过上限（${MAX_ASSET_PAYLOAD_BYTES}）` };
    }
    cumulativePayloadBytes += checked.bytes;
    if (cumulativePayloadBytes > MAX_TOTAL_PAYLOAD_BYTES) {
      return { ok: false, reason: `载荷累计字节数超过上限（${MAX_TOTAL_PAYLOAD_BYTES}）` };
    }
    return { ok: true, decoded: checked.decoded, bytes: checked.bytes };
  };

  const assets = Array.isArray(project.assets)
    ? project.assets.map((entry) => {
        if (!isPlainRecord(entry)) return entry;
        const rawBundle = packageAssets[String(entry.id)];
        const bundle = isPlainRecord(rawBundle) ? rawBundle : null;
        if (bundle) claimedBundleIds.add(String(entry.id));
        const payload = bundle?.payload;
        const parts = bundle?.parts;

        let mainDecoded: string | null = null;
        let mainBytes = 0;
        const partDecoded: Array<{ path: string; decoded: string; bytes: number }> = [];
        if (payload !== undefined) {
          const checked = checkBundlePayload('主载荷', payload);
          if (!checked.ok) {
            if (!integrityFailure) integrityFailure = checked.reason;
          } else {
            mainDecoded = checked.decoded;
            mainBytes = checked.bytes;
          }
        }
        if (parts !== undefined) {
          if (!Array.isArray(parts)) {
            if (!integrityFailure) integrityFailure = '外部分件为空或非数组';
          } else if (parts.length === 0) {
            // 声明了分件字段却为空：与「无分件」无法区分，按损坏处理
            if (!integrityFailure) integrityFailure = '外部分件为空';
          } else if (parts.length > MAX_ASSET_PARTS) {
            if (!integrityFailure) integrityFailure = `外部分件数超过上限（${MAX_ASSET_PARTS}）`;
          } else {
            for (const [index, part] of parts.entries()) {
              if (!isPlainRecord(part) || typeof part.path !== 'string' || typeof part.payload !== 'string') {
                if (!integrityFailure) integrityFailure = `外部分件 ${index} 结构非法`;
                break;
              }
              const checked = checkBundlePayload(`外部分件 ${part.path}`, part.payload);
              if (!checked.ok) {
                if (!integrityFailure) integrityFailure = checked.reason;
                break;
              }
              partDecoded.push({ path: part.path, decoded: checked.decoded, bytes: checked.bytes });
            }
          }
        }
        if (integrityFailure) return entry;
        if (mainDecoded === null && partDecoded.length === 0) {
          warnMissing(String(entry.id), String(entry.name ?? ''));
          return entry;
        }
        // size 精确核对：主载荷 + 全部外部分件解码字节之和必须与声明 size 完全一致（双向）
        const total = mainBytes + partDecoded.reduce((sum, p) => sum + p.bytes, 0);
        if (typeof entry.size !== 'number' || entry.size !== total) {
          integrityFailure = `资产 ${String(entry.name ?? entry.id)} 解码字节数（${total}）与声明 size（${entry.size}）不一致`;
          return entry;
        }
        if (typeof entry.hash === 'string' && entry.hash.length > 0) {
          hashChecks.push({
            assetId: String(entry.id),
            name: String(entry.name ?? ''),
            hash: entry.hash,
            main: mainDecoded,
            parts: partDecoded.map((p) => ({ path: p.path, decoded: p.decoded })),
          });
        }
        return {
          ...entry,
          ...(mainDecoded !== null ? { payload: payload as string } : {}),
          ...(partDecoded.length > 0 ? { parts } : {}),
        };
      })
    : project.assets;

  // 未引用孤儿包：包内 assets 段存在但项目资产条目未认领（迁移保持资产 id，合法包
  // 不存在孤儿）——同样全量校验并计入累计字节，拒绝「绕过资产条目校验」的载荷
  for (const [bundleId, rawBundle] of Object.entries(packageAssets)) {
    if (claimedBundleIds.has(bundleId)) continue;
    const bundle = isPlainRecord(rawBundle) ? rawBundle : null;
    if (!bundle) {
      integrityFailure = `包内资产 ${bundleId} 结构非法（非对象）`;
      break;
    }
    if (bundle.payload !== undefined) {
      const checked = checkBundlePayload('主载荷', bundle.payload);
      if (!checked.ok) {
        integrityFailure = `未引用资产 ${bundleId} ${checked.reason}`;
        break;
      }
    }
    if (bundle.parts !== undefined) {
      if (!Array.isArray(bundle.parts) || bundle.parts.length === 0) {
        integrityFailure = `未引用资产 ${bundleId} 外部分件为空或非数组`;
        break;
      }
      if (bundle.parts.length > MAX_ASSET_PARTS) {
        integrityFailure = `未引用资产 ${bundleId} 外部分件数超过上限（${MAX_ASSET_PARTS}）`;
        break;
      }
      let partsOk = true;
      for (const [index, part] of bundle.parts.entries()) {
        if (!isPlainRecord(part) || typeof part.path !== 'string' || typeof part.payload !== 'string') {
          integrityFailure = `未引用资产 ${bundleId} 外部分件 ${index} 结构非法`;
          partsOk = false;
          break;
        }
        const checked = checkBundlePayload(`未引用资产 ${bundleId} 外部分件 ${part.path}`, part.payload);
        if (!checked.ok) {
          integrityFailure = checked.reason;
          partsOk = false;
          break;
        }
      }
      if (!partsOk) break;
    }
  }

  if (integrityFailure) {
    return failure('invalid-project', `工程包数据校验失败：资产载荷不合法（${integrityFailure}）`, integrityFailure);
  }

  // 组合内容哈希：声明 hash 必须与解码内容一致（主载荷 + 分件，与模型导入同一算法）。
  // 用可移植 hashBytes（crypto.subtle 不可用时回退 FNV-1a）：任何环境都不跳过校验，
  // 跨环境包（SHA-256 声明 vs FNV 环境）因摘要长度不一致自然拒绝。
  for (const check of hashChecks) {
    const mainHash = check.main !== null ? await hashBytes(binaryStringToBytes(check.main)) : '';
    const partHashes = await Promise.all(
      check.parts.map(async (p) => ({ path: p.path, partHash: await hashBytes(binaryStringToBytes(p.decoded)) })),
    );
    const composite = await compositeContentHash(mainHash, partHashes);
    if (composite !== check.hash.toLowerCase()) {
      return failure(
        'invalid-project',
        `工程包数据校验失败：资产内容哈希不一致（${check.name}）`,
        `asset ${check.assetId}: 声明 ${check.hash}，实际 ${composite}`,
      );
    }
  }

  const restored = { ...project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, assets } as unknown;
  const problem = validateProjectSchema(restored);
  if (problem) {
    return failure('invalid-project', `工程包数据校验失败：${problem}`, problem);
  }
  return { ok: true, project: restored as Project, warnings, migratedFrom: migrated.migratedFrom };
}
