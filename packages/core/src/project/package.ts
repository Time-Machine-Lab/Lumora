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

export type PackageBuildErrorCode = 'credential-declaration-rejected';

/** 工程包构建校验失败（第二十五轮：凭据形态公开声明不再静默丢弃）。构建期
 *  抛错（与 import 侧 PackageImportError 结果类型对应）：插件作者必须看到
 *  自己的公开声明被拒、改走安全通道 —— 「凭据永不导出」不依赖插件自觉声明，
 *  也不静默产出缺少字段的包。 */
export class PackageBuildError extends Error {
  readonly code: PackageBuildErrorCode;
  /** 全部被拒声明（跨插件聚合，一次构建报全） */
  readonly declarations: ReadonlyArray<{ plugin: string; path: string }>;
  constructor(
    code: PackageBuildErrorCode,
    message: string,
    declarations: ReadonlyArray<{ plugin: string; path: string }>,
  ) {
    super(message);
    this.name = 'PackageBuildError';
    this.code = code;
    this.declarations = declarations;
  }
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
  'shots',
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
export const PUBLIC_TRACK_FIELDS = ['id', 'name', 'objectId', 'targetPath', 'disabled', 'keyframes'] as const;
export const PUBLIC_KEYFRAME_FIELDS = ['time', 'value', 'interpolation'] as const;
export const PUBLIC_SHOT_FIELDS = ['id', 'name', 'cameraObjectId', 'startTime', 'endTime'] as const;
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

/** C0/C1/DEL 控制字符（第三十五轮阻断 2）：NUL/TAB 等不可打印字符在旧规范化
 *  管道中被当分隔符剥除（'token<NUL>izerConfig' → 'tokenizerconfig'）命中
 *  BENIGN 精确豁免而放行、凭据值进包。统一拒绝 —— 声明与数据投影两侧都不
 *  接受（声明侧另有显式拒绝带路径明细） */
// eslint-disable-next-line no-control-regex -- 本正则的全部用途就是拒绝控制字符
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;

function hasControlCharacter(key: string): boolean {
  return CONTROL_CHARACTER_RE.test(key);
}

/** 原型污染防护 + 控制字符拒绝：显式公开声明中的这些键一律不作为导出路径
 * （赋值到普通对象会触发原型 setter / 污染）；含 C0/C1/DEL 控制字符的键一律
 * 拒绝（第三十五轮阻断 2 —— trie 构建与数据投影的兜底防线）。 */
function isSafeExportKey(key: string): boolean {
  return (
    key !== '__proto__' &&
    key !== 'constructor' &&
    key !== 'prototype' &&
    !hasControlCharacter(key)
  );
}

/** 凭据形态判定（第二十三轮范式反转重写，阻断 2/3 + 严重 5；历轮演进见
 *  第十五轮阻断 1 + 第十七轮阻断 1/严重 2 + 第十八轮重构 + 第十九轮阻断 1 +
 *  第二十一轮严重 4/5、阻断 1 + 第二十八轮阻断 1/严重 7）：判定范式由「有限
 *  黑名单枚举」反转为「默认拒绝敏感形态 + 可审计 benign 契约正向豁免
 *  （allowlist）」。有限黑名单不可闭合（apiToken/authToken/csrfToken/
 *  idToken/privateToken/secretkey/passphrase/密碼/秘钥/パスワード/contraseña
 *  等仍可重入包），正向豁免表随产品公开契约显式演进、可审计。全部规则有边界
 *  （整词精确相等 / 词边界后缀 / 整键规范化后精确相等），不再对派生候选做
 *  子串 includes（passwordless/apiKeyboardLayout/accessTokenizerConfig/
 *  privateKeyboardShortcuts/compassWordWrap 等合法键不再误伤，第二十三轮
 *  严重 5）：
 *  1. 正向豁免：叶键精确命中 BENIGN_CREDENTIAL_KEYS（tokenBudget/authMode/
 *     cookieConsent/cookieSettings/sessionMode）即放行 —— 歧义字段的合法公开
 *     契约白名单（第二十三轮阻断 2 + 第二十八轮严重 7：session/cookie 入 kind
 *     集后，产品确认的良性键显式豁免）；
 *  2. 凭据类词（kind：token/secret/password/passwd/passphrase/credential(s)/
 *     auth/session/cookie）作为「语义角色」参与有边界判定 —— 任意 token 位置
 *     精确匹配（含单复数归一）即拒绝（第二十五轮：替代旧「末位 kind + 纯数字
 *     后缀」判定，覆盖 apiToken/authToken/csrfToken/idToken/privateToken 等
 *     「限定词 + kind」形态与 tokenValue/tokenHash/apiTokenV2 等 X+kind+Y
 *     形态；第二十八轮严重 7：session/cookie 是常见认证载体，默认拒绝，
 *     良性歧义键走 BENIGN 表）。tokenizerConfig/authorizationMode/renderPass
 *     等以词边界精确匹配不误伤；key 语义过泛不入 kind 集（shortcutKey/hotkey
 *     合法），X+key 形态由相邻复合对闭合（api+key/private+key/auth+key/
 *     pass+key/secret+key）；
 *  3. 高置信凭据根词（多语言表）：Latin 根词（password/passwd/passphrase/
 *     passcode/secret/credential(s)/contrasena）对 token 整词精确匹配（含
 *     单复数归一，绝无子串匹配）；CJK/日文/韩文等无词边界语言（密码/密碼/
 *     口令/令牌/密钥/秘钥/凭据/私钥/私鑰/パスワード/パスフレーズ/シークレット/
 *     秘密鍵/認証トークン/비밀번호/토큰/시크릿 等）只能做归一化后包含匹配；
 *     contraseña 经 NFKD 剥离组合变音符号归一（caféMode→cafemode 同管道
 *     放行，第二十三轮阻断 2）；
 *  4. kind-suffix 扩展：token 以 kind 词（含复数形）结尾时拆分为 [前缀, kind]
 *     参与判定 —— clientsecret/storedpassword/bearertoken/databasepassword/
 *     usercredentials/secretkey 等无边界连写由同一规则闭合，不再枚举全部
 *     限定词；passwordless（-less 结尾）/keyboard（key 为前缀非后缀）/
 *     tokenizer（-nizer 结尾）不拆分（有边界判定，第二十三轮严重 5）；
 *  5. 相邻复合对（19 组）任意 token 位置命中即拒绝 —— 无 kind 结尾的明确
 *     凭据序列（pass+word/auth+header/private+setting/token+value/
 *     password+hash/token+hash/password+value）仍闭合（第二十八轮阻断 1：
 *     tokenvalue/passwordhash 等全小写单 token 无 camelCase 边界，kind-word
 *     精确匹配不命中，由复合对派生的无边界形态精确相等闭合）；
 *  6. 无边界复合形态（第二十一轮阻断 1 保留，第二十三轮严重 5 改精确相等）：
 *     整键归一化+去分隔后与派生候选（复合对/敏感限定组合拼接表）精确相等
 *     才拒绝 —— authheader/privatesetting/secretvalue 等连写；绝不 includes
 *     （accessTokenizerConfig 不再误中 accesstoken）。数字后缀剥除后命中
 *     候选表同样拒绝（apikey2/authkey2/api2key，第二十五轮）；
 *  7. 有界后缀迭代剥离（第二十八轮阻断 1，替换第二十六轮单层 versionStripped）：
 *     核心判定拆出 isCredentialShapeCore；外层循环逐层剥除有界后缀 —— 版本
 *     后缀 (version|ver|v)?[0-9]+ 与显式登记的环境后缀白名单
 *     （CREDENTIAL_TRAILING_SUFFIXES：prod/beta/staging/…，绝不贪心剥尾），
 *     每剥一层把余量**重新 tokenize** 再走核心判定（三集合：无边界形态候选表 /
 *     kind 词 / 拉丁根词，另含复合对与 CJK 包含），上限 4 层防呆。apitokenv2
 *     → apitoken（kind-suffix 拆 api|token）、apikeyprod → apikey、
 *     apikeyv2beta → apikeyv2 → apikey（多标签逐层剥）均闭合；apiVersion3 →
 *     api、layout2 → layout、renderPass2 → renderpass 等合法版本键余量不在
 *     任何候选集，放行。版本后缀剥尽后余量恰为 'pass'（pass2/passv2/passver2）
 *     同样拒绝（第二十八轮严重 7：pass2 默认拒绝，如产品确认其为渲染语义可加
 *     BENIGN 白名单显式豁免）。旧 [a-z]*[0-9]+$ 贪心剥尾对全小写形态恒产
 *     空串、是死代码，已废弃；
 *  8. 任意偏移字典分词兜底（第二十九轮阻断 1 + 第三十轮阻断 1 重写）：camelCase
 *     分词无边界时（全小写单 token sessionid/apikeyvalue/passworddigest 等），
 *     第 5/6 项的无边界形态精确相等只覆盖有限派生候选表，枚举不可闭合。对归一
 *     化后的无边界形态（数字剥除）检测任意偏移的连续字典词序列 —— 存在一段
 *     ≥2 个连续字典词、且其中含凭据词段（kind 词/拉丁根词，任意位置）或相邻
 *     复合对/敏感限定组合即拒绝。不再要求整键完整分词：未知业务限定词
 *     （stripe/custom/vendor/legacy/payment 等）不在字典，旧「整键完整分词 +
 *     credentialSeen」判定被其阻断而 fail-open（stripeapikey/customprivatekey/
 *     vendorauthheader/legacysecretkey/paymentsessionid/custompassworddigest
 *     六组探针与 sessionidprod、xsessionid 等未知词缀包裹序列全部泄漏）。
 *     字典 = 既有分类表全部词 + 完成分词所需的最小通用词（id/backup/digest/
 *     payload，全部有凭据语境，逐项可审计）；'board'/'less'/'izer'/'author'/
 *     'render'/'budget'/'mode'/'wrap'/'count' 等过泛词不入字典。单段词不足为凭
 *     （tokenizerConfig 的 token、authorizationMode 的 auth、passwordless 的
 *     password、renderpass 的 pass、keyboard 的 key 均为单段 run，无凭据语境，
 *     放行）—— ≥2 段序列的合法键（apiKeyboardLayout/compassWordWrap/
 *     privateKeyboardShortcuts/accessTokenizerConfig）经 BENIGN_CREDENTIAL_KEYS
 *     整键豁免（第二十三轮严重 5 语义延续，逐项可审计）。长度上限 80 超限即拒
 *     （fail-closed：旧实现超限放行是 81 字符 ...sessionid 泄漏的根源）。
 *     sessionid → session|id、apikeyvalue → api|key|value、clientsecretbackup →
 *     client|secret|backup、stripeapikey → api|key（任意偏移）等全小写复合凭据
 *     键在此闭合。
 *  任意命中即拒绝。tokenizerConfig/tokenizerModel/authorName/authorizationMode/
 *  apiVersion/MONKEYPATCH/HOTKEYMAP/keyboardLayout/shortcutKey 等仅含
 *  tokenizer/author/api/key 等非凭据形态的键放行。连续大写缩写保留为一个
 *  token（APIKey → api|key、PASSWORD → password、API_KEY → api|key，
 *  第十八轮阻断 1）。
 *  凭据形态**公开声明**命中时（顶层字符串声明或路径数组声明，含逐 segment
 *  判定），工程包构建抛 PackageBuildError（code=credential-declaration-rejected，
 *  跨插件聚合列出全部被拒声明）—— 不再静默丢弃（第二十五轮 manifest 显式
 *  校验；第二十八轮阻断 8：manifest 级声明校验 —— 声明即契约，独立于
 *  pluginData 是否有对应命名空间，全部显式公开声明在构建期校验，插件作者
 *  必须看到非法公开声明）；豁免叶键 tokenBudget/authMode 等的声明不受影响
 *  （含 ['profile','tokenBudget'] 等路径声明，其叶键 token 不参与跨 segment
 *  判定）。 */

/** 可审计 benign 契约正向豁免（第二十三轮阻断 2 范式反转）：token/auth 语义
 *  两可的合法公开字段白名单 —— 叶键精确命中即放行。判定对敏感形态默认拒绝，
 *  合法歧义字段必须显式登记于此表（随产品公开契约演进，可审计）。
 *  第二十八轮严重 7 扩展：session/cookie 入 kind 集默认拒绝后，产品确认的
 *  良性歧义键（cookieConsent/cookieSettings/sessionMode，非认证载体语义）
 *  在此显式豁免。第三十轮阻断 1 扩展：任意偏移分词把 ≥2 段连续字典词序列判定
 *  为凭据形态后，apiKeyboardLayout（api|key）、compassWordWrap（word 段）、
 *  privateKeyboardShortcuts（private|key）、accessTokenizerConfig
 *  （access|token）等合法歧义键为保持放行在此整键显式豁免（第二十三轮严重 5
 *  语义延续）。第三十一轮阻断 1 扩展：分词兜底改为「单一高置信 kind/root 命中
 *  即默认拒绝」后，单段 token/auth/password 命中的合法歧义键（tokenizer 系、
 *  authorName、authorizationMode、passwordless，产品契约确认非认证载体语义）
 *  同样逐项登记于此表（精确整键命中才豁免；passwordblob/tokendata/secretconfig
 *  等不在此表的键默认拒绝） */
const BENIGN_CREDENTIAL_KEYS = new Set([
  'tokenBudget',
  'authMode',
  'cookieConsent',
  'cookieSettings',
  'sessionMode',
  'apiKeyboardLayout',
  'compassWordWrap',
  'privateKeyboardShortcuts',
  'accessTokenizerConfig',
  'tokenizerConfig',
  'tokenizerModel',
  'tokenizerConfigModel',
  'authorName',
  'authorizationMode',
  'passwordless',
]);

/** 凭据类词（kind）：作为「语义角色」参与有边界判定 —— 任意 token 位置精确
 *  匹配（含单复数归一）即拒绝（第二十五轮，替代旧「末位 + 纯数字后缀」判定）：
 *  apiToken/tokenValue/tokenHash/apiTokenV2 等 kind 词落任意位均默认拒绝。
 *  token/auth 语义两可（合法字段经 BENIGN_CREDENTIAL_KEYS 豁免），
 *  secret/password/passphrase 等无歧义。key 不入本集（shortcutKey/hotkey 等
 *  合法键以 key 结尾，误伤面过大），X+key 形态由 CREDENTIAL_COMPOUND_PAIRS
 *  闭合。第二十八轮严重 7：session/cookie 是常见认证载体（sessionId/
 *  sessionKey/cookieHeader/setCookie 等），默认拒绝，产品确认的良性歧义键
 *  （sessionMode/cookieConsent/cookieSettings）走 BENIGN 表显式豁免 */
const CREDENTIAL_KIND_WORDS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'auth',
  'session',
  'cookie',
]);

/** 高置信凭据根词（Latin，第二十三轮阻断 2 多语言表）：整词精确匹配（含单复数
 *  归一，绝无子串匹配）—— passwordless 等以凭据词开头的合法复合词不命中
 *  （第二十三轮严重 5 有边界判定）。西语 contraseña 经 NFKD 剥离变音符号
 *  归一（与 caféMode→cafemode 同一管道） */
const CREDENTIAL_LATIN_ROOTS = new Set([
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'secret',
  'credential',
  'credentials',
  'contrasena',
]);

/** 显式 CJK/日文/韩文凭据根词（第二十三轮阻断 2 多语言表）：无词边界语言只能做
 *  归一化后包含匹配 —— 仅凭据语义词入库（密碼/秘钥/パスワード 为实测泄漏词；
 *  キー/key 因キーボード 等合法词误伤不入表）。第二十八轮阻断 1 扩展：繁体
 *  私鑰/秘密鍵、日文認証トークン/アクセストークン/資格情報、韩文
 *  비밀번호/토큰/시크릿/자격증명 入库；韩文 암호（密碼）特意不入表 ——
 *  암호화=encryption 是高频合法词，包含匹配会误伤 */
const CREDENTIAL_CJK_ROOTS = [
  '密码',
  '密碼',
  '口令',
  '令牌',
  '密钥',
  '秘钥',
  '凭据',
  '私钥',
  '私鑰',
  'パスワード',
  'パスフレーズ',
  'シークレット',
  '秘密鍵',
  '認証トークン',
  'アクセストークン',
  '資格情報',
  '비밀번호',
  '토큰',
  '시크릿',
  '자격증명',
];

const CREDENTIAL_COMPOUND_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['api', 'key'],
  ['pass', 'word'],
  ['pass', 'key'],
  ['private', 'key'],
  ['auth', 'key'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['bearer', 'token'],
  ['oauth', 'token'],
  ['session', 'token'],
  ['client', 'secret'],
  ['stored', 'password'],
  ['auth', 'header'],
  ['private', 'setting'],
  ['secret', 'key'],
  ['token', 'value'],
  ['password', 'hash'],
  ['token', 'hash'],
  ['password', 'value'],
];

/** 明确敏感限定组合（限定词 + 高置信词）：用于无边界复合形态候选派生 ——
 *  databasePassword/jwtSecret/webhookSecret/userCredentials/secretValue 的
 *  全小写连写（databasepassword/jwtsecret/webhooksecret/usercredentials/
 *  secretvalue）不得因解析成单 token 而绕过 */
const CREDENTIAL_SENSITIVE_COMBOS: ReadonlyArray<readonly [string, string]> = [
  ['jwt', 'secret'],
  ['webhook', 'secret'],
  ['user', 'credentials'],
  ['secret', 'value'],
];

/** 无边界复合形态候选（第二十一轮阻断 1 + 第二十三轮严重 5）：由复合对拼接与
 *  敏感限定组合派生的合法外键形态表。匹配为整键规范化后精确相等（Set.has，
 *  绝无子串 includes）—— accessTokenizerConfig/accesstokenizerconfig 不再
 *  误中 accesstoken；authheader/privatesetting/secretvalue 等连写仍闭合。
 *  复数变体一并派生（apikeys/secretkeys/authheaders/privatesettings 等无分隔
 *  复数连写与单数形态同判据闭合，全部精确相等、逐项可审计） */
const CREDENTIAL_COLLAPSED_FORMS: ReadonlySet<string> = (() => {
  const forms = new Set<string>();
  for (const [a, b] of CREDENTIAL_COMPOUND_PAIRS) forms.add(a + b);
  for (const [a, b] of CREDENTIAL_SENSITIVE_COMBOS) forms.add(a + b);
  for (const form of [...forms]) forms.add(`${form}s`);
  return forms;
})();

/** Unicode Default Ignorable 码点区间（UAX #44 PropList）：零宽字符（U+200B
 *  ZWSP/U+200C ZWNJ/U+200D ZWJ 等）、变体选择符（U+FE00-U+FE0F，含 U+FE0F
 *  VS16）、连字/不可见格式符等 —— 视觉上无痕迹，可插入任意文本而不被察觉。
 *  第三十四轮阻断 2：CJK 凭据根匹配前必须剥除 —— '密\u200b码' 含 ZWSP 时
 *  NFKC 后不包含 '密码'，零宽字符注入即绕过根检查（配合折叠值 BENIGN 豁免
 *  碰撞可让凭据值进包）。按区间表逐码点过滤（不依赖控制字符正则） */
const DEFAULT_IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

function isDefaultIgnorable(code: number): boolean {
  for (const [lo, hi] of DEFAULT_IGNORABLE_RANGES) {
    if (code < lo) return false;
    if (code <= hi) return true;
  }
  return false;
}

/** 剥除 Unicode Default Ignorable 字符（第三十四轮阻断 2）：逐码点过滤 */
function stripDefaultIgnorables(key: string): string {
  let out = '';
  for (const ch of key) {
    const code = ch.codePointAt(0)!;
    if (!isDefaultIgnorable(code)) out += ch;
  }
  return out;
}

/** CJK/日文凭据根词包含判定：仅 NFKC（不 NFKD）—— 日文清浊音（パ/バ/ド 等）
 *  是独立码点，NFKD 会把パ分解为ハ+浊点（U+3099），破坏与预组合词
 *  （パスワード 等）的包含匹配；Latin 变音符号才需要 NFKD+剥离管道。
 *  第三十四轮阻断 2：NFKC 后先剥 Default Ignorable 再匹配 —— 零宽字符
 *  （U+200B/U+FE0F）注入的 '密\u200b码' 恢复为 '密码' 后命中，注入无法绕过 */
function containsCredentialCjkRoot(key: string): boolean {
  const nfkc = stripDefaultIgnorables(key.normalize('NFKC'));
  for (const word of CREDENTIAL_CJK_ROOTS) {
    if (nfkc.includes(word)) return true;
  }
  return false;
}

/** 凭据判定归一化管道：NFKC（全角/兼容字符）→ NFKD + 剥离组合变音符号
 *  （contraseña→contrasena、caféMode→cafemode）→ 小写。CJK/日文不受影响 */
function normalizeCredentialKey(key: string): string {
  return key
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** 无边界规范化：归一化 + 去分隔符 —— 全小写/全大写/全角/分隔符变体收敛到
 *  同一无边界形态，供派生候选精确相等匹配。第三十五轮阻断 2：只剥可打印分隔符，
 *  C0/C1/DEL 控制字符保留（含控制字符的形态无法命中纯 ASCII 白名单精确项，
 *  fail-closed，不再有 'token<NUL>izerConfig' → 'tokenizerconfig' 的收敛） */
function collapsedCredentialForm(key: string): string {
  const normalized = normalizeCredentialKey(key);
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0)!;
    const isAlnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isAlnum || isControl) out += ch;
  }
  return out;
}

/** BENIGN 白名单判定专用规范化（第三十三轮阻断 1）：NFKC（全角/兼容字符归
 *  一，全角空格→ASCII 空格）→ 小写 → 去分隔符。与 collapsedCredentialForm 的
 *  关键区别：**不丢弃非 ASCII 内容** —— 修复前 collapsed 的 [^a-z0-9] 把
 *  CJK/日/韩凭据根词一并剥除，'密码tokenizerConfig' → 'tokenizerconfig' 与
 *  良性键碰撞而放行（值进包）。白名单是精确豁免：只允许「ASCII 写法 +
 *  NFKC/大小写/分隔等价」，任何含非 ASCII 内容的键形态保留内容后无法与纯
 *  ASCII 白名单条目相等；全角『；』等 NFKC 转 ASCII 的兼容分隔符仍正确剥除 */
function benignCredentialForm(key: string): string {
  const nfkc = key.normalize('NFKC').toLowerCase();
  // 只剥可打印 ASCII 分隔符与 NBSP（NFKC 不转 NBSP；全角空格经 NFKC 已转
  // ASCII 空格后一并剥除）。C0/C1/DEL 控制字符与全部非 ASCII 内容保留 ——
  // 第三十五轮阻断 2：'token<NUL>izerConfig' 保留控制字符后无法与纯 ASCII
  // 白名单精确相等，fail-closed（逐码点过滤，避免控制字符正则）
  let out = '';
  for (const ch of nfkc) {
    const code = ch.codePointAt(0)!;
    if (code === 0xa0) continue;
    if (code >= 0x20 && code < 0x7f && !(ch >= 'a' && ch <= 'z') && !(ch >= '0' && ch <= '9')) continue;
    out += ch;
  }
  return out;
}

/** 完整凭据词匹配（含单复数归一）：token 与基准词相等，或 token 是规则复数
 *  （词尾 -s，长度 > 3）剥尾后与基准词相等（tokens→token、secrets→secret、
 *  passwords→password、credentials→credential）。直接相等优先：pass/access
 *  等以 -s 结尾的基词本身若先做剥尾（pass→pas、access→acces）会错过
 *  pass+word、access+token 等复合序列（第十八轮修复）。 */
function matchesCredentialWord(token: string, base: string): boolean {
  if (token === base) return true;
  return token.length > 3 && token.endsWith('s') && token.slice(0, -1) === base;
}

function isCredentialKindWord(token: string): boolean {
  for (const kind of CREDENTIAL_KIND_WORDS) {
    if (matchesCredentialWord(token, kind)) return true;
  }
  return false;
}

/** camelCase/缩写分词：非字母数字分隔符切段后，每段按大写边界切分
 *  （连续大写缩写整体保留：APIKey → API|Key、PASSWORD → PASSWORD）。
 *  变音符号先经 NFKD 剥离（contraseña→contrasena、caféMode→cafemode）。 */
function credentialTokens(key: string): string[] {
  const stripped = key.normalize('NFKC').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return stripped
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((segment) => segment.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[0-9]+|[A-Z]+/g) ?? [])
    .map((word) => word.toLowerCase());
}

/** kind-suffix 扩展（第二十三轮阻断 2 闭合规则）：token 以凭据类词（含复数形）
 *  结尾（词长大于 kind）时按该词拆分 —— clientsecret/storedpassword/
 *  bearertoken/databasepassword/usercredentials/secretkey 等无边界连写不再
 *  需要枚举全部限定词。有边界判定：passwordless（-less 结尾）、keyboard
 *  （key 为前缀非后缀）、tokenizer（-nizer 结尾）不拆分 */
function expandKindSuffixTokens(tokens: string[]): string[] {
  const expanded = [...tokens];
  for (const token of tokens) {
    for (const kind of CREDENTIAL_KIND_WORDS) {
      const plural = kind.endsWith('s') ? kind : `${kind}s`;
      if (token.length > kind.length && token.endsWith(kind)) {
        expanded.push(token.slice(0, token.length - kind.length), kind);
        break;
      }
      if (token.length > plural.length && token.endsWith(plural)) {
        expanded.push(token.slice(0, token.length - plural.length), plural);
        break;
      }
    }
  }
  return expanded;
}

/** 分词字典（第二十九轮阻断 1）：既有分类表全部词 + 完成全小写复合凭据键分词
 *  所需的最小通用词。'pass' 只在复合对语境（pass+word/pass+key）有意义，作为
 *  通用词入字典会让 renderpass 等误分词 —— 不入表；'board'/'less'/'izer'/
 *  'author'/'render'/'budget'/'mode'/'wrap'/'count' 等合法键完成词同理不入表，
 *  保证 passwordless/apiKeyboardLayout/accessTokenizerConfig/tokenBudget/
 *  renderPass 等无完整凭据分词。 */
const CREDENTIAL_SEGMENT_DICT: ReadonlySet<string> = (() => {
  const words = new Set<string>();
  for (const kind of CREDENTIAL_KIND_WORDS) words.add(kind);
  for (const root of CREDENTIAL_LATIN_ROOTS) words.add(root);
  for (const [a, b] of CREDENTIAL_COMPOUND_PAIRS) {
    words.add(a);
    words.add(b);
  }
  for (const [a, b] of CREDENTIAL_SENSITIVE_COMBOS) {
    words.add(a);
    words.add(b);
  }
  for (const general of ['id', 'backup', 'digest', 'payload']) words.add(general);
  return words;
})();

/** 分词长度上限（第三十轮阻断 1 改 fail-closed）：超限一律按凭据形态拒绝 ——
 *  防御病态长键撑爆 DP 状态，且绝不因长度放行（旧实现 length>80 直接放行，
 *  是 81 字符 ...sessionid 泄漏的根源） */
const CREDENTIAL_SEGMENT_MAX_LENGTH = 80;

/** 后缀剥除防御上限（第三十一轮阻断 1）：单调剥除达到此层仍未稳定（无后缀可
 *  剥）即 fail-closed 拒绝 —— 病态超长后缀链绝不因「剥不干净」放行；正常键
 *  （apikeyv2beta 等 2~3 层）远低于上限，'pass' 残余闭合路径在 12 层内必达 */
const CREDENTIAL_SUFFIX_STRIP_MAX = 12;

/** BENIGN 键的无边界形态豁免（第三十轮阻断 1）：路径数组声明跨 segment 拼接
 *  （['access','tokenizer','config'] ≡ accesstokenizerconfig）与全小写变体经
 *  同一契约放行 —— 整键命中 BENIGN_CREDENTIAL_KEYS 的合法歧义键，其无边界形态
 *  在分词兜底中一并豁免（apiKeyboardLayout/compassWordWrap 等 ≥2 段序列的合法
 *  键路径声明与字符串声明等价）。第三十三轮阻断 1：集合以 benignCredentialForm
 *  构建 —— 不丢弃非 ASCII 内容的独立规范化（白名单键全为 ASCII，对纯 ASCII
 *  键与旧 collapsed 结果一致；含非 ASCII 的键形态不可能命中集合） */
const BENIGN_CREDENTIAL_COLLAPSED: ReadonlySet<string> = (() => {
  const forms = new Set<string>();
  for (const key of BENIGN_CREDENTIAL_KEYS) forms.add(benignCredentialForm(key));
  return forms;
})();

/** 良性凭据歧义键判定（第三十二轮严重 3 统一规范化 + 第三十三轮阻断 1 加固）：
 * 所有判定位置（顶层整键、joined 整键、嵌套叶键、拆分后缀）一律查规范化集合
 *  —— 顶层 'TOKENIZERCONFIG'、叶 ['profile','TOKENIZERCONFIG']、根
 *  ['tokenizer','config'] 与嵌套拆分 ['profile','tokenizer','config'] 是同一良性
 *  键的不同写法，判定必须一致（第三十二轮修复前顶层/叶用大小写敏感原始
 *  Set.has、joined 用规范化集合，同一键因写法不同放行/拒绝分叉：根
 *  ['cookie','consent'] 与顶层 'cookieconsent' 即同键异判的实例）。
 *  第三十三轮阻断 1 双保险：任何 BENIGN 短路前先执行 CJK/日/韩凭据根检查 ——
 *  规范化层面已不丢弃非 ASCII（'密码tokenizerConfig' → '密码tokenizerconfig'
 *  无法与 ASCII 白名单条目碰撞），根检查再加一道显式防线：含凭据根的键无论
 *  形态如何一律不豁免，杜绝未来规范化调整再次引入碰撞（修复前
 *  '密码tokenizerConfig'/'パスワードauthMode' 等剥非 ASCII 后命中集合被放行，
 *  凭据值随公开声明进包） */
function isBenignCredentialKey(key: string): boolean {
  if (containsCredentialCjkRoot(key)) return false;
  return BENIGN_CREDENTIAL_COLLAPSED.has(benignCredentialForm(key));
}

/** 任意偏移字典分词凭据形态兜底（第二十九轮阻断 1 + 第三十轮阻断 1 重写 +
 *  第三十一轮阻断 1 改单命中默认拒绝）：
 *  对无边界形态（数字已剥除）检测任意偏移的连续字典词序列 —— 序列中任一凭据
 *  词段（kind 词/拉丁根词，任意位置）或相邻复合对/敏感限定组合命中即拒绝。
 *  不要求整键完整分词：未知业务限定词（stripe/custom/vendor/legacy/payment
 *  等）不在字典，旧「整键完整分词 + credentialSeen」判定被其阻断而 fail-open
 *  （stripeapikey 等六组探针泄漏）；第三十轮的「≥2 段连续词序列」阈值仍被
 *  非字典尾词阻断而 fail-open（passwordblob/tokendata/secretconfig/
 *  sessionhandle/cookiejar 等「单高置信段 + 未知词」形态泄漏，审查员第三十一轮
 *  阻断 1）—— 单一高置信命中即默认拒绝。合法歧义键的 token/auth/password
 *  单段（tokenizerConfig/authorizationMode/passwordless 等）全部经
 *  BENIGN_CREDENTIAL_KEYS 整键精确豁免（无边界形态见 BENIGN_CREDENTIAL_COLLAPSED，
 *  路径数组拼接 ≡ 字符串声明同表放行）。
 *  每位置取最长字典词（pass|word 重叠于 password 时取 password —— 复合对子分词
 *  不构成独立凭据序列；password 等真 pass+word 连写仍闭合）。复数段经
 *  matchesCredentialWord 归一（clientsecrets → client|secrets）。长度上限超限
 *  即拒（fail-closed）。 */
function hasCredentialSegmentation(collapsed: string): boolean {
  // 第三十四轮阻断 2：折叠值（collapsedCredentialForm 已剥除全部非 ASCII）不
  // 得再做 BENIGN 豁免 —— 传入本函数的键已经历规范化折叠，原文丢失：'密\u200b码
  // tokenizerConfig' 折叠为 'tokenizerconfig' 后命中白名单而放行（修复前
  // 正是此短路让零宽字符注入的凭据根键绕过；白名单精确豁免只在仍持有原始
  // 字符串的入口执行 —— isCredentialShapeKey / buildExportTrie 的原始段拼接）
  if (collapsed.length > CREDENTIAL_SEGMENT_MAX_LENGTH) return true;
  if (collapsed.length === 0) return false;
  const isDictWord = (w: string): boolean =>
    CREDENTIAL_SEGMENT_DICT.has(w) ||
    (w.length > 3 && w.endsWith('s') && CREDENTIAL_SEGMENT_DICT.has(w.slice(0, -1)));
  const isCredentialSegment = (w: string): boolean => {
    if (isCredentialKindWord(w)) return true;
    for (const root of CREDENTIAL_LATIN_ROOTS) {
      if (matchesCredentialWord(w, root)) return true;
    }
    return false;
  };
  const isCredentialAdjacentPair = (a: string, b: string): boolean => {
    for (const [x, y] of CREDENTIAL_COMPOUND_PAIRS) {
      if (matchesCredentialWord(a, x) && matchesCredentialWord(b, y)) return true;
    }
    for (const [x, y] of CREDENTIAL_SENSITIVE_COMBOS) {
      if (matchesCredentialWord(a, x) && matchesCredentialWord(b, y)) return true;
    }
    return false;
  };
  // 任意偏移 + 最长字典词优先：每个起点沿唯一路径推进（无分支，无需 memo），
  // 任一凭据词段/相邻复合对命中即拒绝；80 字符上限封顶开销
  const n = collapsed.length;
  for (let start = 0; start < n; start += 1) {
    let pos = start;
    let prev: string | null = null;
    while (pos < n) {
      let best = '';
      for (let end = n; end > pos; end -= 1) {
        const w = collapsed.slice(pos, end);
        if (isDictWord(w)) {
          best = w;
          break;
        }
      }
      if (best === '') break;
      if (prev !== null && isCredentialAdjacentPair(prev, best)) return true;
      if (isCredentialSegment(best)) return true;
      prev = best;
      pos += best.length;
    }
  }
  return false;
}

/** 凭据形态核心判定（第二十八轮阻断 1 拆分）：对完整 token 列表做凭据形态判定
 *  （单键与路径声明共用；路径跨 segment 拼接后复用同一判定，['api','key'] ≡
 *  'apikey' ≡ api_key，第十九轮阻断 2）。只含无后缀形态 —— CJK 包含 / kind
 *  词 / 拉丁根词 / 相邻复合对 / 无边界形态精确相等（含数字剥除）/ 字典分词
 *  兜底（第二十九轮阻断 1）。
 *  第二十三轮范式反转：默认拒绝敏感形态 + 正向豁免（BENIGN_CREDENTIAL_KEYS），
 *  全部规则有边界（详见模块注释）。 */
function isCredentialShapeCore(joined: string, tokens: string[]): boolean {
  // 无词边界语言（CJK/日文/韩文）凭据根词：NFKC 后包含即拒绝；主题/caféMode 等
  // 合法非 ASCII 键不再因 blanket fail-closed 被误删
  if (containsCredentialCjkRoot(joined)) return true;
  // kind-suffix 扩展后逐 token 做凭据类词与高置信根词精确匹配（含单复数归一）。
  // kind 词任意 token 位置命中即拒绝（第二十五轮）：X+kind+Y 形态
  // （tokenValue/tokenHash/apiTokenV2）kind 词落中间位同样闭合 —— 替代旧的
  // 「末位 kind + 纯数字后缀」判定；tokenizerConfig/authorizationMode/
  // renderPass 等以词边界精确匹配不误伤。tokenBudget/authMode 等豁免叶键在
  // 调用方放行（跨 segment 判定剥离豁免叶键的 token，见 buildExportTrie），
  // 此处不会因歧义词产生误拒
  const expanded = expandKindSuffixTokens(tokens);
  for (const token of expanded) {
    if (isCredentialKindWord(token)) return true;
    for (const root of CREDENTIAL_LATIN_ROOTS) {
      if (matchesCredentialWord(token, root)) return true;
    }
  }
  // 相邻复合对（api+key/pass+word/secret+key 等）：无 kind 结尾的明确凭据序列
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1];
    for (const [x, y] of CREDENTIAL_COMPOUND_PAIRS) {
      if (matchesCredentialWord(a, x) && matchesCredentialWord(b, y)) return true;
    }
  }
  // 无边界复合形态：整键规范化后精确相等（绝不子串 includes，第二十三轮严重 5）
  const collapsed = collapsedCredentialForm(joined);
  if (CREDENTIAL_COLLAPSED_FORMS.has(collapsed)) return true;
  // 第二十五轮：复合对 + 数字后缀变体 —— 剥掉数字（含词中）后仍命中候选表
  // 即拒绝（apikey2/authkey2/accesstoken2/api2key）
  const digitless = collapsed.replace(/[0-9]+/g, '');
  if (digitless.length > 0 && CREDENTIAL_COLLAPSED_FORMS.has(digitless)) return true;
  // 第二十九轮阻断 1：字典分词兜底 —— 有限候选表枚举不可闭合（全小写单 token
  // sessionid/apikeyvalue/passworddigest/clientsecretbackup 等），任一完整分词
  // 含凭据形态即拒绝；合法键无完整凭据分词自然放行
  return hasCredentialSegmentation(digitless);
}

/** 环境后缀白名单（第二十八轮阻断 1）：凭据键可能带环境限定标签（apikeyprod/
 *  apikeyv2beta）。仅剥离显式登记的后缀，绝不贪心剥尾（旧 [a-z]*[0-9]+$ 对
 *  全小写形态恒产空串、是死代码）。按长度降序排列保证最长匹配优先 ——
 *  'latest' 以 'test' 结尾、'staging' 以 'stage' 结尾，若 'test'/'stage' 在前
 *  会先剥出错误余量；'preprod' 须在 'prod' 前 */
const CREDENTIAL_TRAILING_SUFFIXES = [
  'production',
  'development',
  'staging',
  'preview',
  'canary',
  'internal',
  'sandbox',
  'release',
  'stable',
  'latest',
  'master',
  'main',
  'example',
  'sample',
  'demo',
  'stage',
  'preprod',
  'test',
  'prod',
  'dev',
  'qa',
  'live',
  'beta',
  'alpha',
  'rc',
  'new',
  'old',
];

/** 剥除一层有界后缀（第二十八轮阻断 1）：先版本后缀 (version|ver|v)?[0-9]+
 *  （apikeyv2/secretver3/tokenversion1），无变化再查环境后缀白名单
 *  （apikeyprod/apikeyv2beta）。长度守卫（余量长度 > 后缀长度）保证整词
 *  'beta'/'prod' 等本身不被剥空。剥不动返回 null */
function stripOneCredentialSuffix(collapsed: string): string | null {
  const versionStripped = collapsed.replace(/(?:version|ver|v)?[0-9]+$/, '');
  if (versionStripped !== collapsed) {
    return versionStripped.length > 0 ? versionStripped : null;
  }
  for (const suffix of CREDENTIAL_TRAILING_SUFFIXES) {
    if (collapsed.length > suffix.length && collapsed.endsWith(suffix)) {
      return collapsed.slice(0, collapsed.length - suffix.length);
    }
  }
  return null;
}

/** 凭据形态判定入口（第二十八轮阻断 1 + 第三十一轮阻断 1 改单调剥除）：先走
 *  核心判定，再逐层剥除有界后缀（版本 + 环境白名单），每剥一层把余量**重新
 *  tokenize** 再走核心判定 —— apitokenv2 → apitoken（kind-suffix 拆 api|token
 *  命中）、apikeyprod → apikey（复合表）、apikeyv2beta → apikeyv2 → apikey
 *  （多标签逐层剥）。
 *  单调剥除直至稳定（无后缀可剥）：固定 4 层上限对「pass + 5 层以上环境后缀」
 *  （passprodprodprodprodprod，'pass' 单段非凭据形态、核心判定不命中）仍
 *  fail-open（剥 4 层剩 passprod 放行）—— 逐层剥到余量恰为 'pass' 才闭合；
 *  达到防御上限仍未稳定（病态超长后缀链）一律拒绝（fail-closed，绝不因
 *  「剥不干净」放行）。版本后缀剥尽后余量恰为 'pass'（pass2/passv2/passver2）
 *  默认拒绝 —— 裸 'pass'（['render','pass'] 路径）与 'passCount' 等合法形态
 *  不受影响，产品若确认 pass2 为渲染语义可经 BENIGN_CREDENTIAL_KEYS 显式豁免 */
function isCredentialShapeTokens(joined: string, tokens: string[]): boolean {
  if (isCredentialShapeCore(joined, tokens)) return true;
  let collapsed = collapsedCredentialForm(joined);
  let stable = false;
  for (let depth = 0; depth < CREDENTIAL_SUFFIX_STRIP_MAX; depth += 1) {
    const next = stripOneCredentialSuffix(collapsed);
    if (next === null || next === collapsed) {
      stable = true;
      break;
    }
    collapsed = next;
    if (collapsed === 'pass') return true;
    if (isCredentialShapeCore(collapsed, credentialTokens(collapsed))) return true;
  }
  if (!stable) {
    // 第三十二轮一般 5：预算耗尽前最后一次剥除可能恰好剥到稳定安全基键
    // （第 CREDENTIAL_SUFFIX_STRIP_MAX 层剥除到达基键，stable 标志未及置位）
    // —— 耗尽预算后再探测一次：已无可剥后缀则按当前余量正常放行（修复前
    // 一律按 stable=false 误拒，theme+prod×12 明明剥到 'theme' 仍被拒绝）；
    // 仍可剥（真病态超长后缀链，预算内剥不完）fail-closed 拒绝
    const next = stripOneCredentialSuffix(collapsed);
    if (next === null || next === collapsed) return false;
    return true;
  }
  return false;
}

function isCredentialShapeKey(key: string): boolean {
  if (isBenignCredentialKey(key)) return false;
  return isCredentialShapeTokens(key, credentialTokens(key));
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
 *  privateSettings 重叠时整条声明拒绝（静默 fail-closed）；凭据形态判定以完整
 *  路径统一 token 化执行（跨 segment 相邻序列，第十九轮阻断 2）—— 命中即整条
 *  声明拒绝并记入 rejections（第二十五轮：构建校验失败，不再静默丢弃 ——
 *  插件作者必须看到自己的公开声明被拒）。 */
function buildExportTrie(
  declarations: readonly (string | readonly string[])[],
  privateKeys: readonly string[],
  rejections: Array<{ plugin: string; path: string }>,
  plugin: string,
): ExportTrie | null {
  const root: ExportTrie = new Map();
  for (const declaration of declarations) {
    if (typeof declaration === 'string') {
      // 第三十五轮阻断 2：含 C0/C1/DEL 控制字符的声明一律显式拒绝（带路径明细）
      // —— 旧规范化管道把 NUL/TAB 当分隔符剥除，'token<NUL>izerConfig' 收敛后
      // 命中 BENIGN 白名单放行、凭据值进包；控制字符键在声明入口统一拒绝
      if (hasControlCharacter(declaration)) {
        rejections.push({ plugin, path: JSON.stringify(declaration) });
        continue;
      }
      if (isCredentialShapeKey(declaration)) {
        rejections.push({ plugin, path: JSON.stringify(declaration) });
        continue;
      }
      if (!isSafeExportKey(declaration) || privateKeys.includes(declaration)) continue;
      root.set(declaration, 'leaf');
      continue;
    }
    if (!Array.isArray(declaration) || declaration.length === 0) continue; // 畸形/空路径：忽略
    // 第三十五轮阻断 2：任一段含控制字符即整条路径显式拒绝（覆盖拆分路径
    // ['profile','token<NUL>izerConfig'] 与 ['profile','token<NUL>izer','config']）
    if (declaration.some((segment) => typeof segment === 'string' && hasControlCharacter(segment))) {
      rejections.push({ plugin, path: JSON.stringify(declaration) });
      continue;
    }
    const joinedPath = declaration.join('');
    // 第三十二轮严重 3：良性豁免统一为「末尾段序列（规范化 joined）命中良性
    // 集合」的最长后缀识别 —— 整键（['tokenizer','config'] ≡ tokenizerConfig）、
    // 叶键（['profile','tokenizerConfig']）与嵌套拆分（['profile','tokenizer',
    // 'config'] ≡ ['profile','tokenizerConfig']）同一判据；大小写经
    // isBenignCredentialKey 归一（'TOKENIZERCONFIG' ≡ 'tokenizerConfig'）。
    // 命中后该良性键自身的 token 不参与任何凭据判定 —— 修复前整键豁免只短路
    // 逐段 standalone 判定，else 分支的 joined/perSegment 检查仍命中 kind 词
    // （根 ['cookie','consent'] 与顶层 'cookieconsent' 同一键异判：顶层放行、
    // 路径拒绝）；只对前缀执行统一判据（第二十五轮语义保留：豁免键的 kind 词
    // 不触发跨 segment 命中，前缀独立判定）。良性整键的安全键/私键逐段校验
    // 仍由下方 trie 构建循环执行
    let benignSuffixLen = 0;
    const maxSuffix = Math.min(declaration.length, 3); // 良性键至多拆 3 段
    for (let i = maxSuffix; i >= 1; i -= 1) {
      const suffix = declaration.slice(-i);
      if (suffix.every((s) => typeof s === 'string') && isBenignCredentialKey(suffix.join(''))) {
        benignSuffixLen = i;
        break;
      }
    }
    if (benignSuffixLen === 0) {
      // 第二十三轮阻断 3：先对每个 segment/叶键做上下文判定（segment 独立成键时
      // 的凭据形态，含豁免表 —— ['profile','token']/['profile','auth'] 的裸
      // token/auth segment 不再被「整条路径 token 总数」稀释，逐段判定即拒绝），
      // 再执行跨 segment 组合检查。第十九轮阻断 2：跨 segment 相邻序列与无边界
      // 连写（['api','key'] ≡ api_key、['client','secret'] ≡ clientsecret）由
      // joined 判定闭合 —— 两种 token 化缺一不可：全小写 segment 拼接会合并成
      // 一个 token（'private'+'setting' → privatesetting，逐段 flatMap 保边界）；
      // 而跨 segment 的 camelCase 边界（'ap'+'iKey' → apiKey）只有整串拼接才能还原
      if (
        declaration.some((segment) => typeof segment === 'string' && isCredentialShapeKey(segment))
      ) {
        rejections.push({ plugin, path: JSON.stringify(declaration) });
        continue;
      }
      const perSegmentTokens = declaration.flatMap((segment) => credentialTokens(segment));
      if (
        isCredentialShapeTokens(joinedPath, credentialTokens(joinedPath)) ||
        isCredentialShapeTokens(joinedPath, perSegmentTokens)
      ) {
        rejections.push({ plugin, path: JSON.stringify(declaration) });
        continue;
      }
    } else {
      // 第二十五轮：豁免键的 token 不参与跨 segment 判定 ——
      // ['profile','tokenBudget'] 的 kind 词（token）落中间位不得触发 kind
      // 任意位置拒绝；段内 kind 词已被逐 segment standalone 判定覆盖（segment
      // 为裸 kind 词时上面已拒绝）。豁免键只做前缀序列判定：joined 重分词会把
      // 'profile'+'tokenBudget' 的边界抹掉还原成 'profiletoken'（kind-suffix
      // 扩展拆出 token）误拒；前缀本身按统一判据判定（kind/复合对/无边界形态/
      // 数字后缀变体全覆盖），合法歧义字段继续走 BENIGN_CREDENTIAL_KEYS 显式豁免
      const prefix = declaration.slice(0, -benignSuffixLen);
      const prefixJoined = prefix.join('');
      const prefixTokens = prefix.flatMap((segment) => credentialTokens(segment));
      if (
        isCredentialShapeTokens(prefixJoined, credentialTokens(prefixJoined)) ||
        isCredentialShapeTokens(prefixJoined, prefixTokens)
      ) {
        rejections.push({ plugin, path: JSON.stringify(declaration) });
        continue;
      }
    }
    let node = root;
    let rejected = false;
    for (let i = 0; i < declaration.length; i += 1) {
      const key = declaration[i];
      if (typeof key !== 'string' || !isSafeExportKey(key) || privateKeys.includes(key)) {
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
  plugin: string,
  rejections: Array<{ plugin: string; path: string }>,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const trie = buildExportTrie(declarations, privateKeys, rejections, plugin);
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
 * - 声明与 manifest.privateSettings（privateKeysByPlugin 原样传入）重叠 →
 *   整条声明拒绝（静默）；声明路径含凭据形态键（apiKey/password/token/
 *   secret/…）→ 整条声明拒绝并记录 —— 存在任一被拒声明时本次构建抛
 *   PackageBuildError（code=credential-declaration-rejected，跨插件聚合列出
 *   全部被拒声明，第二十五轮：不再静默丢弃，「凭据永不导出」不依赖插件自觉
 *   声明，插件作者必须看到自己的公开声明被拒）；
 * - 整值声明仅允许 primitive 叶值：对象/数组整值导出被强制递归投影拒绝。
 * 第二十八轮阻断 8：凭据校验升级为 manifest 级 —— 先遍历 publicKeysByPlugin
 * 全部显式声明做构建期校验（声明即契约，独立于 pluginData 是否有对应命名
 * 空间，插件作者必须看到非法公开声明），再做现有数据投影。
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
  const rejections: Array<{ plugin: string; path: string }> = [];
  // 第二十八轮阻断 8：manifest 级声明校验 —— 声明即契约，独立于 pluginData
  // 是否有对应命名空间。先遍历全部显式公开声明做凭据形态校验（buildExportTrie
  // 聚合拒绝），插件作者必须看到非法公开声明；不能因项目尚无该插件数据而绕过
  // 构建期校验（旧实现只按 pluginData 现有命名空间遍历，声明了凭据键但无数据
  // 的插件可以静默构建成功）
  for (const instanceId of Object.keys(publicKeysByPlugin)) {
    if (instanceId === '__proto__') continue;
    const declarations = publicKeysByPlugin[instanceId];
    if (!Array.isArray(declarations) || declarations.length === 0) continue;
    const privateKeys =
      privateKeysByPlugin && Array.isArray(privateKeysByPlugin[instanceId]) ? privateKeysByPlugin[instanceId] : [];
    buildExportTrie(declarations, privateKeys, rejections, instanceId);
  }
  if (rejections.length > 0) {
    throw new PackageBuildError(
      'credential-declaration-rejected',
      `${rejections.length} 条公开声明命中凭据形态键，工程包构建失败（凭据永不导出）：` +
        rejections.map((r) => `${r.plugin} ${r.path}`).join('；') +
        '。请将凭据移出公开设置或改走安全通道后重试。',
      rejections,
    );
  }
  const out: Record<string, unknown> = {};
  for (const instanceId of Object.keys(pluginData)) {
    if (instanceId === '__proto__' || !Object.hasOwn(publicKeysByPlugin, instanceId)) continue;
    const declarations = publicKeysByPlugin[instanceId];
    if (!Array.isArray(declarations) || declarations.length === 0) continue;
    const privateKeys =
      privateKeysByPlugin && Array.isArray(privateKeysByPlugin[instanceId]) ? privateKeysByPlugin[instanceId] : [];
    const read = readOwnDataField(pluginData, instanceId);
    if (!read.present) continue;
    // manifest 级校验已保证 rejections 为空；此处沿用投影路径的校验签名
    const projected = applyPublicPluginData(read.value, declarations, privateKeys, instanceId, rejections);
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
    // 第二十九轮阻断 2：manifest 级声明校验无条件先行 —— 声明即契约，独立于
    // pluginData 是否有数据/形态（缺失、undefined、非普通对象同样校验）：
    // 插件作者必须看到非法公开声明被拒，不能因项目尚无该插件数据而绕过
    // 构建期校验（修复前校验被夹在 isPlainRecord 门内，声明凭据键但 pluginData
    // 缺失/畸形时可静默构建成功）。数据投影只在 pluginData 为普通对象时进行；
    // 无数据时无导出（pluginData 键整体不进包）
    const read = readOwnDataField(project, 'pluginData');
    // 直接以源为投影输入（不再浅展开 —— 展开会执行命名空间层的 getter，
    // 第十五轮一般 6）：投影只读源、在新对象上构建，绝不修改源项目对象；
    // 全部命名空间被排除（无任何已注册插件或声明）时 pluginData 键整体不进包
    const data = read.present && read.value !== undefined && isPlainRecord(read.value) ? read.value : undefined;
    const projected = projectPublicPluginData(data ?? {}, options.publicKeysByPlugin, options.privateKeysByPlugin);
    if (projected) stripped.pluginData = projected;
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
  // 每层 DTO 契约投影（scenes/objects/tracks/shots 与 settings 同一机制）
  if (Array.isArray(stripped.scenes)) stripped.scenes = stripped.scenes.map((scene) => projectDto(scene, PUBLIC_SCENE_FIELDS));
  if (Array.isArray(stripped.objects)) stripped.objects = stripped.objects.map((object) => projectObjectDto(object));
  if (Array.isArray(stripped.tracks)) stripped.tracks = stripped.tracks.map((track) => projectTrackDto(track));
  if (Array.isArray(stripped.shots)) stripped.shots = stripped.shots.map((shot) => projectDto(shot, PUBLIC_SHOT_FIELDS));

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
