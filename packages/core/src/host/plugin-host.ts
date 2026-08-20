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
 * 遇到 activating 时加入同一 promise，不提前返回快照。贡献注册句柄始终绑定
 * 创建它的尝试：registry 在句柄返回前同步发出事件，返回后复核 generation/
 * attempt identity，过期句柄归入该尝试的 pending 集合 —— 其 disposal 由尝试
 * completion 驱动、由生命周期显式等待（非 fire-and-forget），register()/
 * disable()/dispose() 不会在贡献项清理完成前返回；绝不并入当前代 owned。
 * 等待收敛：owner 与所有 joiner 等待在途尝试/生命周期/当前代加载后重新检查
 * 状态，循环加入终态事件内新建的激活与加载，直到本次 register/enable/activate
 * 意图达到稳定终态；active 发布后重新复核并加入事件内新建的生命周期；直接
 * activate 遇 deactivating 时等待收敛后重新驱动激活意图，不 silent success。
 * 加载身份事件前捕获：register 在调用可能同步发布 loading 事件的逻辑前捕获
 * 代际，loadDefinition 返回其实际创建的加载操作身份，恢复后只按该身份校验。
 * 激活取消、失败回滚与停用收敛为同一生命周期操作，disable/deactivate/dispose
 * 等待同一操作；激活失败先发布并认领失败生命周期、再执行回滚，回滚清理事件
 * 内的 disable 合并进同一操作且 disabled 优先于旧失败终态；终态事件发布前旧
 * 操作完整 detach，事件内重入的新激活失败进入独立生命周期并完成自身回滚。
 * 销毁 publish-first：dispose 先登记销毁状态与共享完成点再启动真实清理，所有
 * 并发/二次 dispose 等待同一清理；销毁开始后 register/enable/activate 明确
 * 拒绝，绝不创建孤立激活尝试。
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
  /** 销毁的真实清理完成点：publish-first 登记，所有并发/二次 dispose 等待同一清理 */
  private hostDispose: Promise<void> | null = null;
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
    if (this.disposedFlag || (record.state as PluginState) !== 'registered') {
      // 销毁已登记：经公共退出契约与共享宿主销毁完成点一并收敛，不得提前返回在途快照
      if (this.disposedFlag) await this.settleExit(record);
      return record.info();
    }

    if (!record.ready) {
      this.fail(record, record.reason ?? '插件未通过校验');
      return record.info();
    }
    if (record.manifest.enabled === false) {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
      return record.info();
    }

    // 任何可能同步发布 loading 状态事件的调用之前：捕获代际（跨代 ABA 防护基准）
    const generation = record.generation;
    // loadDefinition 返回它实际创建的（或共享的）加载操作身份：恢复后只按该身份校验
    const { promise: loadingPromise, operation: loading } = this.loadDefinition(record);
    await loadingPromise;
    const stateAfterLoad = record.state;
    // 过期注册流只能按取消路径结束（返回当前快照），不启动激活、不加入新代激活；
    // 销毁已登记时经公共退出契约与共享宿主销毁完成点一并收敛
    if (this.disposedFlag || record.generation !== generation) {
      if (this.disposedFlag) await this.settleExit(record);
      return record.info();
    }
    if (stateAfterLoad === 'activating') {
      // 加载期间重入 enable 已启动同代激活：加入同一完整激活流程，
      // 等待 active 发布或失败/取消回滚终态，不得提前返回 activating 快照；
      // 销毁已登记时经公共退出契约一并收敛
      await this.settleExit(record);
      return record.info();
    }
    // 加载期间可能被 disable/dispose 接管（状态已离开 loading），晚到加载结果不得改写停用状态；
    // 加载操作身份复核：同代内字段应已清空（操作完成）或仍指向本次操作
    if (
      stateAfterLoad === 'failed' ||
      stateAfterLoad !== 'loading' ||
      (record.loading !== null && record.loading !== loading)
    ) {
      // 销毁已登记时经公共退出契约一并收敛；未销毁时 join 任何在途流程后返回
      await this.settleExit(record);
      return record.info();
    }

    await this.activateRecord(record);
    return record.info();
  }

  async activate(id: string): Promise<void> {
    if (this.disposedFlag) throw new Error('插件宿主已销毁');
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
    // failed 插件停用保持 inactive（保留失败原因，可重新启用重试）。
    // 销毁已登记时生命周期终态落定为 inactive（不再发布状态事件），不得再补发 disabled
    if (!this.disposedFlag && !wasFailed && record.state === 'inactive') {
      record.state = 'disabled';
      this.emitState(record, 'disabled');
    }
  }

  async enable(instanceId: string): Promise<void> {
    // 销毁开始后明确拒绝新的启用意图：不得在销毁清理期间创建孤立激活尝试
    if (this.disposedFlag) throw new Error('插件宿主已销毁');
    const record = this.requireRecord(instanceId);
    if (!record.ready) {
      throw new Error(`插件 "${instanceId}" 不可启用（${record.reason ?? '未通过校验'}）`);
    }
    const state = record.state;
    if (state === 'active') return;
    if (state === 'activating') {
      // 激活已在途：加入同一完整激活流程（active 或失败/取消回滚终态），不提前返回；
      // 销毁已登记时经公共退出契约与共享宿主销毁完成点一并收敛
      await this.settleExit(record);
      return;
    }
    if (state === 'deactivating') {
      // 停用进行中：等待同一操作完整收敛 —— 循环加入终态事件内新建的激活/加载/
      // 生命周期，直到本次 enable 意图不再处于在途状态（不得提前返回
      // deactivating/loading 快照；awaitActivationOutcome 已纳入当前代 loading）
      for (;;) {
        await this.awaitActivationOutcome(record);
        if (this.disposedFlag) {
          // 销毁已登记：经公共退出契约与共享宿主销毁完成点一并收敛
          await this.settleExit(record);
          return;
        }
        const inFlight = record.state;
        if (inFlight === 'deactivating' || inFlight === 'loading') continue;
        break;
      }
      const after = record.state;
      if (after === 'active') return;
      if (after === 'activating') {
        // 收敛期间终态事件内启动的新激活仍在途：加入同一完整流程
        await this.settleExit(record);
        return;
      }
      if (after !== 'inactive' && after !== 'disabled' && after !== 'failed') return;
    }
    if (!record.definition) {
      // enabled:false 注册的插件首次启用时才加载入口（loadDefinition 按代共享，只加载一次）。
      // 记录进入时的代际：加载期间若被 disable（代际推进），晚到的加载结果不得改写停用状态。
      // 但若停用收敛的终态事件内已启动当前代新加载（disabled 事件内重入 enable，同一激活
      // 意图的延续），则共享该加载并收敛到稳定终态 —— 不得仅因本调用捕获的代际过期而
      // 提前返回 loading 快照（统一收敛状态机纳入当前代 loading operation）
      const generation = record.generation;
      const { promise: loadingPromise } = this.loadDefinition(record);
      await loadingPromise;
      if (this.disposedFlag) {
        // 销毁已登记：经公共退出契约与共享宿主销毁完成点一并收敛
        await this.settleExit(record);
        return;
      }
      if (record.generation !== generation) {
        // 代际已推进（disable/dispose 接管）：本次加载结果整体作废。本调用成为当前
        // 代流程的观察者 —— 只加入当前代 loading/activation/lifecycle 并等待稳定
        // 结果后直接返回，绝不依据残留 definition 重放已被取消的旧激活意图
        // （后到 disable 取消在途 enable 契约：新代缓存 definition 后再停用，
        // 旧调用也不得复活插件）。不得以 record.loading === null 判定新代已稳定：
        // 新 loader 可能已完成并进入在途 activation，直接返回会让外层 enable 以
        // activating 快照提前成功（代际复核只证明旧加载作废，不证明新代流程已终态）
        for (;;) {
          await this.awaitActivationOutcome(record);
          if (this.disposedFlag) {
            // 销毁已登记：经公共退出契约与共享宿主销毁完成点一并收敛
            await this.settleExit(record);
            return;
          }
          const inFlight = record.state;
          if (inFlight === 'deactivating' || inFlight === 'loading') continue;
          break;
        }
        await this.settleExit(record);
        return;
      }
      await this.awaitActivationOutcome(record);
      if (this.disposedFlag) {
        // 销毁已登记：经公共退出契约与共享宿主销毁完成点一并收敛
        await this.settleExit(record);
        return;
      }
      if (record.state === 'failed') return;
      if (!record.definition) return;
    }
    await this.activateRecord(record);
  }

  async dispose(): Promise<void> {
    if (this.disposedFlag) {
      // 二次/并发 dispose：等待首轮真实清理的同一共享完成点，不得独立提前 resolve
      return this.hostDispose ?? Promise.resolve();
    }
    // publish-first：先登记销毁状态与共享完成点（任何真实清理 await 之前），
    // 再启动清理 —— 销毁窗口内并发/重入的 dispose 全部等待同一真实清理
    this.disposedFlag = true;
    const deferred = createDeferred<void>();
    this.hostDispose = deferred.promise;
    void this.performHostDispose().then(
      () => deferred.resolve(),
      (error) => deferred.reject(error),
    );
    return deferred.promise;
  }

  private async performHostDispose(): Promise<void> {
    // 两阶段销毁：先同步为全部 record 发布生命周期操作（任何 await 之前），再统一等待。
    // 顺序逐条销毁卡在首个慢停用时，后序插件的失败/晚到分支也能加入已发布的生命周期
    // 与共享宿主销毁完成点收敛 —— 不得让后序插件以 in-flight 快照提前成功
    const records = [...this.plugins.values()];
    const disposals = records.map((record) => this.deactivateRecord(record, 'inactive'));
    await Promise.all(disposals);
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
   * 循环收敛：每次等待后重新检查状态 —— 终态事件内重入启动的新激活/新生命周期
   * 继续加入，直到本次调用意图达到稳定终态（无在途尝试、无在途生命周期、
   * 无当前代在途加载）。loading 只在代际相符时等待：异代加载是已被取消的
   * 废弃操作，其身份不复用、结果整体丢弃，等待它不构成任何调用意图。
   */
  private async awaitActivationOutcome(record: PluginRecord): Promise<void> {
    for (;;) {
      const attempt = record.activation;
      if (attempt) {
        try {
          await attempt.workflow.promise;
        } catch {
          // 流程完成点承诺不拒绝；防御性兜底
        }
        continue;
      }
      const lifecycle = record.lifecycle;
      if (lifecycle) {
        try {
          await lifecycle.promise;
        } catch {
          // 生命周期承诺以成功收敛；防御性兜底
        }
        continue;
      }
      const loading = record.loading;
      if (loading && loading.generation === record.generation) {
        try {
          await loading.deferred.promise;
        } catch {
          // 加载承诺不拒绝（加载失败走 fail 状态路径）；防御性兜底
        }
        continue;
      }
      return;
    }
  }

  /**
   * 公共退出契约：register/enable/activate 及内部激活/失败路径的 owner、joiner、
   * loading/activation 成功路径与 disposed/过期早退，在宿主销毁登记后统一经此收口。
   * 顺序固定：先解析本调用持有的本地完成点（如有）—— 驱动生命周期推进，避免环形
   * 等待；再等待记录级在途流程收敛到稳定终态；最后等待共享宿主销毁完成点（未销毁
   * 时无操作）。宿主销毁未完成前，公共调用不解析，也不以 loading/activating/
   * deactivating 过渡态作为成功结果。
   */
  private async settleExit(record: PluginRecord, completion?: Deferred<void>): Promise<void> {
    if (completion) completion.resolve();
    await this.awaitActivationOutcome(record);
    if (this.hostDispose) await this.hostDispose;
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
   * 返回本调用实际创建或共享的加载操作身份：调用方在事件前捕获代际、恢复后只按
   * 返回的身份校验 —— loading 事件内同步停用/重启用会替换代际与操作，过期流不得
   * 按新身份放行（跨代 ABA）。同代进行中的加载共享同一操作（loading 事件内重入
   * enable 等待同一真实完成，不会二次加载）；新一代 enable 不复用旧代操作，
   * 旧代的晚到结果按代际/身份整体丢弃。
   */
  private loadDefinition(
    record: PluginRecord,
  ): { promise: Promise<void>; operation: LoadingOperation | null } {
    if (record.definition) return { promise: Promise.resolve(), operation: null };
    const current = record.loading;
    if (current && current.generation === record.generation) {
      return { promise: current.deferred.promise, operation: current };
    }
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
    return { promise: deferred.promise, operation };
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
    // 销毁开始后不得创建孤立激活尝试（register/enable/activate 入口已拒绝；此处是
    // 内部路径的同一防线 —— 尝试必须能被生命周期收敛，销毁不发布新生命周期）
    if (this.disposedFlag) throw new Error('插件宿主已销毁');
    if (!record.ready || !record.definition) {
      throw new Error(`插件 "${record.id}" 无法激活（${record.reason ?? '定义缺失'}）`);
    }
    const state = record.state;
    if (state === 'active') return;
    if (state === 'activating') {
      // 激活已在途：加入同一完整激活流程（active 或失败/取消回滚终态），不提前返回；
      // 销毁已登记时经公共退出契约与共享宿主销毁完成点一并收敛
      await this.settleExit(record);
      return;
    }
    if (state === 'deactivating') {
      // 停用/回滚进行中：等待同一操作完整收敛（含终态事件内新建的激活/加载），
      // 然后落入下方公共路径重新驱动本调用的激活意图 —— 不得 silent success，
      // 也不得放弃意图（慢 deactivate 期间直接 activate 必须最终激活）。
      // 销毁在收敛期间登记：本调用加入共享销毁完成点收敛后返回（不创建激活尝试）
      for (;;) {
        await this.awaitActivationOutcome(record);
        if (this.disposedFlag) {
          await this.settleExit(record);
          return;
        }
        const inFlight = record.state;
        if (inFlight === 'deactivating' || inFlight === 'loading') continue;
        break;
      }
      const after = record.state;
      if (after === 'active') return;
      if (after === 'activating') {
        // 收敛期间终态事件内启动的新激活仍在途：加入同一完整流程
        await this.settleExit(record);
        return;
      }
      if (after !== 'inactive' && after !== 'disabled' && after !== 'failed') return;
    }

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
      // 事件内停用已摘除本尝试：先解析本尝试唯一完成点（驱动生命周期推进，
      // 避免环形等待），再经公共退出契约收敛 —— 取消的回滚未完成前不提前返回，
      // 销毁已登记时与共享宿主销毁完成点一并收敛
      await this.settleExit(record, completion);
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
      // disable 不会在晚到 async Disposable 清理结束前返回；随后加入同一
      // 生命周期/新尝试收敛，事件内停用引发的回滚未完成前不得提前返回
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
      // 先解析本尝试唯一完成点（驱动生命周期推进，避免环形等待），
      // 再经公共退出契约收敛：事件内停用引发的回滚未完成前不提前返回，
      // 销毁已登记时与共享宿主销毁完成点一并收敛
      await this.settleExit(record, completion);
      return;
    }
    record.activation = null;
    record.owned.add(attempt.pending);
    if (result != null) record.owned.add(result);
    record.state = 'active';
    this.emitState(record, 'active');
    completion.resolve();
    attempt.workflow.resolve();
    // active 事件内启动的停用/销毁已接管（状态离开 active / 宿主销毁）：
    // 加入同一生命周期收敛 —— 事件内慢停用（deactivate 钩子挂起）未完成前，
    // 本激活调用不得提前返回在途 deactivating 快照；销毁已登记时经公共退出
    // 契约与共享宿主销毁完成点一并收敛
    if (this.disposedFlag || record.state !== 'active') {
      await this.settleExit(record);
    }
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
      // 销毁已接管：先解析本尝试唯一完成点（驱动已发布的生命周期清理，避免环形
      // 等待），再经公共退出契约收敛 —— 两阶段销毁保证本记录的生命周期已在途；
      // 不得在本记录清理结束后独立提前返回（宿主仍可能卡在其他记录的慢停用）
      await this.settleExit(record, completion);
      return;
    }
    if (record.activation !== attempt || record.generation !== attempt.generation) {
      // 过期尝试（生命周期操作已接管）：只清理自身资源，不触碰 generation/pending/终态
      try {
        await attempt.pending.dispose();
      } catch {
        // 清理失败不掩盖过期结论
      }
      // 先解析本尝试唯一完成点，再经公共退出契约收敛：尝试已被生命周期摘除，
      // 回滚进行中不提前返回；销毁在清理期间登记时与共享宿主销毁完成点一并收敛
      await this.settleExit(record, completion);
      return;
    }
    // 当前尝试：先发布失败生命周期（任何回滚 await 之前），再解析唯一完成点驱动
    // 生命周期内的回滚清理；最后等待回滚终态（failed，或清理事件内 disable 合并的
    // disabled），并收敛终态事件内重入启动的新激活
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
    // 等待回滚终态发布，并收敛终态事件内重入启动的新激活；
    // 销毁在回滚期间登记时经公共退出契约与共享宿主销毁完成点一并收敛
    await this.settleExit(record);
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
      // 发布终态事件前让旧操作完整 detach：终态事件内的重入（enable 重新激活、
      // failed 后再次停用等）将发布全新的操作/尝试，而不是合并进已消费完 target
      // 的旧操作；终态前已取走 target，并发（非事件）合并的目标仍被消费
      const target = record.lifecycleTarget;
      record.lifecycleTarget = null;
      record.lifecycle = null;
      // 目标终态必由 publishLifecycle 发布；缺省防御避免卡在 deactivating
      if (!target) return;
      if (this.disposedFlag) {
        // 销毁已接管：终态仍落定但不再发布状态事件 —— 销毁后返回的公共快照
        // 不得停留在 deactivating/loading 等过渡态
        if (target.state === 'failed') {
          record.state = 'failed';
          record.reason = target.reason ?? '激活失败';
          record.error = target.error;
        } else if (target.state === 'disabled') {
          record.state = 'disabled';
        } else {
          record.state = 'inactive';
          if (originalState !== 'failed') {
            record.error = undefined;
            record.reason = undefined;
          }
        }
        return;
      }
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
        // registry 在句柄返回前同步发出 contribution:changed：事件内停用会推进代际
        // 并摘除本尝试 —— 返回后必须复核身份。过期句柄归入创建它的尝试的 pending
        // 集合：该集合的 disposal 由尝试 completion 驱动、由生命周期显式等待
        // （非 fire-and-forget），register()/disable()/dispose() 不会在多项贡献项
        // 清理完成前返回；绝不并入当前代 owned（停用流程只清理本尝试的 pending，
        // 并入即遗留停用后仍可见的资源）。复核窗口内 completion 必然未 settle
        // （唯一 settle 点都在本回调返回后的调用栈中），pending 的 dispose 必然
        // 未启动，加入后必被显式等待
        if (this.disposedFlag || record.generation !== attempt.generation) {
          attempt.pending.add(contributed);
          return contributed;
        }
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
