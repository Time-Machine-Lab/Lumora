/**
 * 项目自动保存（FR-011 / NFR-003 / AC2）：
 * - 编辑器每次变更（project:changed）后防抖 AUTOSAVE_DEBOUNCE_MS 触发保存；
 * - 脏状态 = 编辑器 revision 与上次成功保存 revision 不一致，或 revision 一致但
 *   内容指纹不同（同 uri 同 revision 的运行期替换/分叉，见 isUnsaved）；
 * - 保存失败（配额不足 / 存储错误 / revision 冲突）保持脏状态与快照并广播可操作错误，
 *   绝不覆盖较新的已存内容（CAS 防倒退）；冲突不提供自动恢复 —— 必须显式解决
 *   （加载较新版本 / 另存副本），防止「本地计数追平后覆盖」的数据丢失；
 * - 项目切换 / 关闭：旧项目的未保存快照排入串行任务链（绑定旧 uri），不被取消、
 *   不丢失；保存结果按 { uri } 绑定回写（旧 uri 成功也推进该 uri 的已提交基线），
 *   绝不污染新打开项目的状态；切换/关闭时保存失败的快照按 uri 保留为恢复快照，
 *   重新打开该 uri 时以「恢复快照可用」状态明示，可另存副本或重试；
 * - 会话一致性：open/close/resetTo 递增会话代，异步续体在每次 await 后复验
 *   （会话代 + uri 仍为当前），过期任务的结果一律丢弃，绝不覆盖新状态；
 * - 首次落盘诚实：新项目先进入 saving，存储提交成功后才转 clean（不假报已保存）；
 * - 持久化不可用（store 为 null）：明示「仅内存」状态，不报错、不假报已保存，
 *   关闭时无排空语义（无可持久化内容）；
 * - 页面隐藏（visibilitychange/pagehide）与显式 flush（关闭项目 / 卸载运行时）
 *   时尽力冲刷未保存变更（flush 返回类型化结果，调用方据其决定是否放行关闭）。
 *
 * 状态完全由编辑器事件驱动：openProject 发出的 project:changed 自动重设脏基线，
 * reset/close 发出的 { project: null } 自动冲刷并归位。
 */

import type { Project, SceneEditor } from '@lumora/core';
import { findJsonEncodingProblem } from '@lumora/core';
import type { ProjectStorage, SaveFailureCode, SaveOutcome } from './project-storage';
import { sameProjectContent, stableStringify } from './project-storage';

export const AUTOSAVE_DEBOUNCE_MS = 2000;

/** flush 稳定排空的轮次上限：连续排空仍不一致视为无法稳定（防御编辑风暴） */
export const MAX_FLUSH_DRAIN_ROUNDS = 32;

/** flush 入队任务的内部结果：done = 任务体已保存（或确认无需保存）；superseded =
 *  排队期间或保存 await 期间会话失效（关闭/切换，第十九轮严重 3 + 第二十一轮
 *  阻断 2），由 superseding drain 承载，flush() 等待链尾后读取该会话代的一次性
 *  drain 结果传播。superseded 携带实际保存的 target/outcome（第二十三轮严重 6）：
 *  无 drain 记录回退时以任务实际落盘的内容判定，不用 flush 捕获的旧快照误判
 * （saved = null 表示任务执行前会话已失效、未保存任何内容） */
type FlushTaskResult =
  | { kind: 'done'; outcome: SaveOutcome }
  | { kind: 'superseded'; saved: Project | null; outcome: SaveOutcome | null };

export type AutosaveState =
  | { status: 'idle' } // 无打开项目
  | { status: 'clean' } // 已同步保存
  | { status: 'dirty' } // 有未保存变更（防抖等待中）
  | { status: 'saving' } // 保存进行中
  | { status: 'error'; code: SaveFailureCode; message: string } // 保存失败（仍为脏）/ 恢复快照待处理
  | { status: 'memory' }; // 持久化不可用：仅内存编辑，不假报已保存

export interface AutosaverOptions {
  debounceMs?: number;
}

/** 锁存错误：冲突 / 恢复快照待处理。编辑动作不得自动解除（须显式解决）。 */
interface LatchedError {
  uri: string;
  code: 'revision-conflict' | 'recovery-available';
  message: string;
}

/** 已提交基线：revision + 已提交内容的稳定序列化指纹（同 revision 内容分叉判定）。
 *  fingerprint 为 null = 内容不可 JSON 编码（无法可靠序列化比较）。 */
interface CommittedBaseline {
  revision: number;
  fingerprint: string | null;
}

/** 恢复记录（第二十三轮阻断 4 + 第二十八轮阻断 2）：快照 + 内容指纹 + 创建代数。
 *  同一 uri 的多次保存失败各自入录独立 fork（按 generation 区分，同指纹去重）。
 *  保存成功只清除「自己覆盖的恢复项」（落盘内容指纹与恢复快照一致）；同 uri
 *  更新代内容落盘不得清除前代恢复快照 —— 前代内容仅存于恢复区，仍可恢复 */
interface RecoveryRecord {
  snapshot: Project;
  fingerprint: string | null;
  generation: number;
}

/**
 * 内容指纹（不含 revision 计数器）：分叉判定关注内容本身；revision 由数字比较
 * 单独负责（撤销回已保存内容时 revision 递增但内容一致，不构成内容分叉）。
 * 无异常、无信息丢失（第六轮 #1）：先以 core 的 JSON 编码边界识别不可编码数据
 * （undefined/NaN/BigInt/循环引用/数组非索引键 —— JSON.stringify 会丢字段或抛错），
 * 返回 null 表示不可比较 —— 调用方一律视为未保存（不可编码内容不得因序列化
 * 丢字段而误判为「与已保存内容相同」）。
 */
function contentFingerprint(project: Project): string | null {
  if (findJsonEncodingProblem(project)) return null;
  const { revision: _revision, ...content } = project;
  return stableStringify(content);
}

/**
 * 任务边界排水（第三十七轮阻断 1）：返回在下一个 task 边界解析的 promise。
 * setTimeout 回调作为新任务，必然排在整条微任务队列之后 —— 事件循环只有在
 * 微任务队列彻底排空（含递归追加的任意深度 queueMicrotask）后才会开始下一个
 * 任务，因此复查前的所有微任务链编辑都已执行（pending 已置 / epoch 已递增）。
 * 修复前用 await null 只让出一个 FIFO 微任务位置：审查员四层嵌套
 * queueMicrotask 的编辑在复查 + forceTeardown 之后才执行 —— autosaver 已
 * disposed 不再接收、编辑器未释放仍接受写入，内容静默丢失（深度 0-2 通过、
 * 3-8 稳定失败）。深度扫描确认线性化点前编辑全部落盘、点后编辑被已释放的
 * 编辑器显式拒绝（runtime 终态在同一任务边界 drain 内释放 editor）。
 */
function taskTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class ProjectAutosaver {
  private store: ProjectStorage | null;
  private currentUri: string | null = null;
  /** 各 uri 已确认落盘的基线（含已切换走的项目：旧项目保存成功也推进基线）。
   *  null = 尚无任何已确认记录（首存基线）：仅 load/对账成功后才建立数字基线，
   *  首存与重试按创建语义（create-only）执行，绝不把「未确认存在」当作数字基线。
   *  净/脏判定统一以此为准（isUnsaved）：首存失败后不得以「revision 未变」判净。 */
  private readonly committedByUri = new Map<string, CommittedBaseline | null>();

  /**
   * 项目是否有未保存变更（以已确认落盘的 committed baseline 判净，而非打开时
   *  revision 快照）：baseline 为 null（首存从未成功）恒为未保存 —— 首存失败后
   *  flush/排空必须重试或阻断，绝不假报已保存放行切换。
   *  revision 一致时进一步比较内容指纹：同 uri 同 revision 的运行期替换
   *  （导入/替换打开）不得被误判为净（第五轮 #3）。
   */
  private isUnsaved(project: Project): boolean {
    const baseline = this.committedByUri.get(project.uri);
    if (baseline === undefined || baseline === null) return true;
    if (baseline.revision !== project.revision) return true;
    const fingerprint = contentFingerprint(project);
    // 当前内容不可编码（undefined/NaN/BigInt/循环引用/数组非索引键）→ 恒判未保存，
    // 绝不因 JSON.stringify 丢字段而误判净（第六轮 #1）；保存路径将返回类型化错误
    if (fingerprint === null) return true;
    return fingerprint !== baseline.fingerprint;
  }
  /** 最新未保存快照（编辑器的只读冻结快照）：编辑后立即捕获，reset/close 后仍可冲刷 */
  private pending: Project | null = null;
  /** 变更代（第三十六轮阻断 1）：changed() 每次捕获项目变更 +1 —— dispose() 的
   *  flush 判 clean 后在同一同步段复查 epoch/pending 未变化才允许封存（密封
   *  原子化）：微任务窗口内到达的编辑必须继续冲刷，绝不取消 timer 置 disposed
   *  丢内容。epoch 覆盖「编辑已在 flush 排空」场景（pending 已清但确有新编辑，
   *  须再确认一轮），pending 为主哨兵。 */
  private changeEpoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 排队占位（第十七轮严重 3，所有权化）：{ 入队会话代, 一次性 ticket } ——
   *  - 新会话 runSave 遇同会话占位即 return；旧会话占位不阻塞，直接覆盖重入队；
   *  - 任务执行时仅清理自己持有的 ticket：旧会话任务无条件清位会吞掉新会话
   *    占位，新会话随后的编辑会重复排队（同一防抖多任务保存）；
   *  占位在任务开始时清除，在途阶段由 saveInFlight 识别。 */
  private saveQueued: { session: number; ticket: object } | null = null;
  /** 保存是否在途（第十二轮一般 #7）：runSave 的任务已开始执行但尚未完成 ——
   *  saveQueued 在任务开始时即清位，在途阶段只能由该标志识别 */
  private saveInFlight = false;
  /** 串行任务链尾：所有保存/排空/对账按序执行，互不交错 */
  private chainTail: Promise<void> = Promise.resolve();
  private debounceMs: number;
  private readonly stateListeners = new Set<(state: AutosaveState) => void>();
  private disposed = false;
  /** 会话代：open/close/resetTo 递增；异步续体据此识别过期任务并丢弃其结果 */
  private session = 0;
  /** 状态广播临界区深度（第九轮 #1）：switchOpen 的 resetTo + editor.openProject
   *  整轮事件分发期间 emit 一律丢弃（代际失效）—— 编辑器提交可能在分发中嵌套
   *  触发 close/open（重入），中间态（idle/clean/dirty 抖动）不得外泄；临界区
   *  结束后由 switchOpen 以最新编辑器状态统一发布一次最终态 */
  private broadcastGuard = 0;
  /** 状态广播代际（第九轮 #1）：emit 分发期间监听器回调可能同步提交编辑，
   *  嵌套触发新的 emit —— 外层正在分发的状态此时已陈旧（新状态已先送达部分
   *  监听器）。每轮分发开启新代际，每次回调后复验：代际已变（发生过嵌套发布）
   *  立即终止本轮分发，绝不让陈旧状态在更新状态之后送达其余监听器 */
  private broadcastEpoch = 0;
  /** 锁存错误（revision 冲突 / 恢复快照待处理）：编辑不得自行转 dirty 隐藏解决入口。
   *  第三十一轮阻断 2 改按 uri 分键：非当前 uri 的重试/对账失败只锁存该 uri
   *  （该 uri 重新打开或恢复解决时呈现），绝不覆盖当前项目的锁存 —— 修复前
   *  单一 latched 字段被非当前 uri 的 retryRecovery 冲突覆写后，当前 uri 的
   *  flush/close 屏障失去锁存拦截、恢复解决入口消失 */
  private readonly latchedByUri = new Map<string, LatchedError>();
  /** 当前 uri 的锁存（getter/setter 统一经 latchedByUri 分键读写） */
  private get latched(): LatchedError | null {
    if (this.currentUri === null) return null;
    return this.latchedByUri.get(this.currentUri) ?? null;
  }
  private set latched(error: LatchedError | null) {
    if (error === null) {
      if (this.currentUri !== null) this.latchedByUri.delete(this.currentUri);
      return;
    }
    this.latchedByUri.set(error.uri, error);
  }
  /** 切换/关闭时保存失败被保留的旧项目快照（按 uri → 按 generation 的多 fork），
   *  重新打开时明示可恢复（第二十八轮阻断 2：同一 uri 多次保存失败各自入录
   *  独立 fork，保存成功只清除「自己覆盖的恢复项」—— 指纹一致即落盘内容就是
   *  该恢复快照；同 uri 更新代内容落盘不得清除前代恢复快照，前代内容仅存于
   *  恢复区仍可恢复）。外层键存在性语义不变（has/get/delete 直接操作） */
  private readonly recovery = new Map<string, Map<number, RecoveryRecord>>();
  /** 恢复记录创建代数：每次入录递增（记录审计/区分同 uri 先后入录） */
  private recoveryGeneration = 0;
  /** 每代 superseding drain 的一次性结果（第二十一轮阻断 3 + 第二十三轮严重 7）：
   *  按 drain 服务的会话代记录 —— 同 uri 多代 drain 各占独立键，后代成功不再
   *  覆盖前代失败（第十九轮的按 uri 记录会被后代 drain 覆盖，原 flush 误读后代
   *  结果）。记录是 drain 任务 promise：绑定同一会话代的 flush 等待链尾后
   *  observe 登记为 waiter，所有已登记 waiter 共享同一 promise/结果，waiters
   *  计数归零（无消费者）后才删除记录 —— 并发 flush 各自 observe 同代记录，
   *  结果一致，先完成者不得抢先清理。open 不做任何清理 —— 尚未结算的旧 drain
   *  记录在对应代键上，与新一代无关。从未被消费的记录（无 flush 等待的 drain）
   *  受大小上限约束，最旧代被淘汰（flush 读不到时回落到恢复快照/已提交基线
   *  判定，仍不会误报成功）。 */
  private readonly drainOutcomeByEpoch = new Map<number, Promise<SaveOutcome>>();
  /** drainOutcomeByEpoch 防御性上限：实际每次 drain 都被其会话代的 flush 消费，
   *  上限仅为防极端长会话下的内存增长 */
  private static readonly DRAIN_OUTCOME_KEEP = 16;
  /** 各代 drain 记录的等待者计数（第二十三轮严重 7）：observe 登记、release 注销，
   *  计数归零才删除记录 —— 已登记 waiter 共享同一 drain promise/结果 */
  private readonly drainWaiters = new Map<number, number>();

  /** 登记为某代 drain 结果的等待者；返回共享的 drain promise（无记录则 undefined）。 */
  private observeDrain(epoch: number): Promise<SaveOutcome> | undefined {
    const promise = this.drainOutcomeByEpoch.get(epoch);
    if (!promise) return undefined;
    this.drainWaiters.set(epoch, (this.drainWaiters.get(epoch) ?? 0) + 1);
    return promise;
  }

  /** 等待者注销：计数归零（无消费者）后才删除该代 drain 记录。 */
  private releaseDrain(epoch: number): void {
    const count = (this.drainWaiters.get(epoch) ?? 1) - 1;
    if (count <= 0) {
      this.drainWaiters.delete(epoch);
      this.drainOutcomeByEpoch.delete(epoch);
    } else {
      this.drainWaiters.set(epoch, count);
    }
  }

  constructor(
    private readonly editor: SceneEditor,
    store: ProjectStorage | null,
    options: AutosaverOptions = {},
  ) {
    this.store = store;
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.handlePageHide);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
  }

  /** 是否已终态化（第三十六轮严重 3：ProjectPersistence 的 dispose 防御兜底
   *  需要区分「异常来自终态段」与「异常来自可恢复段」） */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 订阅保存状态变化；返回取消订阅函数。 */
  onState(listener: (state: AutosaveState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** 持久化就绪后接入（init 完成）：对当前打开的项目重新对账（冷启动不丢事件）。 */
  setStore(store: ProjectStorage | null): void {
    this.store = store;
    const project = this.editor.getProject();
    if (this.disposed) return;
    if (store && project && project.uri === this.currentUri) {
      void this.enqueue(() => this.reconcile(project));
    } else if (!store && this.currentUri) {
      this.emit({ status: 'memory' });
    }
  }

  /** 重设防抖窗口（init 传入配置时调用）。 */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }

  /** 编辑器事件入口：project:changed（含 null = 关闭）。 */
  changed(project: Project | null): void {
    if (this.disposed) return;
    // 第三十六轮阻断 1：任何到达的项目变更（含关闭）都递增变更代 —— dispose
    // 的密封裁决据此识别「flush 判 clean 之后才到达」的微任务窗口编辑
    this.changeEpoch += 1;
    if (!project) {
      this.close();
      return;
    }
    if (project.uri !== this.currentUri) {
      // 项目切换：编辑器已完成切换，旧快照只能来自 pending（编辑时同步捕获）
      this.open(project);
      return;
    }
    const dirty = this.isUnsaved(project);
    if (dirty) {
      // 立即捕获快照：reset/close 会先清空编辑器再发 null 事件，届时已无法读取
      this.pending = project;
      if (!this.store) {
        // 持久化不可用：明示仅内存，不进入保存流程也不假报已保存
        this.emit({ status: 'memory' });
        return;
      }
      if (this.latched && this.latched.uri === project.uri) {
        // 锁存错误期间继续编辑：仍以错误状态呈现（解决入口不被脏状态掩盖）
        this.emit({ status: 'error', code: this.latched.code, message: this.latched.message });
        return;
      }
      this.emit({ status: 'dirty' });
      this.scheduleSave();
    } else {
      this.pending = null;
      if (this.latched && this.latched.uri === project.uri) {
        this.emit({ status: 'error', code: this.latched.code, message: this.latched.message });
        return;
      }
      this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
    }
  }

  /** 打开/切换项目：先排空旧项目的未保存快照（串行链上绑定旧 uri），再切换基线并对账。 */
  private open(project: Project): void {
    const prevUri = this.currentUri;
    const previous = this.pending;
    // 排空结果按「被排空内容所属的会话代」记录（第二十一轮阻断 3）：递增前捕获，
    // drain 记录挂在旧代键上，新一代 open/close 不触碰
    const drainingEpoch = this.session;
    this.cancelTimer();
    this.session += 1;
    this.currentUri = project.uri;
    this.pending = null;
    this.saveQueued = null;
    this.latched = null;
    // 新项目尚无「已确认落盘」记录：基线置 null（create-only 语义），数字基线
    // 仅由对账的 load/保存成功建立 —— 首存失败不被吞，后续保存仍按创建语义重试
    this.committedByUri.set(project.uri, null);
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous, drainingEpoch);
    }
    // 对账结果决定新项目的真实状态（首存 saving→clean / 冲突 error / 恢复快照 error / 一致 clean）
    void this.enqueue(() => this.reconcile(project));
  }

  /** 关闭项目：排空未保存快照后归位。 */
  private close(): void {
    const prevUri = this.currentUri;
    const previous = this.pending;
    const drainingEpoch = this.session;
    this.cancelTimer();
    this.session += 1;
    this.currentUri = null;
    this.pending = null;
    this.saveQueued = null;
    // 第三十一轮阻断 2：按 uri 清除锁存（setter 在 currentUri 置空后是空操作）
    if (prevUri !== null) this.latchedByUri.delete(prevUri);
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous, drainingEpoch);
    }
    this.emit({ status: 'idle' });
  }

  /**
   * 显式冲突解决「加载较新版本」的状态重置：以传入项目（存储内容）为基线。
   * 丢弃未保存变更是用户的显式选择：恢复快照一并作废。
   * 不广播状态（第八轮 #5）：最终状态由调用方（switchOpen / 编辑器重开后的
   * changed() 链）按新基线判定后统一发出 —— 状态切换与编辑器提交做成不向外
   * 广播的原子操作，监听器不会看到「基线已换但编辑器未切」的中间态。
   */
  resetTo(project: Project): void {
    this.cancelTimer();
    this.session += 1;
    this.currentUri = project.uri;
    this.pending = null;
    this.saveQueued = null;
    this.latched = null;
    this.committedByUri.set(project.uri, { revision: project.revision, fingerprint: contentFingerprint(project) });
    this.recovery.delete(project.uri);
  }

  /**
   * 原子切换（第八轮 #5 + 第九轮 #1）：autosaver 状态重置与编辑器提交合并为
   * 不向外广播的原子操作 —— resetTo 不 emit，editor.openProject 的整轮事件分发
   * 期间所有状态广播被广播守卫（broadcastGuard）丢弃（代际失效），分发返回后
   * 以最新编辑器状态统一发布一次最终态；监听器不会看到「基线已换但编辑器未切」
   * 或「切换过程抖动」的任何中间态，在 save-state 回调中同步提交的编辑也只会
   * 落在已切换完成的内容上（正常 dirty 路径，不再有「后续 openProject 覆盖
   * 新编辑」的窗口）。
   * 编辑器提交失败时回滚 autosaver 状态并上抛（防御：传入项目已通过存储校验
   * 与结构化克隆，正常不会抛错）；失败路径同样零广播，由调用方返回类型化失败。
   */
  switchOpen(project: Project): void {
    const prevUri = this.currentUri;
    const prevPending = this.pending;
    const prevQueued = this.saveQueued;
    const prevInFlight = this.saveInFlight;
    const prevTimer = this.timer;
    const prevLatched = this.latched;
    const prevSession = this.session;
    const prevBaseline = this.committedByUri.get(project.uri);
    const prevBaselineHas = prevBaseline !== undefined;
    const prevRecovery = this.recovery.get(project.uri);
    const prevRecoveryHas = this.recovery.has(project.uri);
    this.resetTo(project);
    this.broadcastGuard += 1;
    try {
      this.editor.openProject(project);
    } catch (error) {
      this.broadcastGuard -= 1;
      this.currentUri = prevUri;
      this.pending = prevPending;
      this.saveQueued = prevQueued;
      this.saveInFlight = prevInFlight;
      this.latched = prevLatched;
      this.session = prevSession;
      if (prevBaselineHas) this.committedByUri.set(project.uri, prevBaseline!);
      else this.committedByUri.delete(project.uri);
      if (prevRecoveryHas) this.recovery.set(project.uri, prevRecovery!);
      else this.recovery.delete(project.uri);
      // 回滚时恢复保存意图（第十二轮一般 #7）：resetTo 已取消防抖定时器且未恢复。
      // 分状态跟踪 timer/queued/in-flight，仅恢复 reset 前真实存在的待执行 timer，
      // 不臆造调度 ——
      // - timer（待执行）：reset 前存在真实待执行 timer（编辑后防抖等待中）→
      //   重建同长 timer（旧句柄已被 clearTimeout，必须新建）；
      // - queued/in-flight：reset 前保存已排队或任务已在途 → 链中任务继续推进
      //   基线，不重复调度（重复调度使保存调用翻倍，释放阻塞后断言调用次数）；
      // - 三者皆无但旧项目仍有未落盘内容（第十轮 #1 严重：保存失败后未再编辑）
      //   → 重新调度，切换失败后自动落盘仍会触发（用户不再编辑，存储停留在
      //   旧 revision）
      const rolledBack = this.editor.getProject();
      if (prevTimer !== null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.runSave();
        }, this.debounceMs);
      } else if (
        !prevQueued &&
        !prevInFlight &&
        rolledBack &&
        rolledBack.uri === this.currentUri &&
        this.isUnsaved(rolledBack)
      ) {
        this.scheduleSave();
      }
      throw error;
    }
    this.broadcastGuard -= 1;
    // 临界区结束：以最新编辑器状态统一发布一次最终态（期间被守卫吸收的
    // changed() 链已维护 pending/定时器，此处只补最后一次状态广播）
    const current = this.editor.getProject();
    if (current && current.uri === this.currentUri) {
      if (this.latched && this.latched.uri === current.uri) {
        this.emit({ status: 'error', code: this.latched.code, message: this.latched.message });
      } else if (this.isUnsaved(current)) {
        this.emit({ status: 'dirty' });
      } else {
        this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
      }
    } else {
      this.emit({ status: 'idle' });
    }
  }

  /** 当前打开项目是否有未保存编辑（「另存副本」源内容决策，第八轮 #2）。 */
  hasUnsavedContent(): boolean {
    const project = this.editor.getProject();
    if (!project) return false;
    return this.isUnsaved(project);
  }

  /**
   * 立即冲刷未保存变更（关闭项目 / 卸载 / 页面隐藏 / 重试）：稳定排空屏障 ——
   * 循环保存直到编辑器与已提交基线一致（排空期间的新编辑也会被追平），等待在途保存。
   * 净/脏以 committed baseline 判定（isUnsaved）：首存失败（baseline 仍为 null）
   * 时即使 revision 未变也必须重试保存 —— 失败如实返回，调用方不得放行关闭/切换
   * （内容仍在编辑器与恢复快照中），绝不假报成功。
   * 排队期间会话失效（关闭/切换，第十九轮严重 3 + 第二十一轮阻断 2/3 + 第二十三轮
   * 阻断 1/严重 6/7）：每轮任务体捕获 {uri, session}，执行时与每次 await 后都
   * 复验 —— 保存挂起期间编辑/关闭/切换后，该次保存的成功只代表旧内容落盘，新
   * 内容由 close/open 同步排入的 superseding drain 承载，flush() 等待链尾后
   * 读取该会话代的一次性 drain 结果并传播（失败如实返回，不得映射为成功；同
   * uri 多代 drain 各占独立键，后代成功不覆盖前代失败；并发 waiter 共享同一
   * drain promise/结果，无消费者后才清理）。无脏入口同样绑定 {uri, session}：
   * 等待期间同栈编辑+关闭追加的 drain 也必须等待并传播，不得以「编辑器已空」
   * 假报成功。无 drain 记录（绑定内容从未进入排空，如新项目打开后从未编辑、
   * reconcile 未完成即重置）时以「实际保存的 target 是否已落盘」判定（任务
   * 已保存的内容推进基线则成功，保存失败如实返回），恢复快照存在或基线未
   * 覆盖都如实失败 —— 绝不放行「内容仍在恢复区或从未落盘」的假成功。
   * 返回类型化结果：保存失败或锁存错误（冲突/恢复待处理）都如实返回。
   */
  async flush(): Promise<SaveOutcome> {
    if (this.disposed) return { ok: true };
    // 仅内存模式：无可持久化内容，排空无意义也不阻塞关闭
    if (!this.store) return { ok: true };
    this.cancelTimer();
    for (let i = 0; i < MAX_FLUSH_DRAIN_ROUNDS; i += 1) {
      if (this.latched && this.latched.uri === this.currentUri) {
        // 锁存错误下排空无法稳定：返回锁存错误，由调用方阻断关闭/切换并引导显式解决
        return { ok: false, code: this.latched.code, message: this.latched.message };
      }
      const project = this.pending ?? this.editor.getProject();
      if (project && project.uri === this.currentUri && this.isUnsaved(project)) {
        const uri = project.uri;
        // 本轮绑定 {uri, session}（第二十一轮阻断 2）：会话代在入队前捕获，任务
        // 体执行时与保存 await 后都复验 —— 排队期间/保存挂起期间会话失效都
        // 返回 superseded，由 superseding drain 的结果定论
        const session = this.session;
        // 第二十八轮阻断 3：入队时即登记该会话代的 drain waiter —— 新 drain
        // 入队时（enqueueDrain 同步段）淘汰最旧且无 waiter 的 epoch 记录；若
        // 等到 superseded 分支才 observe，慢保存 await 期间新入队 drain 可能
        // 已把本代记录淘汰（waiter=0），flush 读不到真实失败、回落到基线比较
        // 误报成功。记录可能尚不存在：仅计数（enqueueDrain 创建记录时计数
        // 已 ≥1，淘汰循环跳过），try/finally 保证任何路径释放
        this.drainWaiters.set(session, (this.drainWaiters.get(session) ?? 0) + 1);
        try {
          // 第十八轮严重 3：入队任务执行时重读最新内容，不闭包调用时的旧快照 ——
          // 慢 reconcile/在途保存占队期间 flush 捕获 rev1、等待中继续编辑到 rev2
          // 时，重放 rev1 会以旧 revision 覆写较新记录触发假 revision-conflict
          // （锁存后关闭/切换被错误阻断）；与 runSave 任务体一致地按绑定 uri
          // 取 pending/编辑器最新快照保存，已净（runSave 已落盘最新内容）则直接成功
          const result = await this.enqueue<FlushTaskResult>(async (): Promise<FlushTaskResult> => {
            if (this.disposed) return { kind: 'done', outcome: { ok: true } };
            if (!this.isFresh(uri, session)) {
              // 排队期间会话失效（关闭/切换）——旧项目未保存内容已由 close/open
              // 同步排入 superseding drain（drain 排在当前任务之后，任务体直接
              // await 会自锁，故返回 superseded 由 flush() 等待链尾读取）
              return { kind: 'superseded', saved: null, outcome: null };
            }
            const latest = this.pending ?? this.editor.getProject();
            if (!latest || latest.uri !== uri) return { kind: 'done', outcome: { ok: true } };
            if (!this.isUnsaved(latest)) return { kind: 'done', outcome: { ok: true } };
            const outcome = await this.saveSnapshot(latest);
            // 第二十一轮阻断 2：保存 await 期间会话可能已失效（继续编辑后关闭/
            // 切换）——该次保存的成功只代表旧内容落盘，rev2 由 superseding
            // drain 承载，其结果才决定本轮成败；不得因 rev1 成功返回 done/ok
            // （否则外层在「当前项目已净/为空」时误报成功，rev2 未落盘被放行）
            if (!this.isFresh(uri, session)) return { kind: 'superseded', saved: latest, outcome };
            return { kind: 'done', outcome };
          });
          if (result.kind === 'done') {
            if (!result.outcome.ok) return result.outcome;
            continue;
          }
          // superseded：会话失效（关闭/切换）。等待链尾（含 superseding drain
          // 执行）后直读该会话代的一次性结果传播 —— 失败如实返回，不得映射为
          // 成功。入队时已登记 waiter（记录保证存在，除非 resetTo 无 drain ——
          // 回落到下方基线判定），已登记 waiter 共享同一 promise/结果
          await this.chainTail;
          const drained = this.drainOutcomeByEpoch.get(session);
          if (drained) {
            return await drained;
          }
          // 无 drain 记录（绑定内容从未进入排空，如新项目打开后从未编辑、
          // reconcile 未完成即重置）：以实际保存的 target 判定（严重 6）——
          // 任务实际落盘的内容已推进基线则成功；保存失败如实返回；任务未保存
          // 任何内容时回落到 flush 捕获的快照。恢复快照存在与否只影响提示文案
          // （阻断 4 后遗留的恢复项可能与本轮目标内容不同，不影响放行判定）
          if (result.outcome && !result.outcome.ok) return result.outcome;
          const target = result.saved ?? project;
          const baseline = this.committedByUri.get(uri);
          const fp = contentFingerprint(target);
          const persisted =
            fp !== null &&
            baseline !== undefined &&
            baseline !== null &&
            baseline.revision >= target.revision &&
            baseline.fingerprint === fp;
          if (!persisted) {
            if (this.recovery.has(uri)) {
              return {
                ok: false,
                code: 'storage-error',
                message: '项目未保存内容未能落盘（已保留为恢复快照），请重试',
              };
            }
            return {
              ok: false,
              code: 'storage-error',
              message: '项目未保存内容未能落盘且无恢复快照，请重试',
            };
          }
          return { ok: true };
        } finally {
          this.releaseDrain(session);
        }
      }
      // 无脏快照时仍等待在途保存（含首存）完成，复查后再放行：
      // 等待期间可能落败（下轮重试）或产生新编辑（下轮追平）
      // （第二十三轮阻断 1）：无脏入口同样绑定 {uri, session} —— 等待期间
      // 同栈编辑+关闭会把 superseding drain 追加到 flush 等待的旧 tail 之后，
      // 等待结束后会话已失效，必须继续等待新链尾并传播该会话代的 drain 结果，
      // 不得以「编辑器已空/净」假报成功（内容仅存恢复快照仍放行关闭）
      const boundSession = this.session;
      const boundUri = this.currentUri;
      // 第二十八轮阻断 3：与脏分支同一时机注册 waiter（第一个 await 前）——
      // 等待期间同栈编辑+关闭入队的 superseding drain 在本代记录被淘汰前已
      // 被本计数保护（eviction 只淘汰 waiter=0 的记录）
      this.drainWaiters.set(boundSession, (this.drainWaiters.get(boundSession) ?? 0) + 1);
      try {
        await this.chainTail;
        if (boundUri !== null && !this.isFresh(boundUri, boundSession)) {
          // 等待期间会话失效（关闭/切换/重置）：继续等待新链尾（含 superseding
          // drain 执行），直读该会话代的共享 drain 结果传播 —— 失败如实返回
          await this.chainTail;
          const drained = this.drainOutcomeByEpoch.get(boundSession);
          if (drained) {
            return await drained;
          }
          // 无 drain 记录（等待期间仅关闭/重置、未产生未保存内容）：flush 进入
          // 该分支时内容已净（已提交基线覆盖），放行
          return { ok: true };
        }
        const latest = this.pending ?? this.editor.getProject();
        if (!latest || latest.uri !== boundUri || !this.isUnsaved(latest)) {
          return { ok: true };
        }
      } finally {
        this.releaseDrain(boundSession);
      }
    }
    return {
      ok: false,
      code: 'storage-error',
      message: `自动保存未能稳定（连续 ${MAX_FLUSH_DRAIN_ROUNDS} 次排空后仍有未保存变更），请稍后重试`,
    };
  }

  /** 恢复快照（切换/关闭时保存失败的旧项目内容；null = 无）。多 fork 时返回
   *  最新代（与 retryRecovery 同一决策）。 */
  getRecovery(uri: string): Project | null {
    return this.latestRecoveryRecord(uri)?.snapshot ?? null;
  }

  /**
   * 显式重试保存恢复快照（另存副本之外的第二条出路）：以该 uri 当前已提交基线做 CAS
   * （尚无记录时按创建语义，首存失败同样可重试）。
   * 写入前完成「当前编辑器 ↔ 恢复快照 ↔ 已提交基线」三方内容指纹决策（第六轮 #4：
   * 不做 revision 大小推断 —— revision 顺序不等于内容祖先，同 uri 替换等场景会把
   * 分叉误判为可自动恢复；也不先写快照再决策 —— 决策失败时磁盘不得被提前推进）：
   * - 编辑器 == 恢复快照，或编辑器 == 已提交基线：恢复快照是唯一新内容 → 按原基线
   *   保存快照并重开编辑器对齐（幂等）；
   * - 恢复快照 == 已提交基线：快照未带来新内容 → 按原基线把编辑器内容向前保存，
   *   await 并传播最终结果（绝不 fire-and-forget 假成功；revision 反转时保存如实
   *   失败、恢复快照保留）；
   * - 三方各不相同（或当前内容不可编码无法比较）：真分叉 —— 不写入磁盘，快照保留
   *   在恢复区可重试，锁存冲突供显式解决（另存副本 / 加载较新版本）。
   * 写入成功后的最终切换是会话原子操作（第七轮 #1）：保存前捕获操作代
   * （autosaver 会话 + 编辑器会话令牌 + 编辑器项目引用/指纹），await 落盘成功后
   * 重新读取复验 —— 延迟保存期间用户继续编辑或切换项目时，磁盘写入已完成（基线
   * 推进，后续保存不因 CAS 错乱），但恢复快照保留、锁存冲突，绝不 switchOpen
   * 覆盖新编辑、绝不假报 clean，调用方收到冲突结果。
   * 任一保存失败（含 revision 反转）都如实返回，快照与锁存按结果维护。
   */
  retryRecovery(uri: string): Promise<SaveOutcome> {
    // 第二十八轮严重 6：绑定具体 fork（generation）—— 执行前与每次保存 await
    // 后复验该代记录仍在，绝不重试已失效（被清除/被更新代覆盖）的快照
    const record = this.latestRecoveryRecord(uri);
    if (!record) {
      return Promise.resolve({ ok: false, code: 'storage-error', message: '没有可重试的恢复快照' });
    }
    const snapshot = record.snapshot;
    const generation = record.generation;
    return this.enqueue(async () => {
      if (this.disposed) return { ok: false, code: 'storage-error', message: '自动保存已停用' };
      const session = this.session;
      const editorToken = this.editor.getSessionToken();
      // 状态变迁代数（第八轮 #6）：复验以「期间无任何编辑」的严格判据为准 ——
      // 编辑→撤销产生内容相等的新引用，指纹比较会漏判，mutationVersion 每次
      // 状态写都递增，不会漏
      const mutationVersion = this.editor.getMutationVersion();
      const baseline = this.committedByUri.get(uri);
      const expected = baseline?.revision ?? null;
      const baseFp = baseline?.fingerprint ?? undefined;
      const snapFp = contentFingerprint(snapshot);
      const current = uri === this.currentUri ? this.editor.getProject() : null;
      const curFp = current ? contentFingerprint(current) : undefined;
      const fpEqual = (a: string | null | undefined, b: string | null | undefined): boolean =>
        a !== null && a !== undefined && b !== null && b !== undefined && a === b;

      /**
       * await 后复验：决策时捕获的操作代（会话/编辑器令牌/状态变迁代数）与编辑器
       * 内容必须未变。切换/关闭（isFresh 或编辑器令牌变化）与继续编辑（变迁代数
       * 或项目引用变化，不可编码内容经 fpEqual 保守判变）都会被识别 —— 任何变化
       * 都不允许 switchOpen/报 clean，绝不静默覆盖新编辑。
       * 非当前 uri 的重试不触碰编辑器（无 switchOpen/clean 广播），
       * 落盘成功即完成，无需内容复验。
       */
      const verifyNoChange = (wasCurrent: Project | null): boolean => {
        if (this.disposed) return false;
        if (wasCurrent === null) return true;
        if (!this.isFresh(uri, session)) return false;
        if (this.editor.getSessionToken() !== editorToken) return false;
        if (this.editor.getMutationVersion() !== mutationVersion) return false;
        const latest = this.editor.getProject();
        if (!latest || latest.uri !== uri) return false;
        if (latest === wasCurrent) return true;
        return fpEqual(contentFingerprint(latest), curFp);
      };

      /** 复验失败：磁盘已推进，但快照保留 + 锁存冲突，编辑器与状态广播不动 */
      const latchStale = (): SaveOutcome => {
        const message =
          '重试保存期间项目内容已变化，恢复快照保留；请「另存副本」保留当前编辑，或重新选择「加载较新版本」';
        this.latched = { uri, code: 'revision-conflict', message };
        if (uri === this.currentUri) this.emit({ status: 'error', code: 'revision-conflict', message });
        return { ok: false, code: 'revision-conflict', message };
      };

      /** 推进已提交基线（磁盘事实已变，无论会话是否仍新鲜）。第三十轮阻断 4：
       *  不再代劳清除锁存 —— 被取消的陈旧成功（保存 await 期间该代已被清除/更新）
       *  不得清掉较新的锁存；锁存清理由各分支在复验通过后的真正成功路径显式执行 */
      const advanceBaseline = (saved: Project, fp: string | null): void => {
        this.committedByUri.set(uri, { revision: saved.revision, fingerprint: fp });
      };

      if (!current || fpEqual(curFp, snapFp) || fpEqual(curFp, baseFp)) {
        // 编辑器 == 快照、编辑器停留在旧基线（快照是唯一新内容）、或非当前项目：
        // 按原基线保存快照
        // 第二十九轮阻断 4：执行前复验该代 fork 仍在 —— 排队期间被清除/更新的
        // 恢复快照不得再落盘（陈旧内容不得以旧 CAS 写回磁盘制造假冲突）
        if (!this.hasRecoveryGeneration(uri, generation)) {
          return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
        }
        const result = await this.storeSave(snapshot, expected);
        if (result.ok) {
          // 磁盘事实先行（第二十九轮阻断 4）：落盘成功即推进基线 —— 无论后续
          // latch/UI 判定如何，后续保存的 CAS 都不得按旧基线执行
          advanceBaseline(snapshot, snapFp);
          // 保存 await 期间该代记录已被清除或更新：本次重试取消（不清除新记录、
          // 不 latch/不 switchOpen —— 内容已真实落盘，恢复区维持现状，新 fork
          // 可继续重试）
          if (!this.hasRecoveryGeneration(uri, generation)) {
            return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
          }
          if (!verifyNoChange(current)) return latchStale();
          // 落盘的就是该恢复快照本身 → 只清除本代 fork（第二十八轮阻断 2：
          // 同 uri 其他 fork 保留）
          this.deleteRecoveryGeneration(uri, generation);
          if (this.recovery.has(uri)) {
            // 同 uri 其他 fork 仍在恢复区：锁存 recovery-available，不
            // switchOpen —— switchOpen 的 resetTo 会清空整个 uri 的恢复项，
            // 其他 fork 内容仍可恢复
            const message =
              '该项目存在未保存的恢复快照（上次保存失败）。可「另存副本」保留未保存内容，或「重试保存」';
            this.latched = { uri, code: 'recovery-available', message };
            if (uri === this.currentUri) this.emit({ status: 'error', code: 'recovery-available', message });
          } else if (current) {
            // 复验通过：原子切换到恢复快照（autosaver 重置 + 编辑器提交不广播，
            // 完成后由 changed() 链广播一次），与已落盘内容对齐
            this.switchOpen(snapshot);
          } else {
            // 第三十轮阻断 4 + 第三十一轮阻断 2：非当前 uri 的 valid 成功且无
            // 剩余 fork → 解除该 uri 锁存（advanceBaseline 不再代劳清除；
            // 按 uri 分键，绝不动其他 uri 的锁存）
            this.latchedByUri.delete(uri);
          }
        } else if (result.code === 'revision-conflict') {
          // 第三十轮阻断 4：失败同样复验该代 fork —— 保存 await 期间该代已被
          // 清除/更新时本次重试已取消，陈旧失败不得锁存冲突或广播给当前项目
          if (!this.hasRecoveryGeneration(uri, generation)) {
            return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
          }
          this.latch({ uri, code: 'revision-conflict', message: result.message });
        }
        return result;
      }
      if (fpEqual(snapFp, baseFp)) {
        // 快照未带来新内容：按原基线把编辑器内容向前保存（await 并传播最终结果；
        // revision 反转时保存失败如实返回，快照保留不删除 —— 不假成功）
        // 第二十九轮阻断 4：执行前复验该代 fork 仍在 —— 排队期间被清除/更新的
        // 恢复快照不得再落盘（陈旧内容不得以旧 CAS 写回磁盘制造假冲突）
        if (!this.hasRecoveryGeneration(uri, generation)) {
          return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
        }
        const result = await this.storeSave(current!, expected);
        if (result.ok) {
          // 磁盘事实先行（第二十九轮阻断 4）：推进基线后再判定 latch/UI
          advanceBaseline(current!, contentFingerprint(current!));
          // 保存 await 期间该代记录已被清除/更新 → 取消（不清除新记录、不 latch
          // —— 内容已真实落盘，恢复区维持现状）
          if (!this.hasRecoveryGeneration(uri, generation)) {
            return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
          }
          if (!verifyNoChange(current!)) return latchStale();
          // 快照内容 == 已提交基线内容（快照未带来新内容，已落盘）→ 只清除本代
          this.deleteRecoveryGeneration(uri, generation);
          if (this.recovery.has(uri)) {
            // 同 uri 其他 fork 仍在恢复区：锁存 recovery-available，不报 clean
            const message =
              '该项目存在未保存的恢复快照（上次保存失败）。可「另存副本」保留未保存内容，或「重试保存」';
            this.latched = { uri, code: 'recovery-available', message };
            if (uri === this.currentUri) this.emit({ status: 'error', code: 'recovery-available', message });
          } else if (uri === this.currentUri) {
            // 第三十轮阻断 4 + 第三十一轮阻断 2：valid 成功且无剩余 fork → 显式
            // 解除本 uri 锁存（advanceBaseline 不再代劳 —— 陈旧成功不得清掉
            // 较新的锁存；按 uri 分键删除）
            this.latchedByUri.delete(uri);
            this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
          }
        } else if (result.code === 'revision-conflict') {
          // 第三十轮阻断 4：失败同样复验该代 fork —— 陈旧失败不得锁存冲突
          if (!this.hasRecoveryGeneration(uri, generation)) {
            return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
          }
          this.latch({ uri, code: 'revision-conflict', message: result.message });
        }
        return result;
      }
      // 三方各不相同（或当前内容不可编码）：真分叉 —— 不写入磁盘，恢复快照保留
      // 在恢复区（可重试 / 另存副本），绝不静默覆盖当前编辑。
      // 第三十轮阻断 4：锁存前复验该代 fork 仍在 —— 排队期间被清除/更新的快照
      // 不产生陈旧分叉锁存
      if (!this.hasRecoveryGeneration(uri, generation)) {
        return { ok: false, code: 'revision-conflict', message: '恢复快照已被清除或更新，本次重试已取消' };
      }
      this.latch({
        uri,
        code: 'revision-conflict',
        message:
          '当前编辑与恢复快照、已保存基线三方内容不一致（分叉）。请「另存副本」保留当前编辑，或「加载较新版本」采用已保存内容',
      });
      return {
        ok: false,
        code: 'revision-conflict',
        message: '当前内容与恢复快照三方分叉，未覆盖当前编辑。请先「另存副本」保留当前内容',
      };
    });
  }

  /** 最新代恢复 fork（第二十八轮阻断 2：同一 uri 多 fork 时以最新代为准）。 */
  private latestRecoveryRecord(uri: string): RecoveryRecord | null {
    const forks = this.recovery.get(uri);
    if (!forks || forks.size === 0) return null;
    let latest: RecoveryRecord | null = null;
    for (const record of forks.values()) {
      if (!latest || record.generation > latest.generation) latest = record;
    }
    return latest;
  }

  private hasRecoveryGeneration(uri: string, generation: number): boolean {
    return this.recovery.get(uri)?.has(generation) ?? false;
  }

  /** 删除指定代恢复 fork（内部原语）；该 uri 无剩余 fork 时删除外层键。 */
  private deleteRecoveryGeneration(uri: string, generation: number): void {
    const forks = this.recovery.get(uri);
    if (!forks) return;
    forks.delete(generation);
    if (forks.size === 0) this.recovery.delete(uri);
  }

  /** 恢复源记录（「另存副本」消费决策，第二十九轮阻断 3）：最新代 fork 的快照
   *  与 {generation, fingerprint} 绑定 —— 消费方只清除这一代，同 uri 其他历史
   *  fork（更早保存失败的内容）保留在恢复区、仍可恢复。 */
  getRecoverySource(
    uri: string,
  ): { snapshot: Project; generation: number; fingerprint: string | null } | null {
    const record = this.latestRecoveryRecord(uri);
    if (!record) return null;
    return { snapshot: record.snapshot, generation: record.generation, fingerprint: record.fingerprint };
  }

  /**
   * 清除指定代恢复 fork（「另存副本」消费的那一代，第二十九轮阻断 3）：
   * 同 uri 其他历史 fork 保留并继续锁存 recovery-available —— 保全「当代」
   * 内容绝不沉没更早保存失败的旧内容（旧内容仅存于恢复区，仍可恢复）。
   * fingerprint 绑定：该代记录已变化（被更新代替换）时不误删。
   * 无剩余 fork 时与 clearRecovery 一致：解除锁存并按现状重报状态。
   */
  clearRecoveryGeneration(uri: string, generation: number, fingerprint: string | null): void {
    const record = this.recovery.get(uri)?.get(generation);
    if (!record) return;
    if (fingerprint !== null && record.fingerprint !== fingerprint) return;
    this.deleteRecoveryGeneration(uri, generation);
    if (this.recovery.has(uri)) {
      // 其他 fork 仍在恢复区：保持锁存 recovery-available（内容仍可恢复），
      // 编辑动作不得自动解除解决入口
      const message =
        '该项目存在未保存的恢复快照（上次保存失败）。可「另存副本」保留未保存内容，或「重试保存」';
      this.latched = { uri, code: 'recovery-available', message };
      if (uri === this.currentUri) this.emit({ status: 'error', code: 'recovery-available', message });
      return;
    }
    // 第三十一轮阻断 2：按 uri 分键解除 recovery-available 锁存（uri 可能非当前）
    if (this.latchedByUri.get(uri)?.code === 'recovery-available') this.latchedByUri.delete(uri);
    if (uri === this.currentUri) {
      const current = this.editor.getProject();
      if (current && this.isUnsaved(current)) this.emit({ status: 'dirty' });
      else this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
    }
  }

  /** 入录恢复 fork（第二十八轮阻断 2）：同指纹去重（同内容多次保存失败只保留
   *  一个 fork，防无界增长），每次入录分配新代数 */
  private recordRecovery(uri: string, snapshot: Project, fp: string | null): void {
    let forks = this.recovery.get(uri);
    if (!forks) {
      forks = new Map();
      this.recovery.set(uri, forks);
    }
    if (fp !== null) {
      for (const [generation, record] of forks) {
        if (record.fingerprint === fp) forks.delete(generation);
      }
    }
    const generation = ++this.recoveryGeneration;
    forks.set(generation, { snapshot, fingerprint: fp, generation });
  }

  /**
   * 保存成功后的恢复项清除（第二十三轮阻断 4 + 第二十八轮阻断 2）：只清除
   * 「该恢复项覆盖的内容」—— 落盘内容指纹与恢复快照一致（落盘的就是该恢复
   * 内容），全部匹配 fork 一并清除；同 uri 更新代内容落盘不得清除前代恢复快照
   * （前代内容仅存于恢复区，仍可恢复）；指纹不可比（null，内容不可编码）时
   * 保守不清除 —— 不可编码内容不可能被 store 接受，保留即正确。
   */
  private clearRecoveryWhenCovered(uri: string, savedFp: string | null): void {
    if (savedFp === null) return;
    const forks = this.recovery.get(uri);
    if (!forks) return;
    for (const [generation, record] of forks) {
      if (record.fingerprint === savedFp) forks.delete(generation);
    }
    if (forks.size === 0) this.recovery.delete(uri);
  }

  /**
   * 清除恢复快照（用户已「另存副本」等显式决定）：删除快照、解除锁存并按现状重报状态。
   */
  clearRecovery(uri: string): void {
    if (!this.recovery.has(uri)) return;
    this.recovery.delete(uri);
    // 第三十一轮阻断 2：按 uri 分键解除 recovery-available 锁存（uri 可能非当前）
    if (this.latchedByUri.get(uri)?.code === 'recovery-available') this.latchedByUri.delete(uri);
    if (uri === this.currentUri) {
      const current = this.editor.getProject();
      if (current && this.isUnsaved(current)) this.emit({ status: 'dirty' });
      else this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
    }
  }

  /**
   * 卸载前检查（第三十四轮阻断 3 拆分）：flush + recovery 检查 —— **无任何
   * teardown**（不置 disposed、不移除监听、不清 stateListeners）。失败时
   * autosaver 保持完整活跃（编辑仍进 autosave、可落盘），调用方（ProjectPersistence
   * 的 dispose preflight）据此返回可恢复失败；成功也不改变任何状态 —— 终态化
   * 只发生在 dispose()/forceTeardown()。
   * 修复前 preflight 直接调 dispose()：flush 成功即置 disposed 并移除监听，
   * 后续（late store close 等）失败返回 {ok:false} 时宿主保持 UI 但
   * changed() 已 no-op —— 失败与重试间的新编辑不落盘（死壳）。
   */
  async preflightDispose(): Promise<SaveOutcome> {
    // 冲刷（flush 需在 disposed 置位前读取编辑器项目）
    const outcome = await this.flush();
    if (!outcome.ok) return outcome;
    // 第二十九轮阻断 5：冲刷成功后仍有恢复 fork（任一 uri 的保存失败内容仅存
    // 于恢复区）→ 拒绝 dispose —— 调用方保留运行时供用户「另存副本」/「重试
    // 保存」解决，绝不因 teardown 沉没未落盘内容；冲刷已成功（当前内容已保全），
    // 仅剩余 fork 未解决，锁存 recovery-available 呈现入口
    if (this.recovery.size > 0) {
      const message =
        '存在未保存的恢复快照（上次保存失败），运行时已保留；请先「另存副本」或「重试保存」后再释放';
      const uri = this.latched?.uri ?? [...this.recovery.keys()][0]!;
      this.latched = { uri, code: 'recovery-available', message };
      if (uri === this.currentUri) this.emit({ status: 'error', code: 'recovery-available', message });
      return { ok: false, code: 'recovery-available', message };
    }
    return { ok: true };
  }

  /**
   * 强制终态清理（第三十四轮阻断 3 + 第三十六轮严重 3）：仅由 dispose() 在
   * flush 通过后调用。逐步骤 best-effort —— 每步独立 try/catch，任一
   * removeEventListener/stateListeners 清理抛错都被归档并继续后续步骤，绝不
   * 因抛错留下 disposed=true 但监听残留的假终态；返回失败明细由 dispose()
   * 并入终态 {ok:true,message}（开始终态化后的异常一律归档为终态，绝不
   * 向上传播被解释为可恢复失败）。
   */
  forceTeardown(): string[] {
    const failures: string[] = [];
    const capture = (step: string, error: unknown): void => {
      failures.push(`${step}：${error instanceof Error ? error.message : String(error)}`);
    };
    try {
      this.cancelTimer();
    } catch (error) {
      capture('清理自动保存计时器', error);
    }
    if (this.disposed) return failures;
    this.disposed = true;
    if (typeof window !== 'undefined') {
      try {
        window.removeEventListener('pagehide', this.handlePageHide);
      } catch (error) {
        capture('移除 pagehide 监听', error);
      }
    }
    if (typeof document !== 'undefined') {
      try {
        document.removeEventListener('visibilitychange', this.handleVisibility);
      } catch (error) {
        capture('移除 visibilitychange 监听', error);
      }
    }
    try {
      this.stateListeners.clear();
    } catch (error) {
      capture('清理状态监听', error);
    }
    return failures;
  }

  async dispose(): Promise<SaveOutcome> {
    if (this.disposed) return { ok: true };
    this.cancelTimer();
    // 第二十八轮阻断 4：冲刷失败如实返回 —— 失败后不得继续置 disposed/移除
    // 监听/清 stateListeners，调用方（ProjectPersistence/StudioRuntime）据此
    // 保留编辑器与存储供重试，绝不「假装已关闭」丢弃未落盘内容
    // 第三十五轮严重 4：preflightDispose/flush 的意外异常（storage 层 reject）
    // 归一为可恢复失败 —— 修复前 reject 向上传播，ProjectPersistence 的 catch
    // 只收集 message 未确保 autosaver 终态（disposed 恒 false、pagehide 等窗口
    // 监听残留），宿主却已置 disposed=true 假完成
    // 第三十六轮阻断 1 + 第三十七轮阻断 1：flush 判 clean 与 seal 原子化 ——
    // preflight 通过后先让出一个完整 task turn（taskTurn：排空整条微任务队列，
    // 含递归追加的任意深度 queueMicrotask；修复前 await null 只让出一个微任务
    // 位置，四层嵌套微任务编辑仍可在封存后执行而丢失），再于同一同步段复查
    // 变更代未变化才封存，否则继续冲刷追平。修复前 flush 先判 clean、编辑随后
    // 进 pending 启 timer、forceTeardown 取消 timer 置 disposed 返回 {ok:true}
    // —— 内容丢失
    for (;;) {
      const epochAtFlushStart = this.changeEpoch;
      let outcome: SaveOutcome;
      try {
        outcome = await this.preflightDispose();
      } catch (error) {
        return {
          ok: false,
          code: 'storage-error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!outcome.ok) return outcome;
      // 任务边界排水（第三十七轮阻断 1）：复查前让出一个完整 task turn ——
      // 排空整条微任务队列（含递归追加的任意深度 queueMicrotask），而非像
      // 修复前的 await null 只让出一个 FIFO 微任务位置（更深层微任务编辑在
      // 复查 + forceTeardown 之后才执行，内容静默丢失）。复查在完全同步的
      // 同一段完成，编辑不可能插在复查与封存之间
      await taskTurn();
      // 密封裁决只看变更代：未保存内容只能经 changed() 进入（pending 置位
      // 必伴随 epoch 递增），flush 返回 ok 已保证无未保存内容 —— pending 仍
      // 非空只可能是仅内存模式（store 为 null 时 flush 直接 ok 不清 pending）
      // 或已净的陈旧通知，二者都不携带可丢失内容，若把 pending 纳入裁决会在
      // 这些场景死循环
      if (this.changeEpoch === epochAtFlushStart) break;
    }
    // 第三十六轮严重 3：开始终态化 —— 此后任何异常都归档为终态 {ok:true,
    // message}，绝不解释为可恢复失败（修复前 forceTeardown 内 removeEventListener
    // 抛错越过 autosaver 使 ProjectPersistence 误判可恢复 {ok:false} 重开准入：
    // UI 保留但 autosave no-op、重试因 disposed 假成功且监听清理不补做 ——
    // 两层死壳）
    let failures: string[] = [];
    try {
      failures = this.forceTeardown();
    } catch (error) {
      failures = [error instanceof Error ? error.message : String(error)];
    }
    return failures.length === 0
      ? { ok: true }
      : { ok: true, message: `终态清理部分失败：${failures.join('；')}` };
  }

  private readonly handlePageHide = () => {
    void this.flush();
  };

  private readonly handleVisibility = () => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  private scheduleSave(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runSave();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private runSave(): void {
    // 第十七轮严重 3：占位带会话所有权 —— 同会话已有排队占位时不重复排队；
    // 旧会话占位不阻断新会话（覆盖重入队，新会话编辑绝不因旧占位被吞）
    if (this.saveQueued?.session === this.session) return;
    const project = this.pending ?? this.editor.getProject();
    if (!project || project.uri !== this.currentUri) return;
    // 第十五轮严重 3：目标会话代在入队前捕获 —— 队列被慢 reconcile/其他任务
    // 占用时（A→B→A0 后旧 A1 任务才执行），任务体内读取 this.session 已是新
    // 会话代，A1 会被 isFresh 误判为当前代而写回已丢弃快照；以入队时的会话代
    // 复验，旧代任务直接作废（未落盘内容由切换时的排空/恢复快照承载，已落盘
    // 内容不受影响）
    const capturedSession = this.session;
    const ticket = {};
    this.saveQueued = { session: capturedSession, ticket };
    void this.enqueue(async () => {
      // 仅清理自己持有的占位：慢任务链上旧会话任务执行时，占位可能已被新会话
      // 覆盖（新任务已排队）—— 无条件清位会吞掉新会话占位，导致重复排队
      if (this.saveQueued?.ticket === ticket) this.saveQueued = null;
      if (this.disposed) return;
      // 复验：切换/关闭（会话代递增）后旧代任务作废，绝不写回已丢弃快照
      if (!this.isFresh(project.uri, capturedSession)) return;
      this.saveInFlight = true;
      let outcome: SaveOutcome | null = null;
      const targetUri = project.uri;
      try {
        // 执行时以同会话同 uri 的最新内容为准（第十五轮 + 第十七轮严重 3）：
        // 慢链期间 reconcile 等任务可能已保存并清空 pending —— 仍用触发时
        // 快照会以旧 revision 覆写较新记录（假冲突）；会话复验已保证编辑器
        // 当前项目即同 uri 项目，可直接取用
        const current = this.editor.getProject();
        const target =
          this.pending && this.pending.uri === project.uri
            ? this.pending
            : current && current.uri === project.uri
              ? current
              : project;
        outcome = await this.saveSnapshot(target, true, capturedSession);
      } finally {
        this.saveInFlight = false;
      }
      // error 广播推迟到 saveInFlight 清零之后（第十三轮严重 #4）：错误监听器
      // 同步执行失败 switchOpen 时回滚捕获的 prevInFlight 已是 false —— 旧项目
      // 未落盘且无任何调度时回滚分支才会重新调度，自动保存不会因清零时序停止
      // 且仅在目标仍 fresh 时广播（第十四轮严重 3）：慢保存失败期间切换/关闭
      // （会话代递增）后，旧项目的失败不得覆盖新项目的真实状态 —— 旧 uri 的
      // 失败已由排空/恢复快照机制承载，关闭后也不得回弹错误状态
      if (outcome && !outcome.ok && outcome.code !== 'revision-conflict' && this.isFresh(targetUri, capturedSession)) {
        this.emit({ status: 'error', code: outcome.code, message: outcome.message });
      }
    });
  }

  /** 当前会话保存：捕获会话代与执行时基线（已提交基线，非打开时快照）。
   *  sessionOverride（runSave 专用，第十五轮严重 3）：使用入队前捕获的会话代
   *  —— 队列被慢任务占用时执行期的 this.session 可能已是新代，会把已丢弃
   *  快照误判为 fresh 写回；该代贯穿 saving 广播与 applySaveResult。
   *  deferErrorBroadcast（runSave 专用，第十三轮严重 #4）：保存失败时错误广播
   *  由调用方推迟到 saveInFlight 清零之后 —— 避免错误监听器同步执行失败
   *  switchOpen 时回滚误判在途而停止自动保存。 */
  private async saveSnapshot(project: Project, deferErrorBroadcast = false, sessionOverride?: number): Promise<SaveOutcome> {
    if (!this.store || this.disposed) {
      // 仅内存模式：无可持久化内容，视为可继续（关闭不被阻塞）
      return { ok: true };
    }
    const session = sessionOverride ?? this.session;
    const expected = this.committedByUri.get(project.uri)?.revision ?? null;
    if (this.isFresh(project.uri, session)) this.emit({ status: 'saving' });
    const result = await this.storeSave(project, expected);
    this.applySaveResult(project, session, result, deferErrorBroadcast);
    return result;
  }

  /**
   * 旧项目的排空：执行时以该 uri 的已提交基线做 CAS（在途结果已推进基线，不会冲突）。
   * 成功推进基线并清除「落盘内容覆盖的」恢复 fork；失败把快照入录为恢复 fork
   * （内容不丢，第二十八轮阻断 2：同指纹去重、按 generation 保留多代），
   * 不污染当前项目状态。结果（含失败）记录为该排空服务会话代的一次性结果
   * （drainOutcomeByEpoch，第二十一轮阻断 3）：同 uri 多代 drain 各占独立键，
   * 后代成功不覆盖前代失败；由绑定同一会话代的 flush 读取后消费（删除）。
   * 淘汰循环只淘汰最旧且无 waiter 的记录 —— 绑定该代的 flush 在入队时已登记
   * waiter（第二十八轮阻断 3），慢保存期间新 drain 入队不会淘汰其记录。
   */
  private enqueueDrain(uri: string, snapshot: Project, epoch: number): void {
    if (!this.store) return;
    const fp = contentFingerprint(snapshot);
    const promise = this.enqueue<SaveOutcome>(async () => {
      if (this.disposed) return { ok: true };
      const expected = this.committedByUri.get(uri)?.revision ?? null;
      const result = await this.storeSave(snapshot, expected);
      if (result.ok) {
        const prev = this.committedByUri.get(uri);
        this.committedByUri.set(uri, {
          revision: Math.max(prev?.revision ?? -1, snapshot.revision),
          fingerprint: fp,
        });
        // 落盘的就是该快照（指纹一致）→ 覆盖本恢复项；同 uri 前代恢复项
        // （内容不同）保留 —— 前代内容从未落盘，仍可恢复（第二十三轮阻断 4）
        this.clearRecoveryWhenCovered(uri, fp);
      } else {
        // 第二十八轮阻断 2：按 fork 入录（同指纹去重，防同内容多次失败无界增长）
        this.recordRecovery(uri, snapshot, fp);
      }
      return result;
    });
    this.drainOutcomeByEpoch.set(epoch, promise);
    if (this.drainOutcomeByEpoch.size > ProjectAutosaver.DRAIN_OUTCOME_KEEP) {
      // 防御性上限：淘汰最旧且无等待者的代记录（有 waiter 的记录不得淘汰 ——
      // waiter 共享同一 promise，等待其消费后按计数清理；flush 读不到时回落到
      // 恢复快照/基线判定，不会误报成功）
      for (const epochKey of [...this.drainOutcomeByEpoch.keys()].sort((a, b) => a - b)) {
        if ((this.drainWaiters.get(epochKey) ?? 0) === 0) {
          this.drainOutcomeByEpoch.delete(epochKey);
          break;
        }
      }
    }
  }

  /** 打开时与存储对账：决定真实状态（首存 / 冲突 / 恢复快照 / 一致），不预设「已保存」。 */
  private async reconcile(project: Project): Promise<void> {
    const session = this.session;
    if (this.disposed || !this.isFresh(project.uri, session)) return;
    if (!this.store) {
      this.emit({ status: 'memory' });
      return;
    }
    // 第十七轮严重 4：load 已收口为类型化结果（锁/存储故障不再 reject）——
    // 读取失败与存储不可用同态处理：降级为仅内存模式（保持编辑器不中断）
    const loaded = await this.store.load(project.uri);
    if (!loaded.ok) {
      if (this.isFresh(project.uri, session)) this.emit({ status: 'memory' });
      return;
    }
    const stored = loaded.project;
    // await 后复验：过期任务（期间切换/关闭）的结果一律丢弃
    if (!this.isFresh(project.uri, session)) return;
    if (!stored) {
      // 本地无记录：首存（创建语义）——先 saving，提交成功后才 clean
      const latest = this.pending ?? this.editor.getProject() ?? project;
      this.emit({ status: 'saving' });
      const result = await this.storeSave(latest, null);
      this.applySaveResult(latest, session, result);
      return;
    }
    if (stored.revision !== project.revision) {
      this.latch({
        uri: project.uri,
        code: 'revision-conflict',
        message: `本地保存内容与当前项目不一致（本地 revision ${stored.revision}，当前 ${project.revision}）。请选择「加载较新版本」或「另存副本」`,
      });
      return;
    }
    if (!sameProjectContent(stored, project)) {
      // 同 revision 不同内容（磁盘/内存分叉，如同 uri 同 revision 的包导入）：
      // 不得以「revision 一致」判净建立基线 —— 否则本地分叉会被后续保存/切换
      // 静默吞掉。锁存冲突，须显式解决（加载较新版本 / 另存副本）
      this.latch({
        uri: project.uri,
        code: 'revision-conflict',
        message: `本地保存内容与当前项目 revision 相同（${stored.revision}）但内容不一致（分叉）。请选择「加载较新版本」或「另存副本」`,
      });
      return;
    }
    // 基线一致；await 期间产生的新编辑直接落盘（expected = 已存 revision）
    const latest = this.pending ?? this.editor.getProject() ?? project;
    if (latest.revision !== project.revision) {
      this.emit({ status: 'saving' });
      const result = await this.storeSave(latest, stored.revision);
      this.applySaveResult(latest, session, result);
      return;
    }
    this.committedByUri.set(project.uri, { revision: stored.revision, fingerprint: contentFingerprint(stored) });
    if (this.recovery.has(project.uri)) {
      this.latch({
        uri: project.uri,
        code: 'recovery-available',
        message: '该项目存在未保存的恢复快照（上次保存失败）。可「另存副本」保留未保存内容，或「重试保存」',
      });
      return;
    }
    this.emit({ status: 'clean' });
  }

  private latch(error: LatchedError): void {
    // 第三十一轮阻断 2：按 uri 分键写入（setter）—— 非当前 uri 的锁存与当前
    // uri 的锁存互不覆盖（修复前单一 latched 字段被非当前 uri 的 retryRecovery
    // 冲突覆写，当前 uri 的锁存与屏障失效）
    this.latched = error;
    // 第三十轮阻断 4：广播仅限当前 uri —— 非当前 uri 的重试/对账失败只更新锁存
    // 状态（该 uri 重新打开或恢复解决时呈现），绝不向当前项目的监听器广播
    // 其他项目的失败。既有调用方（reconcile/applySaveResult）均只对当前 uri
    // 锁存，加守卫无行为变化；retryRecovery 的非当前失败由此不再污染当前广播
    if (error.uri === this.currentUri) this.emit({ status: 'error', code: error.code, message: error.message });
  }

  private async storeSave(project: Project, expected: number | null): Promise<SaveOutcome> {
    if (!this.store || this.disposed) {
      return { ok: false, code: 'storage-error', message: '本地持久化不可用' };
    }
    try {
      return await this.store.save(project, expected);
    } catch (error) {
      return { ok: false, code: 'storage-error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 保存结果回写：任何成功都推进该 uri 的已提交基线并清除其恢复快照（含旧会话：
   * 在途保存→继续编辑→切换 的落盘结果必须推进旧 uri 基线，后续排空才不会冲突）；
   * 状态广播仅当结果属于当前会话（{ uri, session } 绑定），过期结果不污染新状态。
   * 第二十八轮严重 5：该 uri 仍有恢复 fork（同 uri 其他代内容仅存恢复区）时，
   * 成功保存也不清 latch、不发 clean —— 以 recovery-available 锁存呈现解决入口，
   * 绝不假报「已保存」让旧 fork 沉没。
   * suppressErrorEmit（runSave 延迟广播专用，第十三轮严重 #4）：配额/存储错误
   * 的广播由 runSave 在 saveInFlight 清零之后发出。
   */
  private applySaveResult(project: Project, session: number, result: SaveOutcome, suppressErrorEmit = false): void {
    if (result.ok) {
      const prev = this.committedByUri.get(project.uri);
      const fp = contentFingerprint(project);
      this.committedByUri.set(project.uri, {
        revision: Math.max(prev?.revision ?? -1, project.revision),
        fingerprint: fp,
      });
      // 只清除「落盘内容就是该恢复快照」的恢复项（第二十三轮阻断 4）：同 uri
      // 更新代内容（A2）落盘不得清除前代（A1）恢复快照 —— A1 内容仅存于恢复区
      this.clearRecoveryWhenCovered(project.uri, fp);
      // 仍有恢复 fork：不清 latch、不发 clean，以 recovery-available 呈现
      if (this.recovery.has(project.uri)) {
        const message =
          '该项目存在未保存的恢复快照（上次保存失败）。可「另存副本」保留未保存内容，或「重试保存」';
        // 第三十一轮阻断 2：按 uri 分键 —— project.uri 可能非当前（旧会话在途
        // 保存成功），只更新该 uri 自己的锁存，绝不覆盖其他 uri 的锁存
        if (this.latchedByUri.get(project.uri)?.code !== 'recovery-available') {
          this.latchedByUri.set(project.uri, { uri: project.uri, code: 'recovery-available', message });
        }
        if (this.isFresh(project.uri, session)) {
          if (this.pending === project) this.pending = null;
          this.emit({ status: 'error', code: 'recovery-available', message });
        }
        return;
      }
      // 第三十一轮阻断 2：成功落盘按 uri 清除该 uri 的锁存
      this.latchedByUri.delete(project.uri);
      if (!this.isFresh(project.uri, session)) return;
      if (this.pending === project) this.pending = null;
      const current = this.editor.getProject();
      const stillDirty = current !== null && current.uri === project.uri && this.isUnsaved(current);
      this.emit(stillDirty ? { status: 'dirty' } : { status: 'clean' });
      return;
    }
    if (!this.isFresh(project.uri, session)) return;
    if (result.code === 'revision-conflict') {
      this.latch({ uri: project.uri, code: 'revision-conflict', message: result.message });
      return;
    }
    if (suppressErrorEmit) return;
    // 配额 / 存储错误：保持脏状态与快照，绝不覆盖较新内容（不锁存，后续编辑转 dirty 重试）
    this.emit({ status: 'error', code: result.code, message: result.message });
  }

  private isFresh(uri: string, session: number): boolean {
    return this.session === session && uri === this.currentUri;
  }

  /** 串行任务链：按序执行，前一任务完成后才启动下一任务。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chainTail.then(task);
    this.chainTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emit(state: AutosaveState): void {
    // 切换临界区内一律丢弃（代际失效）：最终态由 switchOpen 在分发返回后统一发布
    if (this.broadcastGuard > 0) return;
    // 嵌套发布终止旧代际（第九轮 #1）：分发中监听器同步提交编辑会嵌套触发新的
    // emit —— 每轮回调后复验代际，发生过嵌套发布立即终止本轮，陈旧状态不得在
    // 更新状态之后送达其余监听器
    this.broadcastEpoch += 1;
    const epoch = this.broadcastEpoch;
    for (const listener of [...this.stateListeners]) {
      if (epoch !== this.broadcastEpoch) return;
      listener(state);
    }
  }
}
