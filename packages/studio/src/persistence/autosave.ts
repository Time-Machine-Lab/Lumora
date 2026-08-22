/**
 * 项目自动保存（FR-011 / NFR-003 / AC2）：
 * - 编辑器每次变更（project:changed）后防抖 AUTOSAVE_DEBOUNCE_MS 触发保存；
 * - 脏状态 = 编辑器 revision 与上次成功保存 revision 不一致（撤销回到已保存状态即转净）；
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
import type { ProjectStorage, SaveFailureCode, SaveOutcome } from './project-storage';

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

export class ProjectAutosaver {
  private store: ProjectStorage | null;
  private currentUri: string | null = null;
  private lastSavedRevision = 0;
  /** 各 uri 已确认落盘的 revision（含已切换走的项目：旧项目保存成功也推进基线）。
   *  null = 尚无任何已确认记录（首存基线）：仅 load/对账成功后才建立数字基线，
   *  首存与重试按创建语义（create-only）执行，绝不把「未确认存在」当作数字基线。 */
  private readonly committedByUri = new Map<string, number | null>();
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
    const dirty = project.revision !== this.lastSavedRevision;
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
    this.lastSavedRevision = project.revision;
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
    this.lastSavedRevision = 0;
    this.pending = null;
    this.saveQueued = false;
    this.latched = null;
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous);
    }
    this.emit({ status: 'idle' });
  }

  /**
   * 显式冲突解决「加载较新版本」：以传入项目（存储内容）为基线重开编辑器。
   * 丢弃未保存变更是用户的显式选择：恢复快照一并作废；随后 changed() 走同 uri 净态路径。
   */
  resetTo(project: Project): void {
    this.cancelTimer();
    this.session += 1;
    this.currentUri = project.uri;
    this.lastSavedRevision = project.revision;
    this.pending = null;
    this.saveQueued = false;
    this.latched = null;
    this.committedByUri.set(project.uri, project.revision);
    this.recovery.delete(project.uri);
    this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
  }

  /**
   * 立即冲刷未保存变更（关闭项目 / 卸载 / 页面隐藏 / 重试）：稳定排空屏障 ——
   * 循环保存直到编辑器与已提交基线一致（排空期间的新编辑也会被追平），等待在途保存。
   * 返回类型化结果：保存失败或锁存错误（冲突/恢复待处理）都如实返回，
   * 调用方不得放行关闭/切换（内容仍在编辑器与恢复快照中）。
   */
  async flush(): Promise<SaveOutcome> {
    if (this.disposed) return { ok: true };
    // 仅内存模式：无可持久化内容，排空无意义也不阻塞关闭
    if (!this.store) return { ok: true };
    this.cancelTimer();
    for (let i = 0; i < MAX_FLUSH_DRAIN_ROUNDS; i += 1) {
      const project = this.pending ?? this.editor.getProject();
      if (project && project.uri === this.currentUri && project.revision !== this.lastSavedRevision) {
        const outcome = await this.enqueue(() => this.saveSnapshot(project));
        if (!outcome.ok) return outcome;
        continue;
      }
      if (this.latched && this.latched.uri === this.currentUri) {
        // 锁存错误下排空无法稳定：返回锁存错误，由调用方阻断关闭/切换并引导显式解决
        return { ok: false, code: this.latched.code, message: this.latched.message };
      }
      // 无脏快照时仍等待在途保存（含首存）完成，复查后再放行：
      // 等待期间可能落败（下轮重试）或产生新编辑（下轮追平）
      await this.chainTail;
      const latest = this.pending ?? this.editor.getProject();
      if (!latest || latest.uri !== this.currentUri || latest.revision === this.lastSavedRevision) {
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
   * 成功清除恢复快照与锁存，并把编辑器对齐到已落盘内容：恢复快照不新于编辑器时
   * 重开恢复快照（防止后续对账把「编辑器落后」误判为冲突再次锁存），更新时把
   * 编辑器内容向前保存（重试期间的编辑不丢失）。失败返回错误，由调用方明示。
   */
  retryRecovery(uri: string): Promise<SaveOutcome> {
    const snapshot = this.recovery.get(uri);
    if (!snapshot) {
      return Promise.resolve({ ok: false, code: 'storage-error', message: '没有可重试的恢复快照' });
    }
    return this.enqueue(async () => {
      if (this.disposed) return { ok: false, code: 'storage-error', message: '自动保存已停用' };
      const expected = this.committedByUri.get(uri) ?? null;
      const result = await this.storeSave(snapshot, expected);
      if (!result.ok) {
        if (result.code === 'revision-conflict') {
          this.latch({ uri, code: 'revision-conflict', message: result.message });
        }
        return result;
      }
      const prev = this.committedByUri.get(uri);
      this.committedByUri.set(uri, Math.max(prev ?? -1, snapshot.revision));
      this.recovery.delete(uri);
      if (this.latched?.uri === uri) this.latched = null;
      if (uri === this.currentUri) {
        const current = this.editor.getProject();
        if (current && current.revision > snapshot.revision) {
          // 恢复快照落盘后编辑器内容更新（重试期间的编辑）：向前保存编辑器内容，
          // expected = 刚落盘 revision，绝不反向覆盖
          void this.enqueue(() => this.saveSnapshot(current));
        } else if (current) {
          // 编辑器不新于恢复快照：以恢复快照为准重开编辑器（重开 recovery 快照，
          // 编辑器与存储对齐，同 revision 分叉由 store 层拒绝并锁存冲突供显式解决）
          this.resetTo(snapshot);
          this.editor.openProject(snapshot);
        }
      }
      return result;
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
      if (current && current.revision !== this.lastSavedRevision) this.emit({ status: 'dirty' });
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
    const expected = this.committedByUri.get(project.uri) ?? null;
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
      const expected = this.committedByUri.get(uri) ?? null;
      const result = await this.storeSave(snapshot, expected);
      if (result.ok) {
        const prev = this.committedByUri.get(uri);
        this.committedByUri.set(uri, Math.max(prev ?? -1, snapshot.revision));
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
    // 基线一致；await 期间产生的新编辑直接落盘（expected = 已存 revision）
    const latest = this.pending ?? this.editor.getProject() ?? project;
    if (latest.revision !== project.revision) {
      this.emit({ status: 'saving' });
      const result = await this.storeSave(latest, stored.revision);
      this.applySaveResult(latest, session, result);
      return;
    }
    this.committedByUri.set(project.uri, stored.revision);
    this.lastSavedRevision = stored.revision;
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
      this.committedByUri.set(project.uri, Math.max(prev ?? -1, project.revision));
      this.recovery.delete(project.uri);
      if (this.latched?.uri === project.uri) this.latched = null;
      if (!this.isFresh(project.uri, session)) return;
      this.lastSavedRevision = Math.max(this.lastSavedRevision, project.revision);
      if (this.pending === project) this.pending = null;
      const current = this.editor.getProject();
      const stillDirty =
        current !== null && current.uri === project.uri && current.revision !== this.lastSavedRevision;
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
