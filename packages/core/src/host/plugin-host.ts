import { DisposableSet, type Disposable } from '../disposable';
import { CommandRegistry } from '../commands/command-registry';
import { ContributionRegistry } from '../contributions/contribution-registry';
import { TypedEventEmitter } from '../events/typed-event-emitter';
import type { EventMap } from '../events/event-map';
import { checkEngineCompatibility } from '../manifest/engine';
import { validateManifest } from '../manifest/validate';
import type { Manifest } from '../manifest/validate';
import { createPluginServices, type PluginServices } from '../services';
import type { Project } from '../project';
import type {
  PluginContext,
  PluginDefinition,
  PluginDescriptor,
  PluginEventBus,
  PluginInfo,
  PluginModule,
  PluginState,
} from './types';

export interface PluginHostOptions {
  hostVersion?: string;
  onError?: (error: unknown) => void;
}

interface PluginRecord {
  id: string;
  name: string;
  version: string;
  manifest: Manifest;
  /** Manifest + 引擎校验通过且入口加载成功后的定义 */
  definition?: PluginDefinition;
  state: PluginState;
  reason?: string;
  error?: unknown;
  /** 宿主代管的插件资源：贡献项、命令、订阅、activate 返回值 */
  owned: DisposableSet;
  /** 校验失败时为 false，宿主不会加载入口模块 */
  ready: boolean;
  info(): PluginInfo;
}

/** 插件可见的事件总线：on/once 的订阅归入插件代管集合，停用时全部移除 */
class TrackedEventBridge implements PluginEventBus {
  private readonly tracked = new DisposableSet();

  constructor(private readonly bus: TypedEventEmitter<EventMap>) {}

  on<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable {
    const subscription = this.bus.on(event, handler);
    this.tracked.add(subscription);
    return subscription;
  }

  once<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable {
    const subscription = this.bus.once(event, handler);
    this.tracked.add(subscription);
    return subscription;
  }

  off<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.bus.off(event, handler);
  }

  onAny(handler: (event: string, payload: unknown) => void): Disposable {
    const subscription = this.bus.onAny(handler);
    this.tracked.add(subscription);
    return subscription;
  }

  dispose(): Promise<void> {
    return this.tracked.dispose();
  }
}

/**
 * 插件宿主：负责发现（校验 Manifest + 引擎兼容性）、加载、激活/停用、
 * 错误隔离与生命周期状态管理。任何插件异常都不会影响宿主核心与其它插件。
 *
 * 状态机：registered → loading → activating → active
 *                       ↘ failed（校验/加载/激活任一环节失败）
 *         active → deactivating → inactive / disabled
 */
export class PluginHost {
  readonly hostVersion: string;
  readonly events = new TypedEventEmitter<EventMap>();
  readonly commands = new CommandRegistry({ events: this.events, getProject: () => this.project });
  readonly contributions = new ContributionRegistry({ events: this.events, commands: this.commands });
  readonly services: PluginServices;

  private readonly plugins = new Map<string, PluginRecord>();
  private readonly onError: (error: unknown) => void;
  private project: Project | null = null;
  private disposedFlag = false;

  constructor(options: PluginHostOptions = {}) {
    this.hostVersion = options.hostVersion ?? '0.1.0';
    this.onError =
      options.onError ??
      ((error) => {
        console.error('[lumora:host] 未捕获的宿主错误:', error);
      });
    this.services = createPluginServices(this.contributions, () => this.project);
  }

  getProject(): Project | null {
    return this.project;
  }

  setProject(project: Project | null): void {
    this.project = project;
  }

  listPlugins(): PluginInfo[] {
    return [...this.plugins.values()].map((record) => record.info());
  }

  getPlugin(id: string): PluginInfo | undefined {
    return this.plugins.get(id)?.info();
  }

  /**
   * 注册并加载一个插件。Manifest 非法 / 引擎不兼容 / 无入口时进入 failed 状态，
   * 且不会加载（import）入口模块；enabled: false 的插件注册后保持 disabled。
   */
  async register(descriptor: PluginDescriptor): Promise<PluginInfo> {
    if (this.disposedFlag) throw new Error('插件宿主已销毁');

    const record = this.createRecord(descriptor);
    this.plugins.set(record.id, record);
    this.emitState(record, 'registered');

    if (!record.ready) {
      this.fail(record, record.reason ?? '插件未通过校验');
      return record.info();
    }
    if (record.manifest.enabled === false) {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
      return record.info();
    }

    await this.loadDefinition(record, descriptor.entry);
    if (this.disposedFlag || record.state === 'failed') return record.info();

    await this.activateRecord(record);
    return record.info();
  }

  async activate(id: string): Promise<void> {
    const record = this.requireRecord(id);
    await this.activateRecord(record);
  }

  async deactivate(id: string): Promise<void> {
    await this.deactivateRecord(this.requireRecord(id));
  }

  async disable(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.state === 'failed') return;
    await this.deactivateRecord(record);
    if (record.state === 'inactive') {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
    }
  }

  async enable(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (!record.ready || !record.definition) {
      throw new Error(`插件 "${id}" 不可启用（${record.reason ?? '定义缺失'}）`);
    }
    if (record.state === 'active') return;
    await this.activateRecord(record);
  }

  async dispose(): Promise<void> {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    for (const record of this.plugins.values()) {
      await this.deactivateRecord(record);
    }
    this.plugins.clear();
    this.contributions.dispose();
    this.commands.dispose();
    this.events.dispose();
  }

  // ---------- 内部 ----------

  private createRecord(descriptor: PluginDescriptor): PluginRecord {
    const validation = validateManifest(descriptor.manifest);
    const manifest = validation.ok && validation.manifest ? validation.manifest : null;
    const base = {
      id: manifest?.id ?? (descriptor.manifest as { id?: string })?.id ?? '<unknown>',
      name: manifest?.name ?? (descriptor.manifest as { name?: string })?.name ?? '<unknown>',
      version: manifest?.version ?? (descriptor.manifest as { version?: string })?.version ?? '0.0.0',
      manifest: (manifest ?? descriptor.manifest) as Manifest,
    };
    if (this.plugins.has(base.id)) {
      throw new Error(`插件 id 重复: ${base.id}（已注册 ${base.name}）`);
    }

    let reason: string | undefined = !validation.ok
      ? `Manifest 非法: ${validation.errors.join('；')}`
      : undefined;

    let ready = reason === undefined;
    if (ready) {
      const engine = checkEngineCompatibility(base.manifest, this.hostVersion);
      if (!engine.ok) {
        ready = false;
        reason = engine.reason;
      }
    }

    const record: PluginRecord = {
      ...base,
      ready,
      state: 'registered',
      reason,
      owned: new DisposableSet(),
      info() {
        return {
          id: record.id,
          name: record.name,
          version: record.version,
          state: record.state,
          error: record.error,
          reason: record.reason,
          contributes: [...(record.manifest.contributes ?? [])],
        };
      },
    };
    return record;
  }

  private async loadDefinition(
    record: PluginRecord,
    loader: PluginDescriptor['entry'],
  ): Promise<void> {
    record.state = 'loading';
    this.emitState(record, 'loading');
    if (record.definition) return;
    if (!loader) {
      this.fail(record, '未提供入口模块加载器（descriptor.entry）');
      return;
    }
    try {
      const module = await loader();
      if (this.disposedFlag) {
        this.fail(record, '宿主已销毁，加载中止');
        return;
      }
      const definition = normalizePluginModule(module);
      if (!definition) {
        this.fail(record, '入口模块未导出插件定义（缺少 default 或 activate）');
        return;
      }
      record.definition = definition;
    } catch (error) {
      this.fail(record, `入口模块加载失败: ${this.errorMessage(error)}`, error);
    }
  }

  private async activateRecord(record: PluginRecord): Promise<void> {
    if (!record.ready || !record.definition) {
      throw new Error(`插件 "${record.id}" 无法激活（${record.reason ?? '定义缺失'}）`);
    }
    if (record.state === 'active') return;

    record.state = 'activating';
    record.error = undefined;
    record.reason = undefined;
    this.emitState(record, 'activating');

    const bridge = new TrackedEventBridge(this.events);
    record.owned.add(bridge);
    const context = this.createContext(record, bridge);
    try {
      const result = await record.definition.activate(context);
      if (this.disposedFlag) {
        this.fail(record, '宿主已销毁，激活中止');
        return;
      }
      if (result != null) record.owned.add(result);
      record.state = 'active';
      this.emitState(record, 'active');
    } catch (error) {
      this.fail(record, `激活失败: ${this.errorMessage(error)}`, error);
    }
  }

  private async deactivateRecord(record: PluginRecord): Promise<void> {
    if (record.state === 'inactive' || record.state === 'disabled') return;
    record.state = 'deactivating';
    this.emitState(record, 'deactivating');
    const errors: unknown[] = [];
    try {
      await record.definition?.deactivate?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await record.owned.dispose();
    } catch (error) {
      errors.push(error);
    }
    // 换新集合，插件再次启用时不会被已销毁的集合吞掉资源
    record.owned = new DisposableSet();
    record.state = 'inactive';
    record.error = undefined;
    record.reason = undefined;
    if (errors.length > 0) {
      record.error = errors;
      record.reason = `停用时出错: ${errors.map((e) => this.errorMessage(e)).join('；')}`;
    }
    this.emitState(record, 'inactive');
  }

  private createContext(record: PluginRecord, bridge: TrackedEventBridge): PluginContext {
    const context: PluginContext = {
      pluginId: record.id,
      manifest: record.manifest,
      hostVersion: this.hostVersion,
      events: bridge,
      commands: this.commands,
      services: this.services,
      contribute: (bundle) => {
        const contributed = this.contributions.contribute(record.id, bundle);
        record.owned.add(contributed);
        return contributed;
      },
      getProject: () => this.project,
      log: (level, message, data) => {
        const line = `[lumora:plugin:${record.id}] ${level.toUpperCase()} ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ''}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.info(line);
      },
    };
    return context;
  }

  private fail(record: PluginRecord, reason: string, error?: unknown): void {
    record.state = 'failed';
    record.reason = reason;
    record.error = error ?? new Error(reason);
    this.emitState(record, 'failed');
  }

  private emitState(record: PluginRecord, state: PluginState): void {
    this.events.emit('plugin:state-changed', {
      pluginId: record.id,
      state,
      error: record.error ?? record.reason,
    });
  }

  private requireRecord(id: string): PluginRecord {
    const record = this.plugins.get(id);
    if (!record) throw new Error(`未知插件: ${id}`);
    return record;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function normalizePluginModule(module: PluginModule): PluginDefinition | undefined {
  if (module.default) return module.default;
  if (module.activate) {
    return { activate: module.activate, deactivate: module.deactivate };
  }
  return undefined;
}
