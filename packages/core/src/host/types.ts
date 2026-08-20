import type { Disposable } from '../disposable';
import type { CommandRegistry } from '../commands/command-registry';
import type { EventMap } from '../events/event-map';
import type { ContributionBundle, ContributionKind } from '../contributions/types';
import type { Manifest } from '../manifest/validate';
import type { Project } from '../project';
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

export interface PluginContext {
  pluginId: string;
  manifest: Manifest;
  hostVersion: string;
  events: PluginEventBus;
  commands: CommandRegistry;
  services: PluginServices;
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
  id: string;
  name: string;
  version: string;
  state: PluginState;
  error?: unknown;
  reason?: string;
  contributes: ContributionKind[];
}
