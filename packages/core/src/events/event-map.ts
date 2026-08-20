import type { Project } from '../project';
import type { PluginState } from '../host/types';

/** 平台级类型化事件表；插件可经索引签名发射自定义事件 */
export interface EventMap {
  // instanceId：稳定唯一的记录标识（可寻址）；pluginId：Manifest 展示 id，仅作展示
  'plugin:state-changed': { instanceId: string; pluginId: string; state: PluginState; error?: unknown };
  'plugin:contributed': { pluginId: string };
  'contribution:changed': { pluginId: string };
  'command:changed': { id: string; added: boolean };
  'command:executed': { id: string; ok: boolean; error?: unknown };
  'project:opened': { uri: string; name: string; project: Project };
  'project:closed': { uri: string };
  [event: string]: unknown;
}
