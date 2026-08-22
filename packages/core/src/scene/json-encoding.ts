/**
 * 严格 JSON-value 编码边界（第六轮 #5）：core 唯一负责「数据图能否无损 JSON 编码」
 * 的判定，本地存储（IndexedDB/OPFS 契约一致）与工程包导出共用同一函数，
 * 拒绝一切 JSON.stringify 会丢数据或抛错的结构 —— 两端（存储后端 / 工程包）
 * 对同一数据的接受/拒绝语义必须一致，不依赖具体序列化实现。
 *
 * 判定为不可编码（返回问题类型）时：
 * - 保存路径（两个后端）事务前拒绝并返回类型化错误；
 * - 导出路径拒绝并返回类型化失败；
 * - 内容指纹路径恒判未保存（不可编码内容无法可靠序列化比较）。
 */

/** 数据图中不可 JSON 编码的值的类型（写入前预检，与具体后端无关） */
export type JsonEncodingProblem =
  | 'circular-reference'
  | 'undefined-value'
  | 'function-value'
  | 'symbol-value'
  | 'bigint-value'
  | 'non-finite-number'
  /** 数组自有可枚举非索引键：JSON.stringify 静默丢弃（如 arr.extra） */
  | 'array-extra-keys';

/** 规范数组索引：'0' | '1' …（无前导零，2^32-2 封顶，与数组索引语义一致） */
const MAX_ARRAY_INDEX = 4294967294;

function isArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  return Number(key) <= MAX_ARRAY_INDEX;
}

/**
 * 递归检查数据图是否可无损 JSON 编码：循环引用（JSON.stringify 直接抛错）、
 * undefined/函数/符号（键被静默丢弃）、非有限数值（静默变 null）、BigInt（抛错）、
 * 数组自有非索引键（静默丢弃；稀疏空槽在 for-of 下表现为 undefined 一并拒绝）。
 * 返回首个问题；无可序列化问题返回 null。seen 按路径维护（退出即删除）：
 * 同一对象出现在两处（DAG）可正常序列化，不应误判为循环。
 */
export function findJsonEncodingProblem(value: unknown, seen = new Set<object>()): JsonEncodingProblem | null {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite-number';
    if (value === undefined) return 'undefined-value';
    if (typeof value === 'function') return 'function-value';
    if (typeof value === 'symbol') return 'symbol-value';
    if (typeof value === 'bigint') return 'bigint-value';
    return null;
  }
  if (seen.has(value)) return 'circular-reference';
  seen.add(value);
  if (Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!isArrayIndexKey(key)) return 'array-extra-keys';
    }
    for (const item of value) {
      const problem = findJsonEncodingProblem(item, seen);
      if (problem) return problem;
    }
  } else {
    for (const key of Object.keys(value)) {
      const problem = findJsonEncodingProblem((value as Record<string, unknown>)[key], seen);
      if (problem) return problem;
    }
  }
  seen.delete(value);
  return null;
}
