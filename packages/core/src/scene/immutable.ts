import type { Project } from './types';

/**
 * 结构不可变（owned immutable state）：
 * 编辑器持有的项目一律经过递归冻结，外部（含宿主/插件）只能读取，
 * 任何写入在严格模式下抛 TypeError、非严格模式静默失败，均不改变状态。
 * 已冻结对象直接返回（幂等且避免重复遍历）。
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** 结构克隆（owned copy）：openProject 把外部输入复制为编辑器自有状态，调用方后续改动不影响编辑器 */
export function cloneProject(project: Project): Project {
  return structuredClone(project);
}
