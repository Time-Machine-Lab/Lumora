import type { Project } from './types';

/**
 * 结构不可变（owned immutable state）：
 * 编辑器持有的项目一律经过递归冻结，外部（含宿主/插件）只能读取，
 * 任何写入在严格模式下抛 TypeError、非严格模式静默失败，均不改变状态。
 * 不信任 Object.isFrozen 推断深冻：浅冻结对象（仅外层冻结、嵌套可变）也必须
 * 完整遍历其嵌套结构（R6，TML-57 第六轮）；用 WeakSet 记录已访问引用，
 * 对共享/循环引用有环安全且不重复遍历。
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const obj = v as object;
    if (seen.has(obj)) return obj;
    seen.add(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      freeze((obj as Record<string, unknown>)[key]);
    }
    return Object.freeze(obj);
  };
  return freeze(value) as T;
}

/** 结构克隆（owned copy）：openProject 把外部输入复制为编辑器自有状态，调用方后续改动不影响编辑器 */
export function cloneProject(project: Project): Project {
  return structuredClone(project);
}
