import type { Disposable } from '../disposable';
import type { PluginCommands } from '../commands/command-registry';
import type { EventMap, PluginDiagnostic } from '../events/event-map';
import type { ContributionBundle, ContributionKind } from '../contributions/types';
import type { Manifest } from '../manifest/validate';
import type { Project } from '../scene/types';
import type { PluginServices } from '../services';

export type PluginState =
  | 'registered'
  | 'loading'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'disabled'
  | 'failed';

export interface PluginDefinition {
  activate(context: PluginContext): Promise<Disposable | void> | Disposable | void;
  deactivate?(): Promise<void> | void;
}

export type PluginActivateFn = (context: PluginContext) => Promise<Disposable | void> | Disposable | void;
export type PluginDeactivateFn = () => Promise<void> | void;

/** 入口模块兼容两种导出形式：default 定义，或具名 activate/deactivate */
export interface PluginModule {
  default?: PluginDefinition;
  activate?: PluginActivateFn;
  deactivate?: PluginDeactivateFn;
}

/** 插件可用的订阅式事件总线（停用时自动移除订阅） */
export interface PluginEventBus {
  on<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable;
  once<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable;
  off<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): void;
  onAny(handler: (event: string, payload: unknown) => void): Disposable;
}

/** 宿主为一个插件实例提供的非敏感设置命名空间。 */
export interface PluginSettings {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * 宿主级设置后端。每个 `PluginHost` 持有独立后端，Core 再按插件 instanceId
 * 提供作用域门面，避免插件自行拼接全局存储 key。
 */
export interface PluginSettingsStorage {
  get(pluginInstanceId: string, key: string): string | null;
  set(pluginInstanceId: string, key: string, value: string): void;
  remove(pluginInstanceId: string, key: string): void;
}

export interface PluginContext {
  pluginId: string;
  manifest: Manifest;
  hostVersion: string;
  events: PluginEventBus;
  /** 只读/执行能力面：禁止绕过生命周期直接注册命令（见 PluginCommands） */
  commands: PluginCommands;
  services: PluginServices;
  /** 仅用于非敏感插件设置；凭据仍必须保留在插件运行时内存中。 */
  settings: PluginSettings;
  /** 提交贡献项；返回的 Disposable 由宿主在停用时自动释放，插件亦可提前释放 */
  contribute(bundle: ContributionBundle): Disposable;
  getProject(): Project | null;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

export interface PluginDescriptor {
  manifest: Manifest;
  /** 入口模块加载器；Manifest 校验或引擎检查失败时宿主不会调用它 */
  entry?: () => Promise<PluginModule>;
}

export interface PluginInfo {
  /** 生命周期与记录标识：稳定唯一（缺 id 的非法 Manifest 亦唯一），disable/enable 等操作使用它 */
  readonly instanceId: string;
  /** Manifest 展示 id：仅用于展示；缺 id 时为 '<unknown>'，不得用于寻址 */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: PluginState;
  readonly error?: PluginDiagnostic;
  readonly reason?: string;
  readonly contributes: ReadonlyArray<ContributionKind>;
}
