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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveQueued = false;
  /** 串行任务链尾：所有保存/排空/对账按序执行，互不交错 */
  private chainTail: Promise<void> = Promise.resolve();
  private debounceMs: number;
  private readonly stateListeners = new Set<(state: AutosaveState) => void>();
  private disposed = false;
  /** 会话代：open/close/resetTo 递增；异步续体据此识别过期任务并丢弃其结果 */
  private session = 0;
  /** 锁存错误（revision 冲突 / 恢复快照待处理）：编辑不得自行转 dirty 隐藏解决入口 */
  private latched: LatchedError | null = null;
  /** 切换/关闭时保存失败被保留的旧项目快照（按 uri），重新打开时明示可恢复 */
  private readonly recovery = new Map<string, Project>();

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
    this.cancelTimer();
    this.session += 1;
    this.currentUri = project.uri;
    this.pending = null;
    this.saveQueued = false;
    this.latched = null;
    // 新项目尚无「已确认落盘」记录：基线置 null（create-only 语义），数字基线
    // 仅由对账的 load/保存成功建立 —— 首存失败不被吞，后续保存仍按创建语义重试
    this.committedByUri.set(project.uri, null);
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous);
    }
    // 对账结果决定新项目的真实状态（首存 saving→clean / 冲突 error / 恢复快照 error / 一致 clean）
    void this.enqueue(() => this.reconcile(project));
  }

  /** 关闭项目：排空未保存快照后归位。 */
  private close(): void {
    const prevUri = this.currentUri;
    const previous = this.pending;
    this.cancelTimer();
    this.session += 1;
    this.currentUri = null;
    this.pending = null;
    this.saveQueued = false;
    this.latched = null;
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous);
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
    this.saveQueued = false;
    this.latched = null;
    this.committedByUri.set(project.uri, { revision: project.revision, fingerprint: contentFingerprint(project) });
    this.recovery.delete(project.uri);
  }

  /**
   * 原子切换（第八轮 #5）：autosaver 状态重置与编辑器提交合并为不向外广播的
   * 原子操作 —— resetTo 不 emit，编辑器 openProject 完成后由 project:changed 链
   * （persistence 监听 → changed()）按新基线判定净/脏后广播一次；监听器在
   * save-state 回调中同步提交编辑时走正常 dirty 路径（此时切换已完成，不再有
   * 「后续 openProject 覆盖新编辑」的窗口）。
   * 编辑器提交失败时回滚 autosaver 状态并上抛（防御：传入项目已通过存储校验
   * 与结构化克隆，正常不会抛错）。
   */
  switchOpen(project: Project): void {
    const prevUri = this.currentUri;
    const prevPending = this.pending;
    const prevQueued = this.saveQueued;
    const prevLatched = this.latched;
    const prevSession = this.session;
    const prevBaseline = this.committedByUri.get(project.uri);
    const prevBaselineHas = prevBaseline !== undefined;
    const prevRecovery = this.recovery.get(project.uri);
    const prevRecoveryHas = this.recovery.has(project.uri);
    this.resetTo(project);
    try {
      this.editor.openProject(project);
    } catch (error) {
      this.currentUri = prevUri;
      this.pending = prevPending;
      this.saveQueued = prevQueued;
      this.latched = prevLatched;
      this.session = prevSession;
      if (prevBaselineHas) this.committedByUri.set(project.uri, prevBaseline!);
      else this.committedByUri.delete(project.uri);
      if (prevRecoveryHas) this.recovery.set(project.uri, prevRecovery!);
      else this.recovery.delete(project.uri);
      throw error;
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
        const outcome = await this.enqueue(() => this.saveSnapshot(project));
        if (!outcome.ok) return outcome;
        continue;
      }
      // 无脏快照时仍等待在途保存（含首存）完成，复查后再放行：
      // 等待期间可能落败（下轮重试）或产生新编辑（下轮追平）
      await this.chainTail;
      const latest = this.pending ?? this.editor.getProject();
      if (!latest || latest.uri !== this.currentUri || !this.isUnsaved(latest)) {
        return { ok: true };
      }
    }
    return {
      ok: false,
      code: 'storage-error',
      message: `自动保存未能稳定（连续 ${MAX_FLUSH_DRAIN_ROUNDS} 次排空后仍有未保存变更），请稍后重试`,
    };
  }

  /** 恢复快照（切换/关闭时保存失败的旧项目内容；null = 无）。 */
  getRecovery(uri: string): Project | null {
    return this.recovery.get(uri) ?? null;
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
    const snapshot = this.recovery.get(uri);
    if (!snapshot) {
      return Promise.resolve({ ok: false, code: 'storage-error', message: '没有可重试的恢复快照' });
    }
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

      /** 推进已提交基线（磁盘事实已变，无论会话是否仍新鲜），清除锁存标记 */
      const advanceBaseline = (saved: Project, fp: string | null): void => {
        this.committedByUri.set(uri, { revision: saved.revision, fingerprint: fp });
        if (this.latched?.uri === uri) this.latched = null;
      };

      if (!current || fpEqual(curFp, snapFp) || fpEqual(curFp, baseFp)) {
        // 编辑器 == 快照、编辑器停留在旧基线（快照是唯一新内容）、或非当前项目：
        // 按原基线保存快照
        const result = await this.storeSave(snapshot, expected);
        if (result.ok) {
          advanceBaseline(snapshot, snapFp);
          if (!verifyNoChange(current)) return latchStale();
          this.recovery.delete(uri);
          if (current) {
            // 复验通过：原子切换到恢复快照（autosaver 重置 + 编辑器提交不广播，
            // 完成后由 changed() 链广播一次），与已落盘内容对齐
            this.switchOpen(snapshot);
          }
        } else if (result.code === 'revision-conflict') {
          this.latch({ uri, code: 'revision-conflict', message: result.message });
        }
        return result;
      }
      if (fpEqual(snapFp, baseFp)) {
        // 快照未带来新内容：按原基线把编辑器内容向前保存（await 并传播最终结果；
        // revision 反转时保存失败如实返回，快照保留不删除 —— 不假成功）
        const result = await this.storeSave(current!, expected);
        if (result.ok) {
          advanceBaseline(current!, contentFingerprint(current!));
          if (!verifyNoChange(current!)) return latchStale();
          this.recovery.delete(uri);
          if (uri === this.currentUri) {
            this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
          }
        } else if (result.code === 'revision-conflict') {
          this.latch({ uri, code: 'revision-conflict', message: result.message });
        }
        return result;
      }
      // 三方各不相同（或当前内容不可编码）：真分叉 —— 不写入磁盘，恢复快照保留
      // 在恢复区（可重试 / 另存副本），绝不静默覆盖当前编辑
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

  /**
   * 清除恢复快照（用户已「另存副本」等显式决定）：删除快照、解除锁存并按现状重报状态。
   */
  clearRecovery(uri: string): void {
    if (!this.recovery.has(uri)) return;
    this.recovery.delete(uri);
    if (this.latched?.uri === uri && this.latched.code === 'recovery-available') this.latched = null;
    if (uri === this.currentUri) {
      const current = this.editor.getProject();
      if (current && this.isUnsaved(current)) this.emit({ status: 'dirty' });
      else this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.cancelTimer();
    // 先冲刷（flush 需在 disposed 置位前读取编辑器项目），再移除监听
    await this.flush();
    this.disposed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.handlePageHide);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    this.stateListeners.clear();
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
    if (this.saveQueued) return;
    const project = this.pending ?? this.editor.getProject();
    if (!project || project.uri !== this.currentUri) return;
    this.saveQueued = true;
    void this.enqueue(async () => {
      this.saveQueued = false;
      if (this.disposed) return;
      // 执行时若已有更新的快照（同 uri），保存最新内容
      const target = this.pending && this.pending.uri === project.uri ? this.pending : project;
      await this.saveSnapshot(target);
    });
  }

  /** 当前会话保存：捕获会话代与执行时基线（已提交基线，非打开时快照）。 */
  private async saveSnapshot(project: Project): Promise<SaveOutcome> {
    if (!this.store || this.disposed) {
      // 仅内存模式：无可持久化内容，视为可继续（关闭不被阻塞）
      return { ok: true };
    }
    const session = this.session;
    const expected = this.committedByUri.get(project.uri)?.revision ?? null;
    if (this.isFresh(project.uri, session)) this.emit({ status: 'saving' });
    const result = await this.storeSave(project, expected);
    this.applySaveResult(project, session, result);
    return result;
  }

  /**
   * 旧项目的排空：执行时以该 uri 的已提交基线做 CAS（在途结果已推进基线，不会冲突）。
   * 成功推进基线并清除该 uri 的恢复快照；失败把快照保留为恢复快照（内容不丢），
   * 不污染当前项目状态。
   */
  private enqueueDrain(uri: string, snapshot: Project): void {
    if (!this.store) return;
    void this.enqueue(async () => {
      if (this.disposed) return;
      const expected = this.committedByUri.get(uri)?.revision ?? null;
      const result = await this.storeSave(snapshot, expected);
      if (result.ok) {
        const prev = this.committedByUri.get(uri);
        this.committedByUri.set(uri, {
          revision: Math.max(prev?.revision ?? -1, snapshot.revision),
          fingerprint: contentFingerprint(snapshot),
        });
        this.recovery.delete(uri);
      } else {
        this.recovery.set(uri, snapshot);
      }
    });
  }

  /** 打开时与存储对账：决定真实状态（首存 / 冲突 / 恢复快照 / 一致），不预设「已保存」。 */
  private async reconcile(project: Project): Promise<void> {
    const session = this.session;
    if (this.disposed || !this.isFresh(project.uri, session)) return;
    if (!this.store) {
      this.emit({ status: 'memory' });
      return;
    }
    let stored: Project | null = null;
    try {
      stored = await this.store.load(project.uri);
    } catch {
      if (this.isFresh(project.uri, session)) this.emit({ status: 'memory' });
      return;
    }
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
    this.latched = error;
    this.emit({ status: 'error', code: error.code, message: error.message });
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
   */
  private applySaveResult(project: Project, session: number, result: SaveOutcome): void {
    if (result.ok) {
      const prev = this.committedByUri.get(project.uri);
      this.committedByUri.set(project.uri, {
        revision: Math.max(prev?.revision ?? -1, project.revision),
        fingerprint: contentFingerprint(project),
      });
      this.recovery.delete(project.uri);
      if (this.latched?.uri === project.uri) this.latched = null;
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
    for (const listener of [...this.stateListeners]) listener(state);
  }
}
