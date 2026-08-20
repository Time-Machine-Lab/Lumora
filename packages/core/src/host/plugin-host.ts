import { DisposableSet, type Disposable } from '../disposable';
import { CommandRegistry, PluginCommands, type CommandContext } from '../commands/command-registry';
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

/**
 * 身份不变的 deferred promise：发布时即确定 promise 身份并登记到记录字段，
 * 真实操作只 resolve/reject 该 promise —— 字段绝不中途替换。事件监听器重入
 * 与并发调用在任何时点取到的都是同一真实完成 promise。
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 一代入口加载操作：先发布 deferred（任何状态事件之前），再启动加载；同代共享，异代整体丢弃 */
interface LoadingOperation {
  generation: number;
  deferred: Deferred<void>;
}

/**
 * 一次激活尝试的身份：持有身份（record.activation === attempt 且代际相符）者
 * 才能触碰 generation/pending/终态；过期尝试只能清理自身资源，不写入任何状态。
 * completion 是本尝试的唯一完成点：覆盖 activate 钩子 settle、晚到返回值的
 * async Disposable 清理与暂存资源清理 —— 生命周期操作等待它，旧代清理不会
 * 在 disable/enable 已返回后仍跨代污染新代。
 * workflow 是完整激活流程的完成点：active 发布或失败/取消回滚的终态发布后
 * settle（resolve 幂等）；register/enable/activate 遇到 activating 时加入
 * 同一 promise，不提前返回。
 */
interface ActivationAttempt {
  generation: number;
  /** 本尝试暂存资源（贡献项、订阅、activate 返回值）：生命周期操作与过期尝试共用，DisposableSet 幂等 */
  pending: DisposableSet;
  completion: Promise<void>;
  /** 完整激活流程完成点（身份不变）：由 activateRecord 成功路径或 performLifecycle 终态后 settle */
  workflow: Deferred<void>;
}

/** 生命周期操作的终态意图：由最后一位发布者决定（disable 的 disabled 可覆盖回滚的 failed） */
interface LifecycleTarget {
  state: 'inactive' | 'disabled' | 'failed';
  reason?: string;
  error?: unknown;
}

/** 一代插件门面：命令/事件能力面，代际绑定，随生命周期回收 */
interface PluginGate {
  commands: PluginCommands;
  events: TrackedEventBridge;
}

interface PluginRecord {
  /** 内部唯一记录键 = 公开 instanceId：缺 id 的非法 Manifest 使用自增序号，多个非法记录互不冲突 */
  key: string;
  /** 展示 id：缺 id 时为 '<unknown>'，仅供隔离展示，不得用于寻址 */
  id: string;
  name: string;
  version: string;
  manifest: Manifest;
  /** Manifest + 引擎校验通过且入口加载成功后的定义 */
  definition?: PluginDefinition;
  /** 入口加载器：保存于注册时，enabled:false 插件首次启用时惰性加载 */
  loader?: PluginDescriptor['entry'];
  /** 当前代的入口加载操作；新一代 enable 不复用旧代操作（晚到结果整体丢弃） */
  loading: LoadingOperation | null;
  state: PluginState;
  reason?: string;
  error?: unknown;
  /** 宿主代管的插件资源：贡献项、命令、订阅、activate 返回值 */
  owned: DisposableSet;
  /** 当前激活尝试：激活取消/失败回滚/停用收敛为同一生命周期操作 */
  activation: ActivationAttempt | null;
  /** 当前代门面：命令回调（when/execute）与外部订阅经它绑定 owner/代际 */
  gate: PluginGate | null;
  /** 在途生命周期操作的 deferred（任何状态事件之前登记）：身份自发布起不变，共享与合并读取同一真实完成 promise */
  lifecycle: Deferred<void> | null;
  /** 生命周期操作的终态意图：后发布者覆盖（合并） */
  lifecycleTarget: LifecycleTarget | null;
  /** 校验失败时为 false，宿主不会加载入口模块 */
  ready: boolean;
  /** 生命周期代际：每次发布生命周期操作（停用/销毁/激活失败）时递增，用于废弃在途加载/激活/门面 */
  generation: number;
  info(): PluginInfo;
}

/** 插件可见的事件总线：订阅归入尝试暂存集合，随停用整体移除；代际失效后订阅被拒绝 */
class TrackedEventBridge implements PluginEventBus {
  private readonly tracked: DisposableSet;
  /** 关闭后旧 context 的订阅请求不再落到宿主总线，避免停用/失败后泄漏 */
  private closed = false;

  constructor(
    private readonly bus: TypedEventEmitter<EventMap>,
    tracked: DisposableSet,
    private readonly isValid: () => boolean,
  ) {
    this.tracked = tracked;
  }

  private assertAlive(): void {
    if (this.closed || !this.isValid()) throw new Error('插件上下文已失效：无法订阅宿主事件');
  }

  on<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable {
    this.assertAlive();
    const subscription = this.bus.on(event, handler);
    this.tracked.add(subscription);
    return subscription;
  }

  once<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable {
    this.assertAlive();
    const subscription = this.bus.once(event, handler);
    this.tracked.add(subscription);
    return subscription;
  }

  off<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): void {
    if (this.closed || !this.isValid()) return;
    this.bus.off(event, handler);
  }

  onAny(handler: (event: string, payload: unknown) => void): Disposable {
    this.assertAlive();
    const subscription = this.bus.onAny(handler);
    this.tracked.add(subscription);
    return subscription;
  }

  dispose(): Promise<void> {
    this.closed = true;
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
 * 并发与竞态：加载与生命周期操作自发布起持有身份不变的 deferred promise
 * （先登记、后执行，真实操作只 settle，绝不替换字段），事件监听器重入与
 * 并发调用在任何时点取得同一真实完成 promise；每次同步 emitState 返回后、
 * 调用 loader 或 activate（插件用户代码）前复核 operation identity、generation
 * 与期望状态，事件中的停用立即终止注册/加载/激活链。每次激活持有独立尝试
 * 身份：过期尝试只能清理自身资源，不得修改新一代的 generation/pending/终态；
 * 尝试的唯一完成点覆盖钩子 settle、晚到返回值的清理与暂存清理；完整激活流程
 * 另有共享完成点（active 发布或回滚终态发布后 settle），register/enable/activate
 * 遇到 activating 时加入同一 promise，不提前返回快照。激活取消、失败回滚与
 * 停用收敛为同一生命周期操作，disable/deactivate/dispose 等待同一操作；
 * 激活失败先发布并认领失败生命周期、再执行回滚，回滚清理事件内的 disable
 * 合并进同一操作且 disabled 优先于旧失败终态；终态事件发布前旧操作完整
 * detach，事件内重入的新激活失败进入独立生命周期并完成自身回滚。
 */
export class PluginHost {
  readonly hostVersion: string;
  readonly events = new TypedEventEmitter<EventMap>();
  readonly commands: CommandRegistry;
  readonly contributions: ContributionRegistry;
  readonly services: PluginServices;

  private readonly plugins = new Map<string, PluginRecord>();
  private readonly onError: (error: unknown) => void;
  private project: Project | null = null;
  private disposedFlag = false;
  /** 缺 id 非法 Manifest 的内部记录键自增序号（展示 id 仍为 '<unknown>'） */
  private unknownSequence = 0;

  constructor(options: PluginHostOptions = {}) {
    this.hostVersion = options.hostVersion ?? '0.1.0';
    this.onError =
      options.onError ??
      ((error) => {
        console.error('[lumora:host] 未捕获的宿主错误:', error);
      });
    // 宿主自身就绪后再构造命令/贡献项/服务：onError 与惰性 services 才能正确注入
    this.commands = new CommandRegistry({
      events: this.events,
      getServices: () => this.services,
      getProject: () => this.project,
      onError: (error) => this.onError(error),
      // 命令回调（when/execute）收到 owner/代际绑定的命令与事件门面；停用后旧 context 彻底失效
      contextFor: (ownerId) => this.createCommandContext(ownerId),
    });
    this.contributions = new ContributionRegistry({ events: this.events, commands: this.commands });
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

  /** 按 instanceId 查询插件（合法 Manifest 的 instanceId 与 manifest id 相同） */
  getPlugin(instanceId: string): PluginInfo | undefined {
    return this.plugins.get(instanceId)?.info();
  }

  /**
   * 注册并加载一个插件。Manifest 非法 / 引擎不兼容 / 无入口时进入 failed 状态，
   * 且不会加载（import）入口模块；enabled: false 的插件注册后保持 disabled，
   * 首次 enable 时才加载入口。
   */
  async register(descriptor: PluginDescriptor): Promise<PluginInfo> {
    if (this.disposedFlag) throw new Error('插件宿主已销毁');

    const record = this.createRecord(descriptor);
    this.plugins.set(record.key, record);
    this.emitState(record, 'registered');

    // registered 事件内若发生停用（disable/deactivate 同步推进代际并接管状态），
    // 立即终止注册链：不再加载/激活，不执行任何插件用户代码。
    // 断言避免 TS 对 record.state 持续收窄（否则其后对 'failed'/'loading' 的比较会被误判为无重叠）
    if (this.disposedFlag || (record.state as PluginState) !== 'registered') return record.info();

    if (!record.ready) {
      this.fail(record, record.reason ?? '插件未通过校验');
      return record.info();
    }
    if (record.manifest.enabled === false) {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
      return record.info();
    }

    const loadingPromise = this.loadDefinition(record);
    // await 前捕获代际与加载操作身份：恢复后同时复核，旧注册流不得把新一代的
    // loading 当成自己的操作（跨代 ABA），也不能依据新代 state 启动激活或写失败
    const generation = record.generation;
    const loading = record.loading;
    await loadingPromise;
    const stateAfterLoad = record.state;
    // 过期注册流只能按取消路径结束（返回当前快照），不启动激活、不加入新代激活
    if (this.disposedFlag || record.generation !== generation) return record.info();
    if (stateAfterLoad === 'activating') {
      // 加载期间重入 enable 已启动同代激活：加入同一完整激活流程，
      // 等待 active 发布或失败/取消回滚终态，不得提前返回 activating 快照
      await this.awaitActivationOutcome(record);
      return record.info();
    }
    // 加载期间可能被 disable/dispose 接管（状态已离开 loading），晚到加载结果不得改写停用状态；
    // 加载操作身份复核：同代内字段应已清空（操作完成）或仍指向本次操作
    if (
      stateAfterLoad === 'failed' ||
      stateAfterLoad !== 'loading' ||
      (record.loading !== null && record.loading !== loading)
    ) {
      return record.info();
    }

    await this.activateRecord(record);
    return record.info();
  }

  async activate(id: string): Promise<void> {
    const record = this.requireRecord(id);
    await this.activateRecord(record);
  }

  async deactivate(instanceId: string): Promise<void> {
    await this.deactivateRecord(this.requireRecord(instanceId), 'inactive');
  }

  async disable(instanceId: string): Promise<void> {
    const record = this.requireRecord(instanceId);
    const wasFailed = record.state === 'failed';
    // 与并发的 deactivate/dispose 及事件重入共享同一生命周期操作：
    // 等待激活 settle、暂存清理与 deactivate 钩子全部完成，不提前返回
    await this.deactivateRecord(record, 'disabled');
    // 顺序场景：先 deactivate（inactive）再 disable —— 终态仍收敛为 disabled；
    // failed 插件停用保持 inactive（保留失败原因，可重新启用重试）
    if (!wasFailed && record.state === 'inactive') {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
    }
  }

  async enable(instanceId: string): Promise<void> {
    const record = this.requireRecord(instanceId);
    if (!record.ready) {
      throw new Error(`插件 "${instanceId}" 不可启用（${record.reason ?? '未通过校验'}）`);
    }
    const state = record.state;
    if (state === 'active') return;
    if (state === 'activating') {
      // 激活已在途：加入同一完整激活流程（active 或失败/取消回滚终态），不提前返回
      await this.awaitActivationOutcome(record);
      return;
    }
    if (state === 'deactivating') {
      // 在途生命周期进行中：enable 意图不得被吞掉 —— 等待同一操作完成后继续
      await record.lifecycle?.promise;
      if (this.disposedFlag) return;
      if (record.state !== 'inactive' && record.state !== 'disabled' && record.state !== 'failed') return;
    }
    if (!record.definition) {
      // enabled:false 注册的插件首次启用时才加载入口（loadDefinition 按代共享，只加载一次）。
      // 记录进入时的代际：加载期间若被 disable（代际推进），晚到的加载结果不得改写停用状态
      const generation = record.generation;
      await this.loadDefinition(record);
      if (record.state === 'failed' || !record.definition || record.generation !== generation) return;
    }
    await this.activateRecord(record);
  }

  async dispose(): Promise<void> {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    for (const record of this.plugins.values()) {
      await this.deactivateRecord(record, 'inactive');
    }
    this.plugins.clear();
    this.contributions.dispose();
    this.commands.dispose();
    this.events.dispose();
  }

  /**
   * 停用一条记录：发布（或并入）生命周期操作，返回该操作 ——
   * deactivate/disable/dispose 及状态事件内的重入全部等待同一完成。
   * failed 插件停用保留失败原因（可重新启用重试），目标终态恒为 inactive；
   * 其余场景目标终态由调用方决定（disable → disabled，deactivate/dispose → inactive）。
   */
  private deactivateRecord(record: PluginRecord, target: 'inactive' | 'disabled'): Promise<void> {
    if (record.state === 'inactive' || record.state === 'disabled') return Promise.resolve();
    const merged: LifecycleTarget =
      record.state === 'failed' ? { state: 'inactive' } : { state: target };
    return this.publishLifecycle(record, merged);
  }

  /**
   * 等待在途激活的完整流程结果：active 发布或失败/取消回滚的终态发布后返回。
   * register/enable/activate 遇到 activating 时加入同一完成，不提前返回快照。
   * 若尝试已被生命周期操作摘除（回滚进行中），等待同一生命周期操作完成。
   */
  private async awaitActivationOutcome(record: PluginRecord): Promise<void> {
    const attempt = record.activation;
    if (attempt) {
      try {
        await attempt.workflow.promise;
      } catch {
        // 流程完成点承诺不拒绝；防御性兜底
      }
      return;
    }
    const lifecycle = record.lifecycle;
    if (lifecycle) {
      try {
        await lifecycle.promise;
      } catch {
        // 生命周期承诺以成功收敛；防御性兜底
      }
    }
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
    // 内部记录键：缺 id 的非法输入使用自增序号，多个非法插件各自成记录、逐个隔离展示；
    // 真实 id 重复仍抛错
    const key = typeof raw?.id === 'string' ? raw.id : `<unknown:${++this.unknownSequence}>`;
    if (this.plugins.has(key)) {
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
      key,
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
      loading: null,
      activation: null,
      gate: null,
      lifecycle: null,
      lifecycleTarget: null,
      info() {
        return {
          instanceId: record.key,
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

  /**
   * 发布本代入口加载操作：先登记身份不变的 deferred（任何状态事件之前），再启动加载。
   * 同代进行中的加载共享同一操作（loading 事件内重入 enable 等待同一真实完成，
   * 不会二次加载）；新一代 enable 不复用旧代操作，旧代的晚到结果按代际/身份整体丢弃。
   */
  private loadDefinition(record: PluginRecord): Promise<void> {
    if (record.definition) return Promise.resolve();
    const current = record.loading;
    if (current && current.generation === record.generation) return current.deferred.promise;
    const deferred = createDeferred<void>();
    const operation: LoadingOperation = { generation: record.generation, deferred };
    record.loading = operation;
    this.doLoad(record).then(
      () => {
        if (record.loading === operation) record.loading = null;
        deferred.resolve();
      },
      (error) => {
        if (record.loading === operation) record.loading = null;
        deferred.reject(error);
      },
    );
    return deferred.promise;
  }

  private async doLoad(record: PluginRecord): Promise<void> {
    const generation = record.generation;
    const operation = record.loading;
    record.state = 'loading';
    this.emitState(record, 'loading');
    // loading 事件内若发生停用（disable/deactivate/dispose 推进代际并接管状态），
    // 复核通过才调用入口 loader（插件用户代码），否则不再继续
    if (
      this.disposedFlag ||
      record.state !== 'loading' ||
      record.generation !== generation ||
      record.loading !== operation
    ) {
      return;
    }
    if (!record.loader) {
      this.fail(record, '未提供入口模块加载器（descriptor.entry）');
      return;
    }
    try {
      const module = await record.loader();
      // 停用/销毁接管（代际推进）或已被新一代加载操作取代后，晚到的加载结果一律丢弃：
      // 有效导出不缓存定义、无有效导出不 fail —— 均不得改写停用终态
      if (this.disposedFlag || record.generation !== generation || record.loading !== operation) return;
      const definition = normalizePluginModule(module);
      if (!definition) {
        this.fail(record, '入口模块未导出插件定义（缺少 default 或 activate）');
        return;
      }
      record.definition = definition;
    } catch (error) {
      // 晚到的加载失败同样绑定代际：不得把已停用/禁用的插件改写为 failed
      if (this.disposedFlag || record.generation !== generation || record.loading !== operation) return;
      this.fail(record, `入口模块加载失败: ${this.errorMessage(error)}`, error);
    }
  }

  /**
   * 激活事务：先原子发布本次激活的尝试身份与门面（任何状态事件之前），再执行激活。
   * 尝试持有自己的 pending（DisposableSet）；激活失败或取消收敛为生命周期操作，
   * 过期尝试只能清理自身资源，不得修改新一代的 generation/pending/终态。
   */
  private async activateRecord(record: PluginRecord): Promise<void> {
    if (!record.ready || !record.definition) {
      throw new Error(`插件 "${record.id}" 无法激活（${record.reason ?? '定义缺失'}）`);
    }
    const state = record.state;
    if (state === 'active') return;
    if (state === 'activating') {
      // 激活已在途：加入同一完整激活流程（active 或失败/取消回滚终态），不提前返回
      await this.awaitActivationOutcome(record);
      return;
    }
    if (state === 'deactivating') return;

    // 本尝试的唯一完成点（身份不变）：钩子 settle、晚到返回值清理与暂存清理全部收敛于此；
    // workflow 为完整激活流程的完成点：active 发布或失败/取消回滚终态发布后 settle，
    // 并发/重入的 register/enable/activate 加入同一 promise
    const completion = createDeferred<void>();
    const workflow = createDeferred<void>();
    const attempt: ActivationAttempt = {
      generation: record.generation,
      pending: new DisposableSet(),
      completion: completion.promise,
      workflow,
    };
    const gate: PluginGate = {
      commands: new PluginCommands(this.commands, () => this.isGateAlive(record, attempt)),
      events: new TrackedEventBridge(this.events, attempt.pending, () => this.isGateAlive(record, attempt)),
    };
    record.activation = attempt;
    record.gate = gate;
    record.state = 'activating';
    record.error = undefined;
    record.reason = undefined;
    this.emitState(record, 'activating');

    // activating 事件内若发生停用（disable/deactivate/dispose 已推进代际并摘除尝试），
    // 不得再调用 activate 钩子（插件用户代码）；收尾由在途生命周期操作完成
    if (
      this.disposedFlag ||
      record.activation !== attempt ||
      record.generation !== attempt.generation ||
      record.state !== 'activating'
    ) {
      completion.resolve();
      return;
    }

    // activate 钩子可能同步抛错（贡献项冲突等），与异步拒绝走同一失败回滚路径
    let hook: Promise<Disposable | void> | Disposable | void;
    try {
      hook = record.definition.activate(this.createContext(record, attempt, gate));
    } catch (error) {
      await this.failActivation(record, attempt, completion, error);
      return;
    }

    let result: Disposable | void;
    try {
      result = await hook;
    } catch (error) {
      await this.failActivation(record, attempt, completion, error);
      return;
    }
    if (this.disposedFlag || record.activation !== attempt) {
      // 过期尝试：清理晚到返回值与暂存资源后解析唯一完成点 —— 生命周期等待它，
      // disable 不会在晚到 async Disposable 清理结束前返回
      if (result != null) {
        try {
          await this.disposeAll([result]);
        } catch {
          // 释放失败不影响已推进的停用状态
        }
      }
      try {
        await attempt.pending.dispose();
      } catch {
        // 清理失败不影响已推进的停用状态
      }
      completion.resolve();
      return;
    }
    record.activation = null;
    record.owned.add(attempt.pending);
    if (result != null) record.owned.add(result);
    record.state = 'active';
    this.emitState(record, 'active');
    completion.resolve();
    attempt.workflow.resolve();
  }

  /**
   * 激活失败（同步抛错或异步拒绝）：当前尝试在任何回滚 await 之前先发布并认领
   * 失败生命周期 —— 生命周期立即接管尝试并等待唯一完成点，回滚清理（暂存资源
   * dispose、deactivate 钩子）由 completion 驱动在生命周期内执行；贡献清理事件
   * 内的 disable 合并进同一生命周期，disabled 优先于本失败意图（见 publishLifecycle）。
   * 等待回滚终态发布后返回，调用方（register/activateRecord）不会在回滚完成前结束。
   * 过期尝试只清理自身资源，不写入任何状态。
   */
  private async failActivation(
    record: PluginRecord,
    attempt: ActivationAttempt,
    completion: Deferred<void>,
    error: unknown,
  ): Promise<void> {
    if (this.disposedFlag) {
      completion.resolve();
      return;
    }
    if (record.activation !== attempt || record.generation !== attempt.generation) {
      // 过期尝试（生命周期操作已接管）：只清理自身资源，不触碰 generation/pending/终态
      try {
        await attempt.pending.dispose();
      } catch {
        // 清理失败不掩盖过期结论
      }
      completion.resolve();
      return;
    }
    // 当前尝试：先发布失败生命周期（任何回滚 await 之前），再解析唯一完成点驱动
    // 生命周期内的回滚清理；最后等待回滚终态（failed，或清理事件内 disable 合并的 disabled）
    const failure = this.publishLifecycle(record, {
      state: 'failed',
      reason: `激活失败: ${this.errorMessage(error)}`,
      error,
    });
    completion.resolve();
    try {
      await failure;
    } catch {
      // 生命周期承诺以成功收敛；防御性兜底
    }
  }

  /**
   * 发布生命周期操作：激活取消、失败回滚与停用收敛为同一操作。
   * 先发布后执行 —— 身份不变的 deferred 先登记到 record.lifecycle 并推进代际
   * （任何状态事件之前），再启动清理；disable/deactivate/dispose 及状态事件内
   * 的重入共享同一操作、等待同一真实完成 promise。
   * 目标终态由最后一位发布者决定：disabled 对旧失败终态有优先级 —— 回滚（failed）
   * 不覆盖已在途的停用（disabled）意图，其余终态按后到者为准（回滚清理事件内的
   * disable 以 disabled 覆盖已发布的 failed）。
   */
  private publishLifecycle(record: PluginRecord, target: LifecycleTarget): Promise<void> {
    const existing = record.lifecycle;
    if (existing) {
      const current = record.lifecycleTarget;
      if (!current || current.state !== 'disabled' || target.state !== 'failed') {
        record.lifecycleTarget = target;
      }
      return existing.promise;
    }
    // 推进代际：在途加载/激活/门面全部作废；晚到的贡献、订阅、结果整体拒绝
    record.generation += 1;
    record.lifecycleTarget = target;
    const deferred = createDeferred<void>();
    record.lifecycle = deferred;
    this.performLifecycle(record).then(
      () => {
        if (record.lifecycle === deferred) record.lifecycle = null;
        deferred.resolve();
      },
      (error) => {
        if (record.lifecycle === deferred) record.lifecycle = null;
        deferred.reject(error);
      },
    );
    return deferred.promise;
  }

  private async performLifecycle(record: PluginRecord): Promise<void> {
    // 捕获原始状态以选择清理分支；attempt 摘除后，晚到的激活结果只能自清（见 activateRecord）
    const originalState = record.state;
    const attempt = record.activation;
    record.activation = null;
    record.gate = null;
    record.state = 'deactivating';
    this.emitState(record, 'deactivating');

    try {
      if (attempt) {
        // 激活进行中/刚失败：先等待本尝试的唯一完成点（钩子 settle + 晚到返回值
        // 的 async Disposable 清理 + 暂存清理，见 activateRecord/failActivation），
        // 再执行一次可等待的 deactivate（回滚 completion）
        try {
          await attempt.completion;
        } catch {
          // 完成点承诺不拒绝；防御性兜底
        }
        try {
          await attempt.pending.dispose();
        } catch {
          // 清理失败不掩盖停用/回滚
        }
        await this.deactivateHookOnce(record);
      } else if (originalState === 'active') {
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
        if (errors.length > 0) {
          record.error = errors;
          record.reason = `停用时出错: ${errors.map((e) => this.errorMessage(e)).join('；')}`;
        }
      } else if (originalState === 'failed') {
        // failed 插件（校验/加载/激活失败）：幂等清理残留资源，保留失败原因（可重新启用重试）
        try {
          await record.owned.dispose();
        } catch {
          // 清理失败不掩盖停用
        }
        record.owned = new DisposableSet();
      }
      // loading / registered：无活动资源，直接进入终态
      if (this.disposedFlag) return;
      // 发布终态事件前让旧操作完整 detach：终态事件内的重入（enable 重新激活、
      // failed 后再次停用等）将发布全新的操作/尝试，而不是合并进已消费完 target
      // 的旧操作；终态前已取走 target，并发（非事件）合并的目标仍被消费
      const target = record.lifecycleTarget;
      record.lifecycleTarget = null;
      record.lifecycle = null;
      // 目标终态必由 publishLifecycle 发布；缺省防御避免卡在 deactivating
      if (!target) return;
      if (target.state === 'failed') {
        this.fail(record, target.reason ?? '激活失败', target.error);
      } else if (target.state === 'disabled') {
        record.state = 'disabled';
        this.emitState(record, 'disabled');
      } else {
        record.state = 'inactive';
        // 停用保留失败原因（failed 插件可重新启用重试）；其余场景清理残留错误信息
        if (originalState !== 'failed') {
          record.error = undefined;
          record.reason = undefined;
        }
        this.emitState(record, 'inactive');
      }
    } catch (error) {
      // 清理异常不外泄：所有调用方都等待同一操作，操作整体以成功收敛
      this.onError(error);
    } finally {
      // 本操作消费的激活尝试的完整流程完成点：active 未发布，则失败/取消回滚
      // 的终态（或销毁）已发布/已跳过发布，在此 settle —— 等待中的
      // register/enable/activate 不会悬挂
      attempt?.workflow.resolve();
    }
  }

  /** 已开始激活的插件的生命周期清理：执行一次可等待的 deactivate，失败不掩盖停用/激活结果 */
  private async deactivateHookOnce(record: PluginRecord): Promise<void> {
    try {
      await record.definition?.deactivate?.();
    } catch {
      // 清理钩子失败不掩盖停用/激活结果
    }
  }

  /** 门面有效性：宿主未销毁且代际未推进（停用/失败回滚后旧门面立即失效） */
  private isGateAlive(record: PluginRecord, attempt: ActivationAttempt): boolean {
    return !this.disposedFlag && record.generation === attempt.generation;
  }

  private createContext(
    record: PluginRecord,
    attempt: ActivationAttempt,
    gate: PluginGate,
  ): PluginContext {
    const context: PluginContext = {
      pluginId: record.id,
      manifest: record.manifest,
      hostVersion: this.hostVersion,
      events: gate.events,
      // 只读/执行能力面：插件不得绕过生命周期直接注册命令
      commands: gate.commands,
      services: this.services,
      contribute: (bundle) => {
        if (this.disposedFlag || record.generation !== attempt.generation) {
          throw new Error('插件已停用或宿主已销毁，无法提交贡献项');
        }
        const contributed = this.contributions.contribute(record.id, bundle);
        // 激活完成后的动态贡献并入当前 owned（record.activation 已清空），停用时一并清理
        if (record.activation === attempt) attempt.pending.add(contributed);
        else record.owned.add(contributed);
        return contributed;
      },
      getProject: () => this.project,
      log: (level, message, data) => {
        const line = `[lumora:plugin:${record.id}] ${level.toUpperCase()} ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ''}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        // eslint-disable-next-line no-console -- 宿主日志出口，info/debug 级别也需落到控制台
        else console.info(line);
      },
    };
    return context;
  }

  /**
   * 命令回调（when/execute）的 owner/代际绑定上下文：命令所属插件在册且门面存活时
   * 返回活门面；门面已随生命周期回收时返回永久失效的死上下文（订阅与命令操作一律拒绝），
   * 杜绝回退到宿主默认的活上下文。
   */
  private createCommandContext(instanceId: string): CommandContext | undefined {
    const record = this.plugins.get(instanceId);
    if (!record) return undefined;
    if (record.gate) {
      return {
        pluginId: record.id,
        events: record.gate.events,
        commands: record.gate.commands,
        services: this.services,
        getProject: () => this.project,
      };
    }
    return {
      pluginId: record.id,
      events: new TrackedEventBridge(this.events, new DisposableSet(), () => false),
      commands: new PluginCommands(this.commands, () => false),
      services: this.services,
      getProject: () => this.project,
    };
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
      // instanceId：稳定唯一的记录标识，事件关联与寻址（disable/enable）使用它；
      // pluginId 仅作 Manifest 展示（缺 id 时为 '<unknown>'），不得用于寻址
      instanceId: record.key,
      pluginId: record.id,
      state,
      error: record.error ?? record.reason,
    });
  }

  /** 按 instanceId 寻址记录（合法 Manifest 的 instanceId 与 manifest id 相同） */
  private requireRecord(instanceId: string): PluginRecord {
    const record = this.plugins.get(instanceId);
    if (!record) throw new Error(`未知插件: ${instanceId}`);
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
