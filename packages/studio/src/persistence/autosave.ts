/**
 * 项目自动保存（FR-011 / NFR-003 / AC2）：
 * - 编辑器每次变更（project:changed）后防抖 AUTOSAVE_DEBOUNCE_MS 触发保存；
 * - 脏状态 = 编辑器 revision 与上次成功保存 revision 不一致（撤销回到已保存状态即转净）；
 * - 保存失败（配额不足 / 存储错误 / revision 冲突）保持脏状态与快照并广播可操作错误，
 *   绝不覆盖较新的已存内容（CAS 防倒退）；冲突不提供自动恢复 —— 必须显式解决
 *   （加载较新版本 / 另存副本），防止「本地计数追平后覆盖」的数据丢失；
 * - 项目切换 / 关闭：旧项目的未保存快照排入串行任务链（绑定旧 uri 与期望基线），
 *   不被取消、不丢失；保存结果按 { uri } 绑定回写，绝不污染新打开项目的状态；
 * - 首次落盘诚实：新项目先进入 saving，存储提交成功后才转 clean（不假报已保存）；
 * - 持久化不可用（store 为 null）：明示「仅内存」状态，不报错、不假报已保存；
 * - 页面隐藏（visibilitychange/pagehide）与显式 flush（关闭项目 / 卸载运行时）
 *   时尽力冲刷未保存变更（flush 等待在途保存完成，构成排空屏障）。
 *
 * 状态完全由编辑器事件驱动：openProject 发出的 project:changed 自动重设脏基线，
 * reset/close 发出的 { project: null } 自动冲刷并归位。
 */

import type { Project, SceneEditor } from '@lumora/core';
import type { ProjectStore, SaveFailureCode, SaveOutcome } from './project-store';

export const AUTOSAVE_DEBOUNCE_MS = 2000;

export type AutosaveState =
  | { status: 'idle' } // 无打开项目
  | { status: 'clean' } // 已同步保存
  | { status: 'dirty' } // 有未保存变更（防抖等待中）
  | { status: 'saving' } // 保存进行中
  | { status: 'error'; code: SaveFailureCode; message: string } // 保存失败（仍为脏）
  | { status: 'memory' }; // 持久化不可用：仅内存编辑，不假报已保存

export interface AutosaverOptions {
  debounceMs?: number;
}

export class ProjectAutosaver {
  private store: ProjectStore | null;
  private currentUri: string | null = null;
  private lastSavedRevision = 0;
  /** 最新未保存快照（编辑器的只读冻结快照）：编辑后立即捕获，reset/close 后仍可冲刷 */
  private pending: Project | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveQueued = false;
  /** 串行任务链尾：所有保存/排空/对账按序执行，互不交错 */
  private chainTail: Promise<void> = Promise.resolve();
  private debounceMs: number;
  private readonly stateListeners = new Set<(state: AutosaveState) => void>();
  private disposed = false;

  constructor(
    private readonly editor: SceneEditor,
    store: ProjectStore | null,
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
  setStore(store: ProjectStore | null): void {
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
      this.emit({ status: 'dirty' });
      this.scheduleSave();
    } else {
      this.pending = null;
      this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
    }
  }

  /** 打开/切换项目：先排空旧项目的未保存快照（串行链上绑定旧 uri），再切换基线并对账。 */
  private open(project: Project): void {
    const prevUri = this.currentUri;
    const previous = this.pending;
    const prevExpected = this.lastSavedRevision;
    this.cancelTimer();
    this.currentUri = project.uri;
    this.lastSavedRevision = project.revision;
    this.pending = null;
    this.saveQueued = false;
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous, prevExpected);
    }
    // 对账结果决定新项目的真实状态（首存 saving→clean / 冲突 error / 一致 clean）
    void this.enqueue(() => this.reconcile(project));
  }

  /** 关闭项目：排空未保存快照后归位。 */
  private close(): void {
    const prevUri = this.currentUri;
    const previous = this.pending;
    const prevExpected = this.lastSavedRevision;
    this.cancelTimer();
    this.currentUri = null;
    this.lastSavedRevision = 0;
    this.pending = null;
    this.saveQueued = false;
    if (prevUri !== null && previous !== null) {
      this.enqueueDrain(prevUri, previous, prevExpected);
    }
    this.emit({ status: 'idle' });
  }

  /**
   * 显式冲突解决「加载较新版本」：以传入项目（存储内容）为基线重开编辑器。
   * 丢弃未保存变更是用户的显式选择；随后 changed() 走同 uri 净态路径。
   */
  resetTo(project: Project): void {
    this.cancelTimer();
    this.currentUri = project.uri;
    this.lastSavedRevision = project.revision;
    this.pending = null;
    this.saveQueued = false;
    this.emit(this.store ? { status: 'clean' } : { status: 'memory' });
  }

  /** 立即冲刷未保存变更（关闭项目 / 卸载 / 页面隐藏 / 重试）：排空屏障，等待在途保存。 */
  async flush(): Promise<void> {
    if (this.disposed) return;
    this.cancelTimer();
    const project = this.pending ?? this.editor.getProject();
    if (project && project.uri === this.currentUri && project.revision !== this.lastSavedRevision) {
      await this.enqueue(() => this.saveCurrent());
      return;
    }
    // 无脏快照时仍等待在途保存（含首存）完成：避免「已保存」早于落盘
    await this.chainTail;
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
      await this.saveCurrent();
    });
  }

  /** 当前项目的保存：执行时捕获最新快照与期望基线（此时点链上任务已按序到达）。 */
  private async saveCurrent(): Promise<void> {
    const project = this.pending ?? this.editor.getProject();
    if (!project || project.uri !== this.currentUri) return;
    if (!this.store) {
      this.lastSavedRevision = project.revision;
      this.pending = null;
      return;
    }
    const expected = this.lastSavedRevision;
    this.emit({ status: 'saving' });
    const result = await this.storeSave(project, expected);
    this.applySaveResult(project, result);
  }

  /** 旧项目的排空：绑定捕获时的期望基线；失败明示错误（快照仍在，可另存副本恢复）。 */
  private enqueueDrain(uri: string, snapshot: Project, expected: number): void {
    void this.enqueue(async () => {
      const result = await this.storeSave(snapshot, expected);
      if (!result.ok) {
        this.emit({ status: 'error', code: result.code, message: result.message });
      }
    });
  }

  /** 打开时与存储对账：决定真实状态（首存 / 冲突 / 一致），不预设「已保存」。 */
  private async reconcile(project: Project): Promise<void> {
    if (this.disposed || project.uri !== this.currentUri) return;
    if (!this.store) {
      this.emit({ status: 'memory' });
      return;
    }
    let stored: Project | null = null;
    try {
      stored = await this.store.load(project.uri);
    } catch {
      this.emit({ status: 'memory' });
      return;
    }
    if (this.disposed || project.uri !== this.currentUri) return;
    if (!stored) {
      // 本地无记录：首存（创建语义）——先 saving，提交成功后才 clean
      const latest = this.pending ?? this.editor.getProject() ?? project;
      this.emit({ status: 'saving' });
      const result = await this.storeSave(latest, null);
      this.applySaveResult(latest, result);
      return;
    }
    if (stored.revision !== project.revision) {
      // 本地保存内容与打开快照分叉（更旧或更新都是分叉）：冲突信号，须显式解决
      this.emit({
        status: 'error',
        code: 'revision-conflict',
        message: `本地保存内容与当前项目不一致（本地 revision ${stored.revision}，当前 ${project.revision}）。请选择「加载较新版本」或「另存副本」`,
      });
      return;
    }
    this.emit({ status: 'clean' });
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

  /** 保存结果回写：仅当结果属于当前打开的项目（{ uri } 绑定），绝不污染切换后的状态。 */
  private applySaveResult(project: Project, result: SaveOutcome): void {
    if (project.uri !== this.currentUri) return;
    if (result.ok) {
      this.lastSavedRevision = Math.max(this.lastSavedRevision, project.revision);
      if (this.pending === project) this.pending = null;
      const current = this.editor.getProject();
      const stillDirty =
        current !== null && current.uri === project.uri && current.revision !== this.lastSavedRevision;
      this.emit(stillDirty ? { status: 'dirty' } : { status: 'clean' });
    } else {
      // 保存失败（冲突/配额/存储错误）：保持脏状态与快照，绝不覆盖较新内容
      this.emit({ status: 'error', code: result.code, message: result.message });
    }
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
