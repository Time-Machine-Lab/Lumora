/**
 * `.lumora` 工程包构建与解析（FR-011）：
 *
 * 导出 = 打包：project.json 按公开字段白名单构建（私有字段与运行时缓存引用剥离，
 *         settings 按契约字段投影、pluginData 默认排除并按插件声明剥离私有键）
 *         + manifest + assets 载荷段。
 * 导入 = 解析：文本长度上限 → JSON → manifest 校验 → schema 迁移 → 载荷完整性校验
 *         （先于解码的长度上限 / 规范 base64 / size 精确核对 / 组合内容哈希 /
 *         资源上限）→ 载荷回挂 → 完整校验 → 缺失资产报告（warning 明细，不阻断）。
 * 任何校验失败都返回可操作错误明细，由调用方保证当前项目不被覆盖（失败回滚）。
 * 损坏载荷（非法 base64 / size 不符 / hash 不符 / 超限 / 空分件 / 未引用孤儿包）
 * 一律拒绝导入，绝不把损坏资产判为导入成功。
 */

import type { AssetPartData, Project } from '../scene/types';
import { compositeContentHash, hashBytes } from '../scene/assets';
import { isArrayIndexKey } from '../scene/json-encoding';
import { validateProjectSchema, validateProjectStructure } from '../scene/validate';
import { migrateProjectSchema } from './migrate';
import { PACKAGE_FORMAT_VERSION, PROJECT_PACKAGE_FORMAT, CURRENT_PROJECT_SCHEMA_VERSION } from './schema';
import type { ProjectAssetPayload, ProjectPackage } from './schema';

export interface PackageBuildOptions {
  /** 是否包含插件私有设置（pluginData）。默认不含：pluginData 结构性排除（NFR-008）。 */
  includePrivate?: boolean;
  /** includePrivate 时的命名空间 + 显式公开导出契约（第十四轮阻断 1/2，破坏式
   *  改名自第十三轮的 privateKeysByPlugin —— 名称即语义，旧名调用编译失败，
   *  不再存在「按名传 {plugin: ['apiKey']} 导出 apiKey」的反向语义）：
   *  键为插件 instanceId，值为该命名空间允许随包导出的字段路径列表。每条声明
   *  是顶层键字符串（如 'theme'，整值导出）或路径数组（如 ['profile',
   *  'username']，逐层递归投影 —— 中间层必须是普通对象，路径外的字段不进包）。
   *  缺失映射 / 空数组 / 非数组（畸形）/ 路径含 __proto__ 等原型键 → 该命名
   *  空间整段排除（fail-closed 到底）：只有显式声明的公开字段进包，已注册但
   *  空/漏声明绝不整段放行；插件未声明任何公开字段时整个命名空间不导出，
   *  「凭据永不导出」不依赖插件自觉声明。
   *  声明由宿主直接读取 manifest.exportableSettings 原样传入（宿主不再做减法
   *  过滤），core 端负责路径投影与克隆。 */
  publicKeysByPlugin?: Record<string, readonly (string | readonly string[])[]>;
  /** 插件的私有键声明（宿主直读 manifest.privateSettings 原样传入，第十五轮
   *  阻断 1）：公开声明路径任意层与私有键重叠即整条声明拒绝 —— 私有键不因
   *  显式公开声明而可导出，凭据永不导出不依赖插件自觉声明。 */
  privateKeysByPlugin?: Record<string, readonly string[]>;
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
  | 'too-large'
  | 'hash-error';

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

/** 解析限额覆盖（缺省 = 上方常量）。测试注入小预算以验证限额行为；生产不传。 */
export interface PackageParseLimits {
  maxAssetPayloadBytes?: number;
  maxTotalPayloadBytes?: number;
  maxAssetParts?: number;
  maxAssetsPerProject?: number;
  maxObjectsPerProject?: number;
  maxSceneDepth?: number;
}

/** 包文本长度上限（字符数）：总载荷 base64 上限 + JSON 结构/字段开销余量。
 *  先于 JSON.parse 检查，防止超长文本解码攻击。 */
export const MAX_PACKAGE_TEXT_BYTES = Math.ceil((MAX_TOTAL_PAYLOAD_BYTES * 4) / 3) + 16 * 1024 * 1024;

/**
 * 先于解码的长度上限预检（O(1)，不触碰 base64 内容）：
 * - 编码长度上界 = 4 * ceil(maxBytes / 3)（maxBytes 非 3 整数倍时 ceil 才是正确上界，
 *   每 3 字节 → 4 字符，不会低估合法载荷也不会放过超限载荷）；
 * - 解码字节数按尾部 padding O(1) 精确计算（规范 base64：L = 4k 时字节 = 3k - pad 数；
 *   未对齐的畸形输入取保守上界，随后由规范 base64 校验拒绝，预检绝不高估预算）。
 * 单资产字符上限 / 解码字节上限 / 累计剩余预算任一超限即拒绝，防止超长文本进入 atob。
 */
export function preDecodePayloadFailure(
  payload: string,
  maxAssetBytes: number,
  maxTotalBytes: number,
  cumulativeBytes: number,
): string | null {
  const length = payload.length;
  if (length > 4 * Math.ceil(maxAssetBytes / 3)) {
    return `编码长度超过单资产上限（解码字节将超过 ${maxAssetBytes}）`;
  }
  const pads =
    length % 4 === 0 && length > 0
      ? payload[length - 1] === '='
        ? length > 1 && payload[length - 2] === '='
          ? 2
          : 1
        : 0
      : 0;
  const decodedBytes = length % 4 === 0 ? (length / 4) * 3 - pads : Math.ceil((length * 3) / 4);
  if (decodedBytes > maxAssetBytes) {
    return `解码字节数超过单资产上限（${maxAssetBytes}）`;
  }
  if (cumulativeBytes + decodedBytes > maxTotalBytes) {
    return `载荷累计字节数超过上限（${maxTotalBytes}）`;
  }
  return null;
}

/** 工程包仅携带的公开项目字段（白名单：未知顶层字段一律不进包）。
 *  导出预检（project-persistence.exportCurrent）按同一名单投影原项目的导出字段，
 *  与 buildProjectPackage 的包内容保持单一事实来源（第九轮 #2）。 */
export const PUBLIC_PROJECT_FIELDS = [
  'uri',
  'name',
  'schemaVersion',
  'createdAt',
  'revision',
  'settings',
  'activeSceneId',
  'scenes',
  'objects',
  'tracks',
  'assets',
] as const;

/** 工程包携带的公开设置字段（契约，第十一轮）：ProjectSettings 是强类型
 *  {fps, aspect}，契约外键（无论键名形态，含凭据类键名）任何情况下不得进入包 ——
 *  凭据隔离是结构性契约而非键名猜测。 */
export const PUBLIC_SETTINGS_FIELDS = ['fps', 'aspect'] as const;

/** 每层公开 DTO 的契约字段（第十二轮阻断 1）：默认导出对 scenes/objects/tracks/
 *  资产元数据逐层白名单投影，与 settings 契约化同一机制 —— 嵌套在 DTO 中的
 *  未知字段（含凭据形态键名）任何情况下不得进入包。 */
export const PUBLIC_SCENE_FIELDS = ['id', 'name', 'rootObjectIds', 'activeCameraId'] as const;
export const PUBLIC_OBJECT_FIELDS = [
  'id',
  'type',
  'name',
  'parentId',
  'transform',
  'visible',
  'locked',
  'geometry',
  'material',
  'light',
  'camera',
  'assetId',
] as const;
export const PUBLIC_TRANSFORM_FIELDS = ['position', 'rotation', 'scale'] as const;
export const PUBLIC_GEOMETRY_FIELDS = ['kind'] as const;
export const PUBLIC_MATERIAL_FIELDS = ['color'] as const;
export const PUBLIC_LIGHT_FIELDS = ['kind', 'color', 'intensity', 'distance', 'angle'] as const;
export const PUBLIC_CAMERA_FIELDS = [
  'projection',
  'focalLength',
  'fov',
  'sensorWidth',
  'sensorHeight',
  'near',
  'far',
  'aspect',
] as const;
export const PUBLIC_TRACK_FIELDS = ['id', 'name', 'objectId', 'targetPath', 'keyframes'] as const;
export const PUBLIC_KEYFRAME_FIELDS = ['time', 'value', 'interpolation'] as const;
export const PUBLIC_ASSET_FIELDS = [
  'id',
  'kind',
  'name',
  'format',
  'mime',
  'hash',
  'size',
  'source',
  'storageRef',
  'payload',
  'parts',
  'createdAt',
] as const;
/** 外部分件（AssetPartData）契约字段：{ path, mime, payload } */
export const PUBLIC_ASSET_PART_FIELDS = ['path', 'mime', 'payload'] as const;
/** manifest.project 必需字段：缺失（own 数据字段不存在）即拒绝导出（第十三轮一般 6） */
const REQUIRED_PROJECT_FIELDS = ['uri', 'name', 'schemaVersion', 'revision'] as const;

function failure(code: PackageImportErrorCode, message: string, detail?: string): PackageParseResult {
  return { ok: false, error: { code, message, detail } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 以 property descriptor 读取 own 数据字段（第十二轮一般 #8）：字段存在性以
 *  getOwnPropertyDescriptor 判定，不执行属性读取 —— getter/Proxy trap 不得在
 *  导出前产生副作用（与 findJsonEncodingProblem 的 accessor-property 语义一致）；
 *  访问器字段与反射抛错（Proxy trap）抛错拒绝：descriptor 预检与后续
 *  structuredClone 基于同一投影视图，克隆不得物化预检时未看到的 getter、也不得
 *  因物化失败而静默产出丢字段的包。非 own（继承）字段视为不存在：继承属性不
 *  进入工程包。 */
function readOwnDataField(source: unknown, field: string): { present: true; value: unknown } | { present: false } {
  if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
    return { present: false };
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(source, field);
  } catch {
    throw new Error(`字段 ${field} 无法反射（代理陷阱抛错），导出被拒绝`);
  }
  if (!descriptor) return { present: false };
  if ('get' in descriptor || 'set' in descriptor) {
    throw new Error(`字段 ${field} 是访问器属性，无法安全导出`);
  }
  return { present: true, value: descriptor.value };
}

/** 按契约字段白名单投影一个 DTO（第十二轮阻断 1）：仅 own 数据字段进入投影
 *  （访问器/反射异常由 readOwnDataField 拒绝）；契约外字段（含凭据形态键名）
 *  一律不进包 —— 与 settings 契约化同一机制。非对象值原样保留（无字段可泄露）。 */
function projectDto(value: unknown, fields: readonly string[]): unknown {
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const read = readOwnDataField(value, field);
    if (read.present && read.value !== undefined) out[field] = read.value;
  }
  return out;
}

/** 场景对象投影：transform/geometry/material/light/camera 子结构同样按契约投影
 *  （第十三轮阻断 1：子结构整对象进包会使 camera.apiKey 等嵌套凭据进入默认包） */
function projectObjectDto(value: unknown): unknown {
  const out = projectDto(value, PUBLIC_OBJECT_FIELDS);
  if (!isPlainRecord(out)) return out;
  const transform = projectDto(out.transform, PUBLIC_TRANSFORM_FIELDS);
  if (isPlainRecord(transform)) out.transform = transform;
  const geometry = projectDto(out.geometry, PUBLIC_GEOMETRY_FIELDS);
  if (isPlainRecord(geometry)) out.geometry = geometry;
  const material = projectDto(out.material, PUBLIC_MATERIAL_FIELDS);
  if (isPlainRecord(material)) out.material = material;
  const light = projectDto(out.light, PUBLIC_LIGHT_FIELDS);
  if (isPlainRecord(light)) out.light = light;
  const camera = projectDto(out.camera, PUBLIC_CAMERA_FIELDS);
  if (isPlainRecord(camera)) out.camera = camera;
  return out;
}

/** 动画轨道投影：keyframes 子结构同样按契约投影 */
function projectTrackDto(value: unknown): unknown {
  const out = projectDto(value, PUBLIC_TRACK_FIELDS);
  if (isPlainRecord(out) && Array.isArray(out.keyframes)) {
    out.keyframes = out.keyframes.map((frame) => projectDto(frame, PUBLIC_KEYFRAME_FIELDS));
  }
  return out;
}

/** 资产条目元数据投影：payload/parts/storageRef 由调用方处理，其余字段按契约白名单 */
function projectAssetMeta(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_ASSET_FIELDS) {
    const read = readOwnDataField(value, field);
    if (read.present && read.value !== undefined) out[field] = read.value;
  }
  return out;
}

/** 外部分件数组投影（第十三轮阻断 1 + 严重 3）：逐元素按 AssetPartData 契约投影
 *  （元素嵌套未知字段不得进包）；数组自身的非索引 own 键（如 parts.extra）在
 *  JSON 序列化时必然静默丢弃 —— 显式拒绝导出，绝不静默丢字段却返回成功。 */
function projectAssetPartArray(value: unknown): AssetPartData[] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const keyStr = typeof key === 'symbol' ? null : String(key);
    if (keyStr === null || !isArrayIndexKey(keyStr)) {
      throw new Error(`资产分件数组含非索引属性 ${String(key)}，无法安全导出（JSON 会静默丢弃）`);
    }
  }
  return value.map((part) => projectDto(part, PUBLIC_ASSET_PART_FIELDS)) as AssetPartData[];
}

/** 原型污染防护：显式公开声明中的这些键一律不作为导出路径（赋值到普通对象
 *  会触发原型 setter / 污染）。 */
function isSafeExportKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/** 凭据形态键名（第十五轮阻断 1）：公开声明路径任意层出现这些键名（不区分
 *  大小写、子串匹配）即整条声明拒绝 —— 「凭据永不导出」不依赖插件自觉声明
 *  privateSettings，显式声明凭据键也不是放行依据。 */
const CREDENTIAL_SHAPE_PATTERNS = [
  'apikey',
  'password',
  'passwd',
  'token',
  'secret',
  'credential',
  'privatekey',
  'auth',
] as const;

function isCredentialShapeKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return CREDENTIAL_SHAPE_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/** 整值导出仅允许 JSON primitive 叶值（第十五轮阻断 1）：对象/数组整值导出会
 *  绕过递归投影（嵌套凭据随整对象/整数组进包），一律拒绝 —— 对象内容只能经
 *  显式路径声明逐叶导出；数组无逐元素投影机制，整数组不导出。 */
function isExportableLeaf(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** 投影 trie：键 → 子节点；'leaf' = 顶层字符串声明（整值导出意图，覆盖该键下
 *  的任何冗余路径声明，第十五轮严重 2 —— 祖先声明覆盖冗余后代，结果与声明
 *  顺序无关）。 */
type ExportTrie = Map<string, ExportTrie | 'leaf'>;

/** 声明列表规范化为 trie（纯数据，无合并/原地改写）：顶层字符串声明置 leaf
 *  （祖先覆盖：其下路径声明忽略）；路径数组逐层建分支。任一路径键含原型键、
 *  privateSettings 重叠或凭据形态键时整条声明拒绝（fail-closed）。 */
function buildExportTrie(
  declarations: readonly (string | readonly string[])[],
  privateKeys: readonly string[],
): ExportTrie | null {
  const root: ExportTrie = new Map();
  for (const declaration of declarations) {
    if (typeof declaration === 'string') {
      if (!isSafeExportKey(declaration) || privateKeys.includes(declaration) || isCredentialShapeKey(declaration)) {
        continue;
      }
      root.set(declaration, 'leaf');
      continue;
    }
    if (!Array.isArray(declaration) || declaration.length === 0) continue; // 畸形/空路径：忽略
    let node = root;
    let rejected = false;
    for (let i = 0; i < declaration.length; i += 1) {
      const key = declaration[i];
      if (typeof key !== 'string' || !isSafeExportKey(key) || privateKeys.includes(key) || isCredentialShapeKey(key)) {
        rejected = true;
        break;
      }
      const existing = node.get(key);
      if (existing === 'leaf') break; // 祖先声明覆盖冗余后代：路径声明忽略
      if (i === declaration.length - 1) {
        node.set(key, 'leaf');
        break;
      }
      if (existing === undefined) {
        const child: ExportTrie = new Map();
        node.set(key, child);
        node = child;
      } else {
        node = existing;
      }
    }
    void rejected; // 拒绝 = 该声明不进入 trie（fail-closed 与忽略同效）
  }
  if (root.size === 0) return null;
  return root;
}

/** 按 trie 递归投影单个键（纯函数：只读源、在新对象上构建、叶值仅 primitive）：
 *  - leaf：整值导出 —— 值必须是 JSON primitive 叶值；缺失/undefined/对象/数组
 *    一律不导出（对象内容只能经显式路径声明逐叶导出）；
 *  - branch：中间层必须是普通对象，逐子键递归投影（子键访问器/反射异常由
 *    readOwnDataField 拒绝）—— 全程不执行 getter、不修改源对象、不依赖声明
 *    顺序（trie 已规范化，祖先覆盖冗余后代）。
 *  返回 undefined = 该键无可导出内容。 */
function projectExportTrie(source: unknown, node: ExportTrie | 'leaf', field: string): unknown {
  const read = readOwnDataField(source, field);
  if (!read.present || read.value === undefined) return undefined;
  if (node === 'leaf') {
    return isExportableLeaf(read.value) ? read.value : undefined;
  }
  if (!isPlainRecord(read.value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [childKey, childNode] of node) {
    const child = projectExportTrie(read.value, childNode, childKey);
    if (child !== undefined) out[childKey] = child;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/** 单个命名空间的路径 schema 显式公开投影（第十四轮阻断 1 + 第十五轮严重 2）：
 *  声明先规范化为 trie（纯函数、顺序无关），再逐层递归投影 —— 中间层必须是
 *  普通对象，只导出显式声明的叶路径；整值声明仅允许 primitive 叶值，对象/数组
 *  整值一律拒绝（强制递归投影，嵌套凭据无整对象出口）；声明路径任意层与
 *  privateSettings 重叠或为凭据形态键时整条声明拒绝（阻断 1，fail-closed）。
 *  返回 undefined = 无可导出内容（调用方整段排除）。
 *  字段读取统一走 readOwnDataField（descriptor 语义：访问器/反射异常拒绝，
 *  全程不执行 getter）。 */
function applyPublicPluginData(
  value: unknown,
  declarations: readonly (string | readonly string[])[],
  privateKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const trie = buildExportTrie(declarations, privateKeys);
  if (!trie) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, node] of trie) {
    const projected = projectExportTrie(value, node, key);
    if (projected !== undefined) out[key] = projected;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/**
 * 命名空间 + 路径 schema 显式公开导出投影（第十四轮阻断 1/2，破坏式改名自
 * 第十三轮 privateKeysByPlugin；第十五轮阻断 1 + 严重 2 加固）：映射值 = 该
 * 命名空间允许随包导出的字段路径列表（顶层键字符串或 [父键, 子键, …] 路径
 * 数组，逐层递归投影）。隔离绝不 fail-open：
 * - instanceId 不在映射（未注册插件）或映射整体缺失 → 全部命名空间排除，
 *   没有 manifest 公开声明的来源数据没有进入包的依据；
 * - 空/畸形声明（[] / 非数组）→ 整段排除（拒绝把畸形声明当作放行依据）；
 * - instanceId 或路径键为 '__proto__' 等原型键 → 排除（原型污染矢量）；
 * - 声明与 manifest.privateSettings（privateKeysByPlugin 原样传入）重叠、
 *   或声明路径含凭据形态键（apiKey/password/token/secret/…）→ 整条声明
 *   拒绝 —— 「凭据永不导出」不依赖插件自觉声明；
 * - 整值声明仅允许 primitive 叶值：对象/数组整值导出被强制递归投影拒绝。
 * 声明查询以 Object.hasOwn 判定 + Array.isArray 防护；命名空间值经
 * readOwnDataField 读取（descriptor 语义，不执行 getter）。投影只读源、
 * 在新对象上构建，绝不修改源项目对象（多次构建/深冻结项目不得互相污染）。
 */
function projectPublicPluginData(
  pluginData: Record<string, unknown>,
  publicKeysByPlugin?: Record<string, readonly (string | readonly string[])[]>,
  privateKeysByPlugin?: Record<string, readonly string[]>,
): Record<string, unknown> | undefined {
  if (!publicKeysByPlugin) return undefined;
  const out: Record<string, unknown> = {};
  for (const instanceId of Object.keys(pluginData)) {
    if (instanceId === '__proto__' || !Object.hasOwn(publicKeysByPlugin, instanceId)) continue;
    const declarations = publicKeysByPlugin[instanceId];
    if (!Array.isArray(declarations) || declarations.length === 0) continue;
    const privateKeys =
      privateKeysByPlugin && Array.isArray(privateKeysByPlugin[instanceId]) ? privateKeysByPlugin[instanceId] : [];
    const read = readOwnDataField(pluginData, instanceId);
    if (!read.present) continue;
    const projected = applyPublicPluginData(read.value, declarations, privateKeys);
    if (projected) out[instanceId] = projected;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/**
 * 构建工程包：
 * - 逐层白名单构建 project 段（第十二轮阻断 1 + 第十三轮阻断 1）：根级仅公开
 *   字段进入包；settings 按契约字段投影（PUBLIC_SETTINGS_FIELDS，契约外键结构性
 *   排除）；scenes/objects/tracks/资产元数据按各自公开 DTO 契约逐层投影
 *   （transform/geometry/material/light/camera/keyframes 子结构与 assets[].parts[]
 *   分件元素同契约）—— 嵌套未知字段（含凭据形态键名）任何情况下不得进入包；
 *   pluginData 默认排除（includePrivate 时按命名空间 + 路径 schema 显式公开
 *   声明投影（manifest.exportableSettings 原样传入，第十四轮阻断 1/2），
 *   未知命名空间/空漏声明/畸形声明/未声明路径 fail-closed 排除 —— 不再递归
 *   猜测键名，NFR-008）；
 * - 投影基于 property descriptor（第十二轮一般 #8）：以 getOwnPropertyDescriptor
 *   读取 own 数据字段，访问器/反射异常在读取时拒绝 —— descriptor 预检与后续
 *   structuredClone 基于同一投影视图，克隆不物化预检未看到的字段；manifest 与
 *   project 段同从投影视图读取，必需字段缺失即拒绝导出（第十三轮一般 6）；
 * - 资产字节从 project.json 摘出，按 assetId 挂入 assets 段（分件数组的非索引
 *   属性 JSON 序列化必丢 —— 显式拒绝，绝不静默丢字段，第十三轮严重 3）；
 * - storageRef 为运行期缓存引用（object URL），跨环境不可重建，导出恒置空。
 */
export function buildProjectPackage(project: Project, options: PackageBuildOptions = {}): ProjectPackage {
  const includePrivate = options.includePrivate ?? false;
  const exportedAt = options.exportedAt ?? new Date().toISOString();

  // 根级字段投影：直接以原 project 为源（引用原值），投影视图随后统一克隆。
  // manifest 必需字段（uri/name/schemaVersion/revision）缺失 own 数据字段即拒绝
  // 导出（第十三轮一般 6）：manifest 与 project 段同从投影视图读取，继承 getter
  // 不会产生「manifest 有、project 段无」的不一致包
  const stripped: Record<string, unknown> = {};
  for (const field of PUBLIC_PROJECT_FIELDS) {
    const read = readOwnDataField(project, field);
    if (read.present && read.value !== undefined) {
      stripped[field] = read.value;
    } else if ((REQUIRED_PROJECT_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`项目缺少必需字段 ${field}（own 数据字段不存在），导出被拒绝`);
    }
  }
  if (includePrivate) {
    const read = readOwnDataField(project, 'pluginData');
    if (read.present && read.value !== undefined) {
      // 直接以源为投影输入（不再浅展开 —— 展开会执行命名空间层的 getter，
      // 第十五轮一般 6）：投影只读源、在新对象上构建，绝不修改源项目对象；
      // 全部命名空间被排除（无任何已注册插件或声明）时 pluginData 键整体不进包
      if (isPlainRecord(read.value)) {
        const projected = projectPublicPluginData(read.value, options.publicKeysByPlugin, options.privateKeysByPlugin);
        if (projected) stripped.pluginData = projected;
      }
    }
  }
  // settings 契约投影：仅公开契约字段进入包（结构上排除契约外键，含凭据类键名）
  if (isPlainRecord(stripped.settings)) {
    const settings: Record<string, unknown> = {};
    for (const field of PUBLIC_SETTINGS_FIELDS) {
      const read = readOwnDataField(stripped.settings, field);
      if (read.present && read.value !== undefined) settings[field] = read.value;
    }
    stripped.settings = settings;
  }
  // 每层 DTO 契约投影（scenes/objects/tracks 与 settings 同一机制）
  if (Array.isArray(stripped.scenes)) stripped.scenes = stripped.scenes.map((scene) => projectDto(scene, PUBLIC_SCENE_FIELDS));
  if (Array.isArray(stripped.objects)) stripped.objects = stripped.objects.map((object) => projectObjectDto(object));
  if (Array.isArray(stripped.tracks)) stripped.tracks = stripped.tracks.map((track) => projectTrackDto(track));

  // 无原型字典：资产 id 是导入包可携带的任意字符串（含 '__proto__'），
  // 普通 {} 的赋值会走原型 setter 丢字节/污染原型（导入→导出→导入字节丢失）
  const assets: Record<string, ProjectAssetPayload> = Object.create(null) as Record<string, ProjectAssetPayload>;
  let assetCount = 0;
  const strippedAssets = Array.isArray(stripped.assets)
    ? (stripped.assets as unknown[]).map((asset) => {
        const meta = projectAssetMeta(asset);
        const payload = typeof meta.payload === 'string' ? meta.payload : undefined;
        const parts = projectAssetPartArray(meta.parts);
        // 主载荷是资产的必要内容（glTF/GLB）：没有主载荷绝不生成 parts-only bundle，
        // 分件仅随主载荷一并进入包内 assets 段
        if (payload !== undefined) {
          assets[String(meta.id)] = {
            payload,
            ...(parts !== undefined && parts.length > 0 ? { parts } : {}),
          };
          assetCount += 1;
        }
        const { payload: _payload, parts: _parts, ...metaRest } = meta;
        return { ...metaRest, storageRef: '' };
      })
    : [];

  // 统一克隆投影视图：包内内容与预检看到的图一致（引用原值的投影视图在克隆时
  // 已不含任何契约外字段/访问器，克隆不会物化或删除预检未看到的字段）
  const packageProject = structuredClone({ ...stripped, assets: strippedAssets }) as unknown as Project;

  return {
    manifest: {
      format: PROJECT_PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      exportedAt,
      app: { name: options.appName ?? 'Lumora Studio', version: options.appVersion ?? '0.1.0' },
      project: {
        uri: String(stripped.uri),
        name: String(stripped.name),
        schemaVersion: stripped.schemaVersion as number,
        revision: stripped.revision as number,
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
function hasExcessiveHierarchy(objects: readonly unknown[], maxDepth: number): boolean {
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
      if (depth > maxDepth || path.has(cursor)) return true;
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
export async function parseProjectPackage(
  text: string,
  limits: PackageParseLimits = {},
): Promise<PackageParseResult> {
  if (text.length > MAX_PACKAGE_TEXT_BYTES) {
    return failure(
      'too-large',
      `工程包文件过大（字符数 ${text.length} 超过上限 ${MAX_PACKAGE_TEXT_BYTES}），无法导入`,
    );
  }
  const maxAssetPayloadBytes = limits.maxAssetPayloadBytes ?? MAX_ASSET_PAYLOAD_BYTES;
  const maxTotalPayloadBytes = limits.maxTotalPayloadBytes ?? MAX_TOTAL_PAYLOAD_BYTES;
  const maxAssetParts = limits.maxAssetParts ?? MAX_ASSET_PARTS;
  const maxAssetsPerProject = limits.maxAssetsPerProject ?? MAX_ASSETS_PER_PROJECT;
  const maxObjectsPerProject = limits.maxObjectsPerProject ?? MAX_OBJECTS_PER_PROJECT;
  const maxSceneDepth = limits.maxSceneDepth ?? MAX_SCENE_DEPTH;
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
  if (Array.isArray(project.objects) && project.objects.length > maxObjectsPerProject) {
    return failure('too-large', `工程包对象数超过上限（${project.objects.length} > ${maxObjectsPerProject}），无法导入`);
  }
  if (Array.isArray(project.objects) && hasExcessiveHierarchy(project.objects, maxSceneDepth)) {
    return failure('too-large', `工程包对象层级超过上限（${maxSceneDepth} 层）或存在环，无法导入`);
  }
  if (Array.isArray(project.assets) && project.assets.length > maxAssetsPerProject) {
    return failure('too-large', `工程包资产数超过上限（${project.assets.length} > ${maxAssetsPerProject}），无法导入`);
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
  /** 已被项目资产条目认领的包内 bundle；认领集之外 = 未引用孤儿包（合法包不存在） */
  const claimedBundleIds = new Set<string>();
  /** 载荷存在时的哈希格式（SHA-256 十六进制，大小写均可；缺失/格式非法一律拒绝） */
  const HASH_FORMAT = /^[0-9a-fA-F]{64}$/;

  /**
   * 单个载荷（主载荷或外部分件）的完整性检查。assetBytes 为该资产已累计解码字节：
   * 解码前按「剩余单资产额度 + 剩余总预算」预检，解码后精确核对 —— 多分件拆分
   * 不能绕过单资产字节上限（per-bundle 预算累计）。
   */
  const checkBundlePayload = (
    label: string,
    payload: unknown,
    assetBytes: number,
  ): { ok: true; decoded: string; bytes: number } | { ok: false; reason: string } => {
    if (typeof payload !== 'string') return { ok: false, reason: `${label} 非字符串` };
    const assetRemaining = maxAssetPayloadBytes - assetBytes;
    if (assetRemaining <= 0) {
      return { ok: false, reason: `${label} 资产解码字节数超过单资产上限（${maxAssetPayloadBytes}）` };
    }
    // 先于解码的长度上限检查（O(1) 精确预检，拒绝解码攻击）
    const pre = preDecodePayloadFailure(payload, assetRemaining, maxTotalPayloadBytes, cumulativePayloadBytes);
    if (pre) return { ok: false, reason: `${label} ${pre}` };
    const checked = checkCanonicalBase64(payload);
    if (!checked.ok) return { ok: false, reason: `${label} ${checked.reason}` };
    // 解码后精确核对（预检不会低估，但解码结果仍以实际为准）
    if (checked.bytes > assetRemaining) {
      return { ok: false, reason: `${label} 解码字节数超过单资产上限（${maxAssetPayloadBytes}）` };
    }
    cumulativePayloadBytes += checked.bytes;
    if (cumulativePayloadBytes > maxTotalPayloadBytes) {
      return { ok: false, reason: `载荷累计字节数超过上限（${maxTotalPayloadBytes}）` };
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
        let assetBytes = 0;
        const partDecoded: Array<{ path: string; decoded: string; bytes: number }> = [];
        if (payload !== undefined) {
          const checked = checkBundlePayload('主载荷', payload, assetBytes);
          if (!checked.ok) {
            if (!integrityFailure) integrityFailure = checked.reason;
          } else {
            mainDecoded = checked.decoded;
            mainBytes = checked.bytes;
            assetBytes += checked.bytes;
          }
        }
        if (parts !== undefined) {
          if (!Array.isArray(parts)) {
            if (!integrityFailure) integrityFailure = '外部分件为空或非数组';
          } else if (parts.length === 0) {
            // 声明了分件字段却为空：与「无分件」无法区分，按损坏处理
            if (!integrityFailure) integrityFailure = '外部分件为空';
          } else if (parts.length > maxAssetParts) {
            if (!integrityFailure) integrityFailure = `外部分件数超过上限（${maxAssetParts}）`;
          } else {
            for (const [index, part] of parts.entries()) {
              if (!isPlainRecord(part) || typeof part.path !== 'string' || typeof part.payload !== 'string') {
                if (!integrityFailure) integrityFailure = `外部分件 ${index} 结构非法`;
                break;
              }
              const checked = checkBundlePayload(`外部分件 ${part.path}`, part.payload, assetBytes);
              if (!checked.ok) {
                if (!integrityFailure) integrityFailure = checked.reason;
                break;
              }
              assetBytes += checked.bytes;
              if (assetBytes > maxAssetPayloadBytes) {
                if (!integrityFailure) {
                  integrityFailure = `资产解码字节数超过单资产上限（${maxAssetPayloadBytes}）`;
                }
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
        if (mainDecoded === null) {
          // 强制 glTF/GLB 主载荷存在：parts-only 的模型无法在视口恢复内容，
          // 绝不把「缺少主载荷」的资产判为导入成功
          integrityFailure = `资产 ${String(entry.name ?? entry.id)} 缺少主载荷（glTF/GLB 内容必须作为主载荷存在，不允许仅外部分件）`;
          return entry;
        }
        // size 精确核对：主载荷 + 全部外部分件解码字节之和必须与声明 size 完全一致（双向）
        const total = mainBytes + partDecoded.reduce((sum, p) => sum + p.bytes, 0);
        if (typeof entry.size !== 'number' || entry.size !== total) {
          integrityFailure = `资产 ${String(entry.name ?? entry.id)} 解码字节数（${total}）与声明 size（${entry.size}）不一致`;
          return entry;
        }
        // 有载荷时必须携带格式明确的哈希，且无条件校验（与内容不符即拒绝）
        if (typeof entry.hash !== 'string' || !HASH_FORMAT.test(entry.hash)) {
          integrityFailure = `资产 ${String(entry.name ?? entry.id)} 载荷存在但内容哈希缺失或格式非法（需 64 位十六进制）`;
          return entry;
        }
        hashChecks.push({
          assetId: String(entry.id),
          name: String(entry.name ?? ''),
          hash: entry.hash,
          main: mainDecoded,
          parts: partDecoded.map((p) => ({ path: p.path, decoded: p.decoded })),
        });
        return {
          ...entry,
          ...(mainDecoded !== null ? { payload: payload as string } : {}),
          ...(partDecoded.length > 0 ? { parts } : {}),
        };
      })
    : project.assets;

  // 未引用孤儿包：包内 assets 段存在但项目资产条目未认领（迁移保持资产 id，
  // 构建端每项 bundle 必有对应资产条目，合法包不存在孤儿）——拒绝导入，
  // 杜绝「绕过资产条目校验」的载荷与死数据
  for (const bundleId of Object.keys(packageAssets)) {
    if (!claimedBundleIds.has(bundleId)) {
      integrityFailure = `包内资产 ${bundleId} 未被任何项目资产引用（孤儿载荷）`;
      break;
    }
  }

  if (integrityFailure) {
    return failure('invalid-project', `工程包数据校验失败：资产载荷不合法（${integrityFailure}）`, integrityFailure);
  }

  // 组合内容哈希：有载荷的资产无条件按声明验证（主载荷 + 分件，与模型导入同一算法）。
  // hashBytes 恒为 SHA-256（WebCrypto 或纯 JS 回退同一算法），任何环境不跳过校验；
  // 摘要计算异常封装为 PackageParseResult（hash-error），绝不泄漏未捕获异常
  try {
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
  } catch (error) {
    return failure(
      'hash-error',
      '工程包数据校验失败：内容哈希计算异常',
      error instanceof Error ? error.message : String(error),
    );
  }

  const restored = { ...project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, assets } as unknown;
  const problem = validateProjectSchema(restored);
  if (problem) {
    return failure('invalid-project', `工程包数据校验失败：${problem}`, problem);
  }
  // 完整图结构校验（第六轮 #2）：父引用/根挂载/活动场景/机位归属与加载边界同一套
  // 纯校验 —— 图关系损坏的包不得判为导入成功
  const structureProblem = validateProjectStructure(restored as Project);
  if (structureProblem) {
    return failure('invalid-project', `工程包数据校验失败：${structureProblem}`, structureProblem);
  }
  return { ok: true, project: restored as Project, warnings, migratedFrom: migrated.migratedFrom };
}
