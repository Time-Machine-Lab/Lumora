/**
 * 项目持久化门面（FR-001 / FR-011）：StudioRuntime 与 UI 之间的统一入口。
 *
 * - 本地存储：IndexedDB ProjectStore 或 OPFS OpfsProjectStore（init 可配置后端，
 *   缺省 IndexedDB；新建/重命名/复制/删除/最近项目）；
 * - 自动保存：ProjectAutosaver 随编辑器事件防抖落盘（2 秒），失败保持脏状态；
 * - 工程包：导出（buildProjectPackage 剥离私有数据 + 配额预检）与导入
 *   （parseProjectPackage 纯函数解析，校验失败不产生任何副作用 —— 当前项目
 *   保持原样，失败回滚由「解析通过后才打开」保证）；
 * - 冲突解决：reloadOpenProject（以存储内容为基线重开，显式丢弃未保存变更）
 *   与 duplicateProject（打开中的项目以编辑器快照为准复制，磁盘记录可能落后）。
 *
 * 编辑器监听在构造期同步接入：存储打开前的冷启动变更（project:changed）
 * 不会丢失（自动保存先以「仅内存」状态受理，init 完成后重新对账）。
 */

import { TypedEventEmitter, createBlankProject, genId } from '@lumora/core';
import type { Project, SceneEditor } from '@lumora/core';
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  buildProjectPackage,
  estimatePackageBytes,
  findJsonEncodingProblem,
  migrateProjectSchema,
  parseProjectPackage,
  serializeProjectPackage,
  validateProjectSchema,
  validateProjectStructure,
} from '@lumora/core';
import type { MissingAssetWarning, PackageImportError, ProjectPackage } from '@lumora/core';
import { ProjectAutosaver } from './autosave';
import type { AutosaveState } from './autosave';
import { ProjectStore } from './project-store';
import { OpfsProjectStore } from './project-store-opfs';
import { estimateStorage, failureMessage, stableStringify } from './project-storage';
import type { DuplicateOutcome, ProjectStorage, ProjectSummary, RemoveIfOutcome, SaveOutcome, StorageBackend } from './project-storage';

export interface PersistenceEventMap extends Record<string, unknown> {
  'save-state': { state: AutosaveState };
}

export type ExportResult =
  | { ok: true; text: string; filename: string; bytes: number }
  | { ok: false; message: string };

export type ImportResult =
  | { ok: true; project: Project; warnings: MissingAssetWarning[]; migratedFrom: number }
  | { ok: false; error: PackageImportError };

export type RenameResult =
  | { ok: true }
  | { ok: false; code: 'empty-name' | 'not-found' | 'storage-error'; message: string };

/** 导出文件名安全化：去掉路径/非法字符（保留中文等 Unicode） */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[/:*?"<>|]/g, "-").trim();
  return cleaned.length > 0 ? cleaned : '未命名项目';
}


export class ProjectPersistence {
  private store: ProjectStorage | null = null;
  private readonly autosaver: ProjectAutosaver;
  private unsubscribeEditor: { dispose(): void } | null = null;
  private currentUri: string | null = null;
  private disposed = false;
  // 第三十一轮严重 3：dispose 幂等合并（single-flight）—— 并发调用共享同一
  // in-flight 执行，成功后永久复用结果；失败 settle 后清空缓存允许重试
  private disposePromise: Promise<SaveOutcome> | null = null;
  // 第三十二轮严重 4：init 幂等合并 —— 并发/重复 init 共享同一 in-flight 执行
  // （修复前并发 init 都在 store 置位前越过守卫，重复创建存储、早到者泄漏）
  private initPromise: Promise<void> | null = null;
  // 第三十三轮严重 4：待关闭的晚到 store —— 存储创建挂起期间 dispose 已开始，
  // init 重查发现已释放时不再吞掉关闭失败：store 转入此字段，dispose 的 commit
  // 段负责真实关闭（失败并入终态 message，见下）；关闭成功后置 null。
  // 第三十四轮严重 4 明确分流边界：只有 dispose 已进入不可回退 commit 阶段
  // （disposePhase === 'committing'）才转入 lateStore —— 修复前凭 disposePromise
  // 存在即转入：dispose 的 preflight 失败时直接返回，晚到 store 既不挂载也不
  // 关闭（连接悬挂、编辑静默退化内存模式）；preflighting/idle 阶段的晚到 store
  // 正常挂载（preflight 可失败可重试，运行态保持完整可落盘）
  private lateStore: ProjectStorage | null = null;
  // 第三十四轮严重 4：dispose 阶段机 —— 'idle'（未开始）→ 'preflighting'
  // （可恢复 preflight：flush/recovery 检查，失败回 'idle' 可重试）→
  // 'committing'（不可回退终态收敛，任何失败并入 message、ok 仍 true）→
  // 'disposed'（完成）。init 的晚到 store 分流据此判定
  private disposePhase: 'idle' | 'preflighting' | 'committing' | 'disposed' = 'idle';
  // 第三十五轮严重 3：新 init 准入 —— dispose() 同步关闭（返回 promise 之前生效，
  // dispose-first/init-second 的晚到 init 不再穿过屏障另起创建任务）；preflight
  // 失败时重新开放（运行态保留、可继续 init/重试）
  private initAdmissionOpen = true;
  readonly events = new TypedEventEmitter<PersistenceEventMap>();

  constructor(private readonly editor: SceneEditor) {
    // 构造期即接入自动保存（store 暂为 null → 仅内存模式）：
    // 冷启动在 IndexedDB 打开前的项目变更不会丢失，init 完成后重新对账
    this.autosaver = new ProjectAutosaver(editor, null);
    this.autosaver.onState((state) => {
      // latest-wins（第十二轮严重 #3）：save-state 是状态类事件 —— 监听器回调内
      // 同步提交编辑会嵌套触发新的 save-state，外层陈旧状态不得在更新状态之后
      // 送达其余监听器（广播代际失效仅适用于 latest-wins 状态事件，发生型事件
      // 不做代际截断）
      if (!this.disposed) this.events.emit('save-state', { state }, { latestWins: true });
    });
    this.unsubscribeEditor = editor.events.on('project:changed', ({ project, sessionToken }) => {
      if (this.disposed || !editor.isCurrentSession(sessionToken) || project !== editor.getProject()) return;
      this.autosaver.changed(project);
      // autosaver.changed() may synchronously publish save-state; a listener can
      // open another project before this callback resumes.
      if (this.disposed || !editor.isCurrentSession(sessionToken) || project !== editor.getProject()) return;
      this.currentUri = project?.uri ?? null;
    });
  }

  /** 本地持久化是否可用（存储打开失败时静默降级为仅内存编辑） */
  get available(): boolean {
    return this.store !== null;
  }

  /** 实际生效的存储后端（init 前为 null） */
  get backend(): StorageBackend | null {
    return this.store?.kind ?? null;
  }

  /** 打开项目后的当前 uri（重命名/复制等操作据此分流） */
  get openUri(): string | null {
    return this.currentUri;
  }

  /** 初始化：打开存储并接入自动保存。幂等；storage 缺省为 indexeddb。
   *  options.store 为测试注入（跳过按后端创建，直接使用给定存储实例）。
   *  第三十二轮严重 4：init 为 single-flight —— 并发调用共享同一 in-flight 执行；
   *  存储创建挂起期间 dispose() 先成功时，晚到的 store 立即关闭并丢弃，
   *  绝不挂到已销毁的 persistence（连接泄漏）。 */
  init(
    options: { debounceMs?: number; dbName?: string; storage?: StorageBackend; store?: ProjectStorage } = {},
  ): Promise<void> {
    // 第三十六轮严重 2：dispose 挂起（准入已关、尚未裁决）时晚到 init 等待
    // 裁决 —— 修复前直接 resolved no-op：runtime.init() 无条件写
    // initialized=true，dispose preflight 失败重开准入后 runtime 层已短路、
    // 后续 init 不再触碰 persistence，持久化永久仅内存（available=false）。
    // 等待语义：dispose 成功（终态）→ no-op（运行态已销毁，无初始化意义）；
    // dispose 失败（运行态保留、准入已重开、disposePromise 已清空）→ 递归
    // 继续执行真实初始化（store 真实挂载、编辑真实落盘）
    if (!this.initAdmissionOpen && !this.disposed && this.disposePromise) {
      return this.disposePromise.then(() => {
        if (this.disposed) return;
        return this.init(options);
      });
    }
    // 第三十五轮严重 3：dispose() 同步关闭准入后，晚到 init 直接 no-op ——
    // 修复前 dispose-first/init-second 仍会启动创建任务，close() 抛错被吞、
    // 公开 close 永久成功但连接泄漏
    if (this.disposed || !this.initAdmissionOpen || this.store) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async (): Promise<void> => {
      const store =
        options.store ??
        (options.storage === 'opfs'
          ? await OpfsProjectStore.create(options.dbName)
          : await ProjectStore.create(options.dbName));
      if (!store) return; // 存储不可用：静默降级（仅内存编辑），与旧语义一致
      // await 挂起期间 dispose() 已开始/完成：晚到 store 不得挂到已销毁的
      // persistence —— 第三十四轮严重 4 按阶段分流（修复前凭 disposePromise
      // 存在即转入 lateStore：preflight 失败时 store 既不挂载也不关闭）：
      // - disposed（dispose 已完成、收敛点已过）：立即关闭丢弃（best-effort，
      //   终态后清理失败无处可报，但不残留连接）；
      // - committing（dispose 已进入不可回退 commit）：转入 lateStore，由
      //   dispose 的 commit 段真实关闭（第三十三轮严重 4；关闭失败并入终态
      //   message —— commit 已开始，不再返回可恢复 {ok:false}，第三十四轮
      //   阻断 3）；
      // - idle/preflighting（preflight 可失败可重试，运行态保持完整）：正常
      //   挂载 —— preflight 失败后 store 已就位，编辑可真实落盘（修复前
      //   「init pending → dispose/preflight pending → init 返回 store →
      //   preflight 失败」导致连接悬挂、编辑静默退化内存模式）
      if (this.disposed) {
        try {
          store.close();
        } catch {
          // 终态后晚到 store 的清理失败无人接收：不残留连接即可
        }
        return;
      }
      if (this.disposePhase === 'committing') {
        this.lateStore = store;
        return;
      }
      this.store = store;
      this.autosaver.setStore(this.store);
      if (options.debounceMs !== undefined) this.autosaver.setDebounceMs(options.debounceMs);
    })();
    const inFlight = this.initPromise;
    // 第三十三轮一般 5：成功/失败双分支 settle 清理 —— 修复前 success-only
    // then 派生未处理拒绝（调用方 await 原 promise 也无济于事），且拒绝后
    // initPromise 永久复用 rejected promise：注入后端/未来实现拒绝时后续
    // init 永远拿到同一失败、无法重试
    void inFlight.then(
      () => {
        if (this.initPromise === inFlight) this.initPromise = null;
      },
      () => {
        if (this.initPromise === inFlight) this.initPromise = null;
      },
    );
    return inFlight;
  }

  /** 最近项目列表（按保存时间倒序）。存储/锁故障抛归一化错误（UI catch 后
   *  toast，第十七轮严重 4）——绝不静默返回空列表掩盖失败。 */
  async listRecent(): Promise<ProjectSummary[]> {
    if (!this.store) return [];
    const result = await this.store.list();
    if (!result.ok) throw new Error(`最近项目加载失败：${result.message}`);
    return result.items;
  }

  /**
   * 加载本地项目（打开最近项目）的统一边界（第五轮 #7）：全部加载结果一律走
   * 「迁移 → 结构校验」管道 —— 旧版本（如 v2 无 tracks）记录先逐级迁移到当前
   * 版本；当前版本记录也做结构校验（损坏记录不得原样交给编辑器）。仅当迁移
   * 实际发生（migratedFrom ≠ 当前版本）时以已存 revision 为期望基线 CAS 原子
   * 写回 —— 下次加载不再迁移；迁移/校验失败返回可操作错误，绝不把未经验证
   * 的数据交给编辑器。
   */
  async loadProject(uri: string): Promise<{ ok: true; project: Project; migratedFrom?: number } | { ok: false; message: string }> {
    if (!this.store) return { ok: false, message: '本地持久化不可用' };
    const loaded = await this.store.load(uri);
    if (!loaded.ok) return { ok: false, message: `本地项目加载失败：${loaded.message}` };
    const stored = loaded.project;
    if (!stored) return { ok: false, message: '本地项目不存在或已损坏' };
    const migrated = migrateProjectSchema(stored);
    if (!migrated.ok) {
      return { ok: false, message: `本地项目数据无法迁移到当前版本：${migrated.error.message}` };
    }
    const project = migrated.project as Project;
    const problem = validateProjectSchema(project);
    if (problem) {
      return { ok: false, message: `本地项目数据校验失败：${problem}` };
    }
    const structureProblem = validateProjectStructure(project);
    if (structureProblem) {
      return { ok: false, message: `本地项目数据校验失败：${structureProblem}` };
    }
    if (migrated.migratedFrom !== CURRENT_PROJECT_SCHEMA_VERSION) {
      // 仅迁移实际发生时写回（当前版本数据通过校验后原样返回，不做无意义写回）
      const result = await this.store.save(project, stored.revision);
      if (!result.ok) return { ok: false, message: `迁移结果写回失败：${result.message}` };
      return { ok: true, project, migratedFrom: stored.schemaVersion };
    }
    return { ok: true, project };
  }

  /** 本地是否已存在同 uri 记录（导入防碰撞：同 uri 视为副本导入）。
   *  存储/锁故障无法判定时如实抛错（调用方 importPackage 的 catch 兜底，第十七轮严重 4）。 */
  async hasLocal(uri: string): Promise<boolean> {
    if (!this.store) return false;
    const loaded = await this.store.load(uri);
    if (!loaded.ok) throw new Error(`项目存在性检查失败：${loaded.message}`);
    return loaded.project !== null;
  }

  /**
   * 立即冲刷未保存变更（关闭项目 / 卸载前调用；不改变打开状态）。
   * 返回类型化结果：失败（冲突/配额/存储）时调用方必须阻止关闭/切换 ——
   * 内容仍在编辑器与恢复快照中，放行即丢失。
   */
  flushPending(): Promise<SaveOutcome> {
    return this.autosaver.flush();
  }

  /** 恢复快照（切换/关闭时保存失败的旧项目内容；null = 无）。 */
  getRecoverySnapshot(uri: string): Project | null {
    return this.autosaver.getRecovery(uri);
  }

  /**
   * 「另存副本」源内容决策（第八轮 #2 + 第二十九轮阻断 3）：uri 为当前打开项目
   * 且有未保存编辑时，以编辑器现场为准，generation = null —— 复制当前内容
   * 不得清除任何历史恢复 fork（旧 fork 内容仅存于恢复区，仍可恢复）；否则取
   * 该 uri 的最新代恢复 fork 并绑定其 {generation, fingerprint}（消费方只清除
   * 这一代）；均无返回 null（调用方走存储复制路径）。
   */
  resolveSaveAsCopySource(
    uri: string,
  ): { source: Project; generation: number | null; fingerprint: string | null } | null {
    if (this.currentUri === uri && this.autosaver.hasUnsavedContent()) {
      return { source: this.editor.getProject()!, generation: null, fingerprint: null };
    }
    const record = this.autosaver.getRecoverySource(uri);
    if (!record) return null;
    return { source: record.snapshot, generation: record.generation, fingerprint: record.fingerprint };
  }

  /** 显式重试保存恢复快照（成功清除恢复快照与锁存；失败返回错误）。 */
  retryRecovery(uri: string): Promise<SaveOutcome> {
    return this.autosaver.retryRecovery(uri);
  }

  /** 清除恢复快照（用户已另存副本等显式决定后调用）。 */
  clearRecovery(uri: string): void {
    this.autosaver.clearRecovery(uri);
  }

  /** 清除指定代恢复 fork（「另存副本」消费的那一代，第二十九轮阻断 3）：
   *  同 uri 其他历史 fork 保留并继续锁存 recovery-available（仍可恢复）。
   *  fingerprint 绑定：该代记录已变化时不误删。 */
  clearRecoveryGeneration(uri: string, generation: number, fingerprint: string | null): void {
    this.autosaver.clearRecoveryGeneration(uri, generation, fingerprint);
  }

  /** 把恢复快照（或当前编辑器内容）另存为全新项目：以副本保留未保存内容（新 uri，revision 0）。
   *  保存成功后复用统一加载管道（load → 迁移 → 校验）验证副本可打开：存储写入成功
   *  ≠ 数据可用（故障存储可写入损坏记录），验证/清理经异常安全封装（verifyCopy，
   *  清理为 CAS —— 第十四轮严重 4）—— 验证失败或 reject 均清除记录并返回可操作
   *  错误，副本未产生，调用方不得报成功。 */
  async saveSnapshotAsNew(
    project: Project,
    name?: string,
  ): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
    // 第十五轮严重 5：入口级异常归一 —— 克隆/保存/验证的意外 reject 一律返回
    // 类型化失败，绝不向上抛异常（副本残留由 verifyCopy 的清理如实报告）
    try {
      if (!this.store) return { ok: false, message: '本地持久化不可用' };
      const copy: Project = {
        ...structuredClone(project),
        uri: `lumora://project/${genId('p')}`,
        name: name ?? `${project.name} 副本`,
        createdAt: new Date().toISOString(),
        revision: 0,
      };
      const result = await this.store.save(copy, null);
      if (!result.ok) return { ok: false, message: result.message };
      return this.verifyCopy(copy.uri, stableStringify(copy));
    } catch (error) {
      return { ok: false, message: `另存副本失败：${failureMessage(error)}` };
    }
  }

  /**
   * 冲突解决「加载较新版本」：复用统一边界 loadProject（load → 迁移 → 校验）
   * 以存储内容为基线重开当前项目（第五轮 #5）。显式丢弃未保存变更是用户确认
   * 的选择；失败返回可操作错误且不改变编辑器状态。
   * 最终切换是会话原子操作（第七轮 #2）：await 挂起期间（存储读取/迁移/写回）
   * 用户可能继续编辑或切换项目 —— 提交前重新验证 uri 未变、编辑器会话令牌未变、
   * 编辑器项目引用未变（内容可能不可编码而无法比较，引用身份是可靠判据）；
   * 任一变化都返回已取消，自动保存与编辑器（含锁存的冲突状态）均不动。
   */
  async reloadOpenProject(): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
    if (!this.currentUri) return { ok: false, message: '本地持久化不可用' };
    const uri = this.currentUri;
    const editorToken = this.editor.getSessionToken();
    const before = this.editor.getProject();
    const loaded = await this.loadProject(uri);
    if (!loaded.ok) return loaded;
    if (
      this.currentUri !== uri ||
      this.editor.getSessionToken() !== editorToken ||
      this.editor.getProject() !== before
    ) {
      // 重载挂起期间用户已编辑或切换项目：此刻切换会覆盖新内容 —— 取消，
      // 恢复快照/锁存原样保留，由用户重新决定
      return {
        ok: false,
        message: '重载期间项目已切换或内容已修改，操作已取消；未改变当前编辑',
      };
    }
    // 原子切换（第八轮 #5）：autosaver 重置 + 编辑器提交不向外广播，完成后由
    // changed() 链按新基线广播一次净态；编辑器提交失败（防御路径）回滚并报错
    try {
      this.autosaver.switchOpen(loaded.project);
    } catch (error) {
      return { ok: false, message: `无法应用本地保存内容：${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, project: loaded.project };
  }

  /** 新建项目（FR-001）：默认场景 + 摄像机 + 16:9；持久化不可用时仍可内存编辑。 */
  createProject(name: string): Project {
    return createBlankProject(`lumora://project/${genId('p')}`, name);
  }

  /** 复制项目：返回新项目供调用方打开（store 不可用时返回 not-found 语义错误）。
   *  打开中的项目以编辑器快照为准（磁盘记录可能落后于未保存变更）；未打开的走存储。
   *  返回副本内容指纹（调用方二次加载失败时的 CAS 清理依据，第十四轮严重 4/5）。 */
  async duplicateProject(uri: string, name?: string): Promise<DuplicateOutcome> {
    // 第十五轮严重 5：入口级异常归一 —— 克隆/保存/验证/存储复制的意外 reject
    // 一律返回类型化 storage-error，UI 无需兜底 catch
    try {
      if (!this.store) {
        return { ok: false, code: 'not-found', message: '本地持久化不可用' };
      }
      if (this.currentUri === uri) {
        const project = this.editor.getProject();
        if (!project) return { ok: false, code: 'not-found', message: '项目不存在' };
        const copy: Project = {
          ...structuredClone(project),
          uri: `lumora://project/${genId('p')}`,
          name: name ?? `${project.name} 副本`,
          createdAt: new Date().toISOString(),
          revision: 0,
        };
        const fingerprint = stableStringify(copy);
        const result = await this.store.save(copy, null);
        if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
        // 与 saveSnapshotAsNew 同一验证管道（第十一轮严重 #3 + 第十二轮严重 #5）：
        // 存储写入成功 ≠ 可打开，验证/清理经异常安全封装（verifyCopy）—— 失败
        // 或 reject 均清除记录（CAS），副本未产生，调用方不得报成功
        const verified = await this.verifyCopy(copy.uri, fingerprint);
        if (!verified.ok) {
          return { ok: false, code: 'storage-error', message: verified.message };
        }
        return {
          ok: true,
          summary: {
            uri: copy.uri,
            name: copy.name,
            savedAt: new Date().toISOString(),
            revision: 0,
            schemaVersion: copy.schemaVersion,
          },
          fingerprint,
        };
      }
      // await 而非 return promise：store.duplicate 的 reject 必须落在入口
      // try/catch 内归一为类型化失败（return promise 的 reject 会逃逸出 catch）
      return await this.store.duplicate(uri, name);
    } catch (error) {
      return { ok: false, code: 'storage-error', message: `复制失败：${failureMessage(error)}` };
    }
  }

  /**
   * 复制后加载副本的统一边界（第十四轮严重 5）：duplicateProject 返回后 UI 还需
   * 二次加载副本以打开 —— load 的 reject（故障存储抛错）与校验失败都归一为
   * 类型化失败，并尝试 CAS 清理副本（清理状态如实报告）；「最近项目复制」与
   * 「另存副本」的存储复制分支共用，绝不产生未处理的 reject。
   */
  async loadCopyForOpen(
    uri: string,
    expectedFingerprint: string,
  ): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
    let loaded: Awaited<ReturnType<ProjectPersistence['loadProject']>>;
    try {
      loaded = await this.loadProject(uri);
    } catch (error) {
      return {
        ok: false,
        message: `无法打开副本（${failureMessage(error)}）${await this.reportCopyCleanup(uri, expectedFingerprint)}`,
      };
    }
    if (!loaded.ok) {
      return {
        ok: false,
        message: `无法打开副本：${loaded.message}${await this.reportCopyCleanup(uri, expectedFingerprint)}`,
      };
    }
    return { ok: true, project: loaded.project };
  }

  /** 删除项目（仅存储记录；已打开的当前项目由调用方先 closeProject）。
   *  存储/锁故障抛归一化错误（UI catch 后 toast，第十七轮严重 4）——绝不静默
   *  报「未找到」掩盖失败。 */
  async deleteProject(uri: string): Promise<boolean> {
    if (!this.store) return false;
    const result = await this.store.remove(uri);
    if (!result.ok) throw new Error(`项目删除失败：${result.message}`);
    return result.removed;
  }

  /** 副本验证与清理的异常安全封装（第十二轮严重 #5 + 第十三轮严重 5 + 第十四轮
   *  严重 4）：存储写入成功 ≠ 数据可用（故障存储可写入损坏记录），统一以
   *  「load → 迁移 → 校验」管道验证副本可打开；loadProject 的 reject（故障存储
   *  抛错）归一为类型化失败 —— 绝不遗留损坏副本、绝不把未捕获异常上抛给调用方。
   *  清理为 CAS：仅当记录内容指纹与创建时一致才删除 —— 验证挂起期间另一标签页
   *  已打开并保存副本时，更新后的合法记录保留（如实报告）；清理本身失败时如实
   *  报告「记录保留、可手动删除」，不假装已清理。 */
  private async verifyCopy(
    uri: string,
    expectedFingerprint: string | null,
  ): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
    let verified: Awaited<ReturnType<ProjectPersistence['loadProject']>>;
    try {
      verified = await this.loadProject(uri);
    } catch (error) {
      return {
        ok: false,
        message: `副本保存失败（验证异常）：${failureMessage(error)}${await this.reportCopyCleanup(uri, expectedFingerprint)}`,
      };
    }
    if (!verified.ok) {
      return {
        ok: false,
        message: `副本保存失败（数据无法通过校验）：${verified.message}${await this.reportCopyCleanup(uri, expectedFingerprint)}`,
      };
    }
    return { ok: true, project: verified.project };
  }

  /** 副本清理的报告后缀（验证失败时移除损坏记录；第十四轮严重 4 CAS + 第十五轮
   *  严重 4/一般 7 四态）：已删除（removed）或记录已不存在（missing，清理后置
   *  条件已满足）返回空串；记录已变化/损坏（changed，另一会话已保存）返回
   *  「已保留」提示；存储故障返回「记录保留、可手动删除」。removeIfUnchanged 的
   *  失败与意外 reject（连接关闭/锁失败）都归一为后缀文案，绝不向 UI 抛未处理
   *  的 Promise —— 不掩盖验证失败结论，但调用方必须知道记录是否残留。 */
  private async reportCopyCleanup(uri: string, expectedFingerprint: string | null): Promise<string> {
    if (!this.store) return '；清理失败，损坏记录保留，可手动删除';
    let outcome: RemoveIfOutcome;
    try {
      outcome = await this.store.removeIfUnchanged(uri, expectedFingerprint);
    } catch (error) {
      return `；清理失败，损坏记录保留，可手动删除（${failureMessage(error)}）`;
    }
    if (outcome.ok && outcome.outcome !== 'changed') return '';
    if (outcome.ok) return '；副本记录已变化（可能已被其他会话保存），已保留该记录，可手动删除';
    return `；清理失败，损坏记录保留，可手动删除（${outcome.message}）`;
  }

  /** 重命名：打开中的项目走编辑器提交（一步历史 + revision 递增 + 自动保存落盘）。 */
  renameProject(uri: string, name: string): Promise<RenameResult> {
    const trimmed = name.trim();
    if (!trimmed) return Promise.resolve({ ok: false, code: 'empty-name', message: '项目名称不能为空' });
    if (this.currentUri === uri) {
      const result = this.editor.setProjectName(trimmed);
      return Promise.resolve(result.ok ? { ok: true } : { ok: false, code: 'storage-error', message: result.error.message });
    }
    if (!this.store) {
      return Promise.resolve({ ok: false, code: 'storage-error', message: '本地持久化不可用' });
    }
    return this.store.rename(uri, trimmed);
  }

  /**
   * 导出当前项目为 `.lumora` 工程包（同步纯构建，绝不抛异常）。
   * includePrivate 显式开启时允许包含插件私有设置（pluginData）；凭据隔离是
   * 结构化契约（第十一轮 + 第十二轮阻断 1/2 + 第十四轮阻断 1/2）：settings 按
   * 契约字段投影、scenes/objects/tracks/资产元数据逐层公开 DTO 契约投影、
   * pluginData 仅按命名空间 + 路径 schema 显式公开声明（manifest.exportableSettings
   * 原样传入 publicKeysByPlugin，宿主不做减法过滤；缺失/空/畸形声明整段排除，
   * 公开对象按路径递归投影），默认导出时 pluginData 整体不进包 —— 不再依赖
   * 键名词表猜测（NFR-008）。
   * 编码预检在最终投影视图之后（第十二轮一般 #10）：buildProjectPackage 先完成
   * 全部白名单投影与剥离（settings 契约外键 / 未声明 pluginData 命名空间 / 每层
   * DTO 契约外字段 / 访问器与反射异常都在构建期处理），再对构建产物检查 ——
   * 预检与序列化看到同一张图；位于被剥离/排除字段中的不可编码数据（私有
   * BigInt / 循环引用）不阻断导出，被保留字段中的不可编码数据仍如实拒绝。
   * 构建/序列化抛错（DataCloneError/getter 副作用）归一为类型化失败。
   * 文件名与包内同名图（第十四轮一般 6）：从构建产物的 manifest（投影视图）
   * 读取 —— 源对象 getter/Proxy 陷阱已在构建期经描述符预检隔离，文件名读取
   * 不再二次触碰源对象，绝不裸抛。
   */
  exportCurrent(
    options: {
      includePrivate?: boolean;
      publicKeysByPlugin?: Record<string, readonly (string | readonly string[])[]>;
      // 第十五轮阻断 1：宿主直读 manifest.privateSettings 原样传入，core 端对
      // 公开声明与 privateSettings/凭据形态键的重叠逐条拒绝（不依赖插件自觉）
      privateKeysByPlugin?: Record<string, readonly string[]>;
    } = {},
  ): ExportResult {
    const project = this.editor.getProject();
    if (!project) return { ok: false, message: '当前没有打开的项目' };
    let pkg: ProjectPackage;
    try {
      pkg = buildProjectPackage(project, {
        includePrivate: options.includePrivate ?? false,
        publicKeysByPlugin: options.publicKeysByPlugin,
        privateKeysByPlugin: options.privateKeysByPlugin,
      });
    } catch (error) {
      return { ok: false, message: `项目无法导出（构建失败）：${failureMessage(error)}` };
    }
    // 编码预检作用于最终整个包（manifest/project/assets 全部分支，第十三轮严重 3）：
    // 构建已完成全部投影与剥离，预检与序列化看到同一张图；assets 段（含分件
    // 数组）与 manifest 的编码问题同样如实拒绝，不被排除的数据不静默丢失
    const problem = findJsonEncodingProblem(pkg);
    if (problem) {
      return { ok: false, message: `项目包含无法导出的数据（${problem}），导出被拒绝` };
    }
    let text: string;
    try {
      text = serializeProjectPackage(pkg);
    } catch (error) {
      return { ok: false, message: `项目无法导出（序列化失败）：${failureMessage(error)}` };
    }
    return {
      ok: true,
      text,
      filename: `${safeFilename(pkg.manifest.project.name)}.lumora`,
      bytes: estimatePackageBytes(text),
    };
  }

  /** 配额估算（导出预检；浏览器不支持时返回 null）。 */
  estimateQuota(): Promise<{ usage: number; quota: number } | null> {
    return estimateStorage();
  }

  /**
   * 解析工程包文本（纯函数，不产生副作用）：失败时当前项目不受任何影响（AC3 失败回滚）。
   * 成功返回待打开的项目与缺失资产明细，由调用方决定打开。
   */
  async importPackage(text: string): Promise<ImportResult> {
    const result = await parseProjectPackage(text);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, project: result.project, warnings: result.warnings, migratedFrom: result.migratedFrom };
  }

  /** 卸载：最终冲刷 + 断开自动保存与存储连接。
   *  第三十五轮阻断 1 重构：最终冲刷成功是进入 commit 的前置条件 —— autosaver
   *  .dispose()（cancelTimer + flush/recovery 检查 + forceTeardown 原子化封存）
   *  是唯一可恢复步骤，失败原样返回 {ok:false}（编辑与 autosave 完整保留、可
   *  重试），绝不强制 teardown 改写成卸载成功；只有 autosaver 已成功封存后，
   *  store/host/cache 剩余步骤才走 ok:true + message 终态 best-effort。
   *  修复前 commit 内二次调用 autosaver.dispose()：外层 preflight 成功 → 间隙
   *  出现新编辑 → 内层 flush 落盘失败 → autosaver 返回 {ok:false} 且未 teardown
   *  （可恢复），但此处写入 message、强制 teardown、返回 {ok:true} —— runtime
   *  销毁编辑器、内存 recovery 中的新编辑丢失。 */
  dispose(): Promise<SaveOutcome> {
    // 第三十一轮严重 3：成功后永久复用同一成功结果对象（不再触碰 autosaver/订阅）
    if (this.disposed) return this.disposePromise ?? Promise.resolve({ ok: true });
    // 第三十一轮严重 3：幂等合并 —— 并发调用共享同一 in-flight 执行
    // （修复前并发调用都在 disposed 置位前越过守卫，重复冲刷/重复 teardown）；
    // 非 async 直接返回缓存 promise，并发调用拿到同一对象（与 close()/runtime
    // dispose() 同型）
    if (this.disposePromise) return this.disposePromise;
    // 第三十五轮严重 3：同步关闭新 init 准入（在返回 promise 之前生效）——
    // dispose 开始后晚到的 init 一律 no-op（见 init 守卫）；preflight 失败时
    // 重新开放
    this.initAdmissionOpen = false;
    this.disposePromise = (async (): Promise<SaveOutcome> => {
      // commit 前置收敛点：先等在途 init settle（single-flight + 准入已关，
      // 此刻不存在其他未收敛创建任务）—— init 成功则 store 已挂载（disposePhase
      // 仍为 idle，晚到 store 正常挂载而非转 lateStore），之后才做 preflight。
      // 修复前 preflight 先跑：失败时晚到 store 既不挂载也不关闭（连接悬挂、
      // 编辑静默退化内存模式），且 runtime 仍标 initialized、后续 init 不补做
      const inFlightInit = this.initPromise;
      if (inFlightInit) {
        try {
          await inFlightInit;
        } catch {
          // init 自身失败：已 settle 清理（第三十三轮一般 5），无 store 需处理
        }
      }
      // preflight = autosaver.dispose()（第三十五轮阻断 1：最终冲刷 + 封存
      // 原子化，唯一可恢复步骤）—— 失败即原样返回 {ok:false}，autosaver/
      // 订阅/store 全部保留（flush 失败时 dispose() 未 teardown、仍可编辑可
      // 落盘），运行时恢复普通可编辑状态；意外拒绝同样归一为可恢复失败
      this.disposePhase = 'preflighting';
      let sealed: SaveOutcome;
      try {
        sealed = await this.autosaver.dispose();
      } catch (error) {
        // 第三十六轮严重 3：autosaver 已开始终态化（disposed 置位）后的异常
        // 不得解释为可恢复失败重开准入 —— 两层死壳（UI 保留但 autosave
        // no-op、重试因 disposed 假成功）。该异常理论上已被 autosaver 内部
        // 归一（forceTeardown 逐步骤 best-effort、dispose 全路径归档为
        // {ok:true,message}），此处为防御兜底：归档进终态 message 继续 commit
        if (this.autosaver.isDisposed) {
          return this.commitDispose([`自动保存终态清理失败：${failureMessage(error)}`]);
        }
        this.disposePhase = 'idle';
        this.initAdmissionOpen = true;
        return { ok: false, code: 'storage-error', message: failureMessage(error) };
      }
      if (!sealed.ok) {
        this.disposePhase = 'idle';
        this.initAdmissionOpen = true;
        return sealed;
      }
      // sealed.ok：终态化开始 —— sealed.message（autosaver 终态清理部分失败
      // 明细，第三十六轮严重 3）并入终态 message 透传，绝不丢弃诊断
      return this.commitDispose(sealed.message ? [sealed.message] : []);
    })();
    const inFlight = this.disposePromise;
    // 失败：清空缓存允许重试 —— 仅当 ref 仍指向本次结果（并发调用共享同一
    // promise，慢成员 settle 时不得清掉已在重试的新一轮）
    void inFlight.then((outcome) => {
      if (!outcome.ok && this.disposePromise === inFlight) this.disposePromise = null;
    });
    return inFlight;
  }

  /**
   * 终态 commit（第三十三轮阻断 2 + 第三十四轮阻断 3，第三十六轮严重 3 拆出）：
   * autosaver 已成功封存（disposed=true、窗口监听已移除）后调用 —— 自此任何
   * 失败不再返回可恢复 {ok:false}（宿主不得再面对「可编辑但不可保存」死壳），
   * 剩余步骤（lateStore/正式 store 关闭、编辑器订阅、事件总线）逐项尽力收敛，
   * 失败并入 message、ok 仍为 true。sealedMessages 为 autosaver 终态阶段归档
   * 的明细（其 forceTeardown 部分失败等），与 commit 自身失败一并透传。
   */
  private commitDispose(sealedMessages: string[]): SaveOutcome {
    this.disposePhase = 'committing';
    const failures: string[] = [...sealedMessages];
    if (this.lateStore) {
      const late = this.lateStore;
      try {
        late.close();
        this.lateStore = null;
      } catch (error) {
        failures.push(`晚到存储关闭失败：${failureMessage(error)}`);
      }
    }
    try {
      this.unsubscribeEditor?.dispose();
    } catch (error) {
      failures.push(failureMessage(error));
    }
    this.unsubscribeEditor = null;
    try {
      this.store?.close();
    } catch (error) {
      failures.push(failureMessage(error));
    }
    this.store = null;
    this.currentUri = null;
    try {
      this.events.dispose();
    } catch (error) {
      failures.push(failureMessage(error));
    }
    this.disposed = true;
    this.disposePhase = 'disposed';
    return failures.length === 0 ? { ok: true } : { ok: true, message: `终态释放部分失败：${failures.join('；')}` };
  }
}
