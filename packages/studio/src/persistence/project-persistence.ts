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
    this.unsubscribeEditor = editor.events.on('project:changed', ({ project }) => {
      if (!this.disposed) {
        this.autosaver.changed(project);
        if (project) this.currentUri = project.uri;
        else this.currentUri = null;
      }
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
   *  options.store 为测试注入（跳过按后端创建，直接使用给定存储实例）。 */
  async init(
    options: { debounceMs?: number; dbName?: string; storage?: StorageBackend; store?: ProjectStorage } = {},
  ): Promise<void> {
    if (this.disposed || this.store) return;
    this.store =
      options.store ??
      (options.storage === 'opfs' ? await OpfsProjectStore.create(options.dbName) : await ProjectStore.create(options.dbName));
    this.autosaver.setStore(this.store);
    if (options.debounceMs !== undefined) this.autosaver.setDebounceMs(options.debounceMs);
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
   * 「另存副本」源内容决策（第八轮 #2）：uri 为当前打开项目且有未保存编辑时，
   * 以编辑器现场为准 —— 慢速保存/重试落盘期间的新编辑不得被旧恢复快照覆盖丢弃；
   * 否则取该 uri 的恢复快照（切换/关闭时保存失败被保留的内容）；均无返回 null
   * （调用方走存储复制路径）。
   */
  resolveSaveAsCopySource(uri: string): Project | null {
    if (this.currentUri === uri && this.autosaver.hasUnsavedContent()) {
      return this.editor.getProject();
    }
    return this.autosaver.getRecovery(uri);
  }

  /** 显式重试保存恢复快照（成功清除恢复快照与锁存；失败返回错误）。 */
  retryRecovery(uri: string): Promise<SaveOutcome> {
    return this.autosaver.retryRecovery(uri);
  }

  /** 清除恢复快照（用户已另存副本等显式决定后调用）。 */
  clearRecovery(uri: string): void {
    this.autosaver.clearRecovery(uri);
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

  /** 卸载：冲刷未保存变更、断开自动保存与存储连接。
   *  第二十八轮阻断 4：autosaver 冲刷失败时如实返回失败 —— 不得继续 teardown
   *  （断开监听/关闭存储/清 events），调用方（StudioRuntime）据此保留编辑器与
   *  存储供重试，绝不「假装已卸载」丢弃未落盘内容。 */
  async dispose(): Promise<SaveOutcome> {
    if (this.disposed) return { ok: true };
    const outcome = await this.autosaver.dispose();
    if (!outcome.ok) return outcome;
    this.disposed = true;
    this.unsubscribeEditor?.dispose();
    this.unsubscribeEditor = null;
    this.store?.close();
    this.store = null;
    this.currentUri = null;
    this.events.dispose();
    return { ok: true };
  }
}
