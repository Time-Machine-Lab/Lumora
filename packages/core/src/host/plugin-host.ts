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
  /** 入口加载器：保存于注册时，enabled:false 插件首次启用时惰性加载 */
  loader?: PluginDescriptor['entry'];
  /** 进行中的入口加载，并发 load 共享同一 Promise，入口只加载一次 */
  loadingPromise?: Promise<void>;
  state: PluginState;
  reason?: string;
  error?: unknown;
  /** 宿主代管的插件资源：贡献项、命令、订阅、activate 返回值 */
  owned: DisposableSet;
  /** 校验失败时为 false，宿主不会加载入口模块 */
  ready: boolean;
  /** 生命周期代际：每次停用/销毁时递增，用于废弃进行中的激活（见 activateRecord） */
  generation: number;
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
 *
 * 并发与竞态：每个记录持有递增的代际号，停用/销毁时推进代际，
 * 进行中的激活完成时发现代际不符即整体回滚本次激活产生的资源。
 */
export class PluginHost {
  readonly hostVersion: string;
  readonly events = new TypedEventEmitter<EventMap>();
  readonly commands = new CommandRegistry({
    events: this.events,
    getServices: () => this.services,
    getProject: () => this.project,
  });
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
   * 且不会加载（import）入口模块；enabled: false 的插件注册后保持 disabled，
   * 首次 enable 时才加载入口。
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

    await this.loadDefinition(record);
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
    // failed 插件可停用（幂等清理残留资源）；停用后保持 inactive 并保留失败原因，
    // 激活失败类插件因此可重新 enable 重试
    const wasFailed = record.state === 'failed';
    await this.deactivateRecord(record);
    if (!wasFailed && record.state === 'inactive') {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
    }
  }

  async enable(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (!record.ready) {
      throw new Error(`插件 "${id}" 不可启用（${record.reason ?? '未通过校验'}）`);
    }
    if (record.state === 'active' || record.state === 'activating' || record.state === 'deactivating') {
      return;
    }
    if (!record.definition) {
      // enabled:false 注册的插件首次启用时才加载入口（loadDefinition 去重，只加载一次）
      await this.loadDefinition(record);
      if (record.state === 'failed' || !record.definition) return;
    }
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
    // 从原始输入安全提取展示字段：null / 数组 / 非对象等非法输入不会击穿隔离
    const raw = descriptor.manifest as unknown as Record<string, unknown> | null | undefined;
    const safeId = typeof raw?.id === 'string' ? raw.id : '<unknown>';
    const safeName = typeof raw?.name === 'string' ? raw.name : '<unknown>';
    const safeVersion = typeof raw?.version === 'string' ? raw.version : '0.0.0';
    if (this.plugins.has(safeId)) {
      throw new Error(`插件 id 重复: ${safeId}（已注册 ${safeName}）`);
    }

    let reason: string | undefined = !validation.ok
      ? `Manifest 非法: ${validation.errors.join('；')}`
      : undefined;
    let ready = reason === undefined;
    if (ready && manifest) {
      const engine = checkEngineCompatibility(manifest, this.hostVersion);
      if (!engine.ok) {
        ready = false;
        reason = engine.reason;
      }
    }

    // 校验失败时使用安全占位 Manifest（仅含可安全提取的展示字段），
    // info()/事件等后续环节只接触占位对象，不再触碰原始输入
    const safeManifest: Manifest = manifest ?? {
      schemaVersion: '1',
      id: safeId,
      name: safeName,
      version: safeVersion,
      entry: typeof raw?.entry === 'string' ? raw.entry : './dist/index.js',
      contributes: [],
    };

    const record: PluginRecord = {
      id: safeId,
      name: safeName,
      version: safeVersion,
      manifest: safeManifest,
      loader: descriptor.entry,
      ready,
      state: 'registered',
      reason,
      generation: 0,
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

  private loadDefinition(record: PluginRecord): Promise<void> {
    if (record.definition) return Promise.resolve();
    if (record.loadingPromise) return record.loadingPromise;
    record.loadingPromise = this.doLoad(record).finally(() => {
      record.loadingPromise = undefined;
    });
    return record.loadingPromise;
  }

  private async doLoad(record: PluginRecord): Promise<void> {
    record.state = 'loading';
    this.emitState(record, 'loading');
    if (!record.loader) {
      this.fail(record, '未提供入口模块加载器（descriptor.entry）');
      return;
    }
    try {
      const module = await record.loader();
      if (this.disposedFlag) return;
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

  /**
   * 激活事务：本次激活产生的资源先暂存在 pending，全部成功后才并入 owned；
   * 激活抛错或激活期间被停用/销毁（代际不符）时，pending 整体逆序回滚。
   */
  private async activateRecord(record: PluginRecord): Promise<void> {
    if (!record.ready || !record.definition) {
      throw new Error(`插件 "${record.id}" 无法激活（${record.reason ?? '定义缺失'}）`);
    }
    if (record.state === 'active' || record.state === 'activating' || record.state === 'deactivating') {
      return;
    }

    const generation = record.generation;
    record.state = 'activating';
    record.error = undefined;
    record.reason = undefined;
    this.emitState(record, 'activating');

    const pending: Disposable[] = [];
    const bridge = new TrackedEventBridge(this.events);
    pending.push(bridge);
    const context = this.createContext(record, bridge, (bundle) => {
      if (this.disposedFlag || record.generation !== generation) {
        throw new Error('插件已停用或宿主已销毁，无法提交贡献项');
      }
      const contributed = this.contributions.contribute(record.id, bundle);
      pending.push(contributed);
      return contributed;
    });
    try {
      const result = await record.definition.activate(context);
      if (this.disposedFlag || record.generation !== generation) {
        // 激活期间被停用/销毁：晚到的结果与暂存资源立即释放，不改变既有状态
        if (result != null) pending.push(result);
        try {
          await this.disposeAll(pending);
        } catch {
          // 释放失败不影响已推进的停用状态
        }
        return;
      }
      if (result != null) pending.push(result);
      for (const item of pending) record.owned.add(item);
      record.state = 'active';
      this.emitState(record, 'active');
    } catch (error) {
      try {
        await this.disposeAll(pending);
      } catch {
        // 回滚失败不掩盖原始激活错误
      }
      if (this.disposedFlag || record.generation !== generation) {
        return; // 已被停用取代：失败不覆盖既有状态
      }
      this.fail(record, `激活失败: ${this.errorMessage(error)}`, error);
    }
  }

  private async deactivateRecord(record: PluginRecord): Promise<void> {
    if (record.state === 'inactive' || record.state === 'disabled') return;
    // 推进代际：任何进行中的激活完成时都会被废弃并回滚（见 activateRecord）
    record.generation += 1;

    if (record.state === 'failed') {
      // failed 插件（校验/加载/激活失败）的停用：幂等清理残留资源，
      // 保留失败原因，激活失败类插件重新 enable 时可重试
      const errors: unknown[] = [];
      try {
        await record.owned.dispose();
      } catch (error) {
        errors.push(error);
      }
      record.owned = new DisposableSet();
      if (errors.length > 0) {
        record.error = errors;
        record.reason = `清理失败: ${errors.map((e) => this.errorMessage(e)).join('；')}`;
      }
      record.state = 'inactive';
      this.emitState(record, 'inactive');
      return;
    }

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

  private createContext(
    record: PluginRecord,
    bridge: TrackedEventBridge,
    contribute: (bundle: Parameters<PluginContext['contribute']>[0]) => ReturnType<PluginContext['contribute']>,
  ): PluginContext {
    const context: PluginContext = {
      pluginId: record.id,
      manifest: record.manifest,
      hostVersion: this.hostVersion,
      events: bridge,
      commands: this.commands,
      services: this.services,
      contribute,
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

  private disposeAll(items: Disposable[]): Promise<void> {
    return Promise.all(items.map((item) => Promise.resolve(item.dispose()).catch(() => undefined))).then(
      () => undefined,
    );
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
