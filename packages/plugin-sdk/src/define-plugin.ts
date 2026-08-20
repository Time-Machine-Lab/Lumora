import { validateManifest } from '@lumora/core';
import type { Manifest, PluginDefinition } from '@lumora/core';

/**
 * 类型安全的插件定义入口。用法：
 * ```ts
 * export default definePlugin({
 *   async activate(context) { ... },
 *   deactivate() { ... },
 * });
 * ```
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

/**
 * 构建并校验 lumora.plugin.json 内容；校验失败时抛出带全部错误项说明的异常。
 * 插件可以在构建期用它校验自己的 Manifest。
 */
export function defineManifest(input: unknown): Manifest {
  const result = validateManifest(input);
  if (!result.ok) {
    throw new Error(`lumora.plugin.json 非法:\n- ${result.errors.join('\n- ')}`);
  }
  return result.manifest!;
}
