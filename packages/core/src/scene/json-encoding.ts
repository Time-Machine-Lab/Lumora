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
  | 'array-extra-keys'
  /** 负零：JSON.stringify(-0) 静默失真为 0（第七轮 #4） */
  | 'negative-zero'
  /** 非普通对象（Date/Map/Set/RegExp/typed array 等品牌对象）：JSON.stringify
   *  会经 toJSON/枚举自身键静默转换成字符串、空对象或索引对象（第七轮 #4） */
  | 'non-plain-object'
  /** Symbol 键：JSON.stringify 只序列化字符串键，Symbol 键静默丢弃（第八轮 #7） */
  | 'symbol-key'
  /** 不可枚举属性：JSON.stringify 只序列化可枚举自身键，不可枚举静默丢弃（第八轮 #7） */
  | 'non-enumerable-property'
  /** 访问器属性：JSON.stringify 会调用 getter（可能抛错或产生副作用），结果不可预测（第八轮 #7） */
  | 'accessor-property'
  /** 反射读取抛错（Proxy 的 ownKeys/getOwnPropertyDescriptor/getPrototypeOf trap）：
   *  无法检查的数据不进入序列化路径，一律拒绝（第八轮 #7） */
  | 'reflection-error';

/** 规范数组索引：'0' | '1' …（无前导零，2^32-2 封顶，与数组索引语义一致） */
export const MAX_ARRAY_INDEX = 4294967294;

/** 规范数组索引判定（工程包构建复用：数组非索引键 JSON 序列化必丢） */
export function isArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  return Number(key) <= MAX_ARRAY_INDEX;
}

/**
 * 递归检查数据图是否可无损 JSON 编码：循环引用（JSON.stringify 直接抛错）、
 * undefined/函数/符号（键被静默丢弃）、非有限数值（静默变 null）、-0（静默变 0）、
 * BigInt（抛错）、数组自有非索引键（静默丢弃；稀疏空槽在 for-of 下表现为
 * undefined 一并拒绝）、非普通对象（Date/Map/Set/RegExp/typed array 等品牌对象
 * 会被 toJSON/枚举自身键静默转换）。
 * 属性枚举以 Reflect.ownKeys + 属性描述符为准（第八轮 #7）：JSON.stringify 只
 * 序列化可枚举的字符串键 —— Symbol 键、不可枚举属性与访问器会被静默丢弃或触发
 * getter 副作用，一律拒绝；Proxy 的 ownKeys/getOwnPropertyDescriptor/
 * getPrototypeOf trap 抛错归一为 reflection-error（无法检查的数据不进入序列化路径）。
 * 返回首个问题；无可序列化问题返回 null。seen 按路径维护（退出即删除）：
 * 同一对象出现在两处（DAG）可正常序列化，不应误判为循环。
 */
export function findJsonEncodingProblem(value: unknown, seen = new Set<object>()): JsonEncodingProblem | null {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'non-finite-number';
      if (Object.is(value, -0)) return 'negative-zero';
    }
    if (value === undefined) return 'undefined-value';
    if (typeof value === 'function') return 'function-value';
    if (typeof value === 'symbol') return 'symbol-value';
    if (typeof value === 'bigint') return 'bigint-value';
    return null;
  }
  if (seen.has(value)) return 'circular-reference';
  seen.add(value);
  // 对象必须是普通/null-prototype record：品牌对象（Date/Map/Set/RegExp/
  // typed array/Error 等）的 JSON 行为依赖内部槽与 toJSON，禁止入图；
  // 数组是合法 JSON value（索引即内容），Array.prototype 放行；
  // getPrototypeOf trap 抛错的 Proxy 无法判定，归一为 reflection-error
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return 'reflection-error';
  }
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return 'non-plain-object';
  let keys: Array<string | symbol>;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return 'reflection-error';
  }
  for (const key of keys) {
    if (typeof key === 'symbol') return 'symbol-key';
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return 'reflection-error';
    }
    if (!descriptor) return 'reflection-error';
    if (!descriptor.enumerable) {
      // 数组自身的 length 不可枚举，是数组语义的实现细节（JSON.stringify 以
      // 索引为内容），跳过；其余不可枚举属性会被 JSON.stringify 静默丢弃
      if (Array.isArray(value) && key === 'length') continue;
      return 'non-enumerable-property';
    }
    if ('get' in descriptor || 'set' in descriptor) return 'accessor-property';
    if (Array.isArray(value) && !isArrayIndexKey(key)) return 'array-extra-keys';
    const problem = findJsonEncodingProblem(descriptor.value, seen);
    if (problem) return problem;
  }
  if (Array.isArray(value)) {
    // 稀疏空槽不在 ownKeys 中，但 for-of 迭代表现为 undefined —— 一并拒绝
    for (const item of value) {
      const problem = findJsonEncodingProblem(item, seen);
      if (problem) return problem;
    }
  }
  seen.delete(value);
  return null;
}
