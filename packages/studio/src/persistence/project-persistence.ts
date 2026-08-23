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
  PUBLIC_PROJECT_FIELDS,
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
import { estimateStorage, failureMessage } from './project-storage';
import type { DuplicateOutcome, ProjectStorage, ProjectSummary, SaveOutcome, StorageBackend } from './project-storage';

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

/** 根级导出字段的反射读取（第十一轮一般 #6）：以 property descriptor 判定字段
 *  存在与可导出性 —— 不执行属性读取（getter/Proxy trap 不得在预检前产生副作用）；
 *  访问器字段直接拒绝（JSON.stringify/structuredClone 都会调用 getter，结果不可
 *  预测，与 findJsonEncodingProblem 的 accessor-property 语义一致）；反射抛错
 *  （getOwnPropertyDescriptor trap）归一为类型化失败。 */
function reflectProjectField(
  project: Project,
  field: string,
): { ok: true; value?: unknown } | { ok: false; message: string } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(project, field);
  } catch {
    return { ok: false, message: `项目字段 ${field} 无法反射（代理陷阱抛错），导出被拒绝` };
  }
  if (!descriptor) return { ok: true };
  if ('get' in descriptor || 'set' in descriptor) {
    return { ok: false, message: `项目字段 ${field} 是访问器属性，无法安全导出` };
  }
  return { ok: true, value: descriptor.value };
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
      if (!this.disposed) this.events.emit('save-state', { state });
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

  /** 最近项目列表（按保存时间倒序）。 */
  async listRecent(): Promise<ProjectSummary[]> {
    return this.store ? this.store.list() : [];
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
    const stored = await this.store.load(uri);
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

  /** 本地是否已存在同 uri 记录（导入防碰撞：同 uri 视为副本导入）。 */
  async hasLocal(uri: string): Promise<boolean> {
    if (!this.store) return false;
    return (await this.store.load(uri)) !== null;
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
   *  ≠ 数据可用（故障存储可写入损坏记录），验证失败即清除该记录并返回可操作错误 ——
   *  副本未产生，调用方不得报成功。 */
  async saveSnapshotAsNew(
    project: Project,
    name?: string,
  ): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
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
    const verified = await this.loadProject(copy.uri);
    if (!verified.ok) {
      await this.store.remove(copy.uri);
      return { ok: false, message: `副本保存失败（数据无法通过校验）：${verified.message}` };
    }
    return { ok: true, project: verified.project };
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
   *  打开中的项目以编辑器快照为准（磁盘记录可能落后于未保存变更）；未打开的走存储。 */
  async duplicateProject(uri: string, name?: string): Promise<DuplicateOutcome> {
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
      const result = await this.store.save(copy, null);
      if (!result.ok) return { ok: false, code: 'storage-error', message: result.message };
      // 与 saveSnapshotAsNew 同一验证管道（第十一轮严重 #3）：存储写入成功 ≠ 可打开，
      // 失败即清除记录 —— 副本未产生，调用方不得报成功
      const verified = await this.loadProject(copy.uri);
      if (!verified.ok) {
        await this.store.remove(copy.uri);
        return {
          ok: false,
          code: 'storage-error',
          message: `副本保存失败（数据无法通过校验）：${verified.message}`,
        };
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
      };
    }
    return this.store.duplicate(uri, name);
  }

  /** 删除项目（仅存储记录；已打开的当前项目由调用方先 closeProject）。 */
  async deleteProject(uri: string): Promise<boolean> {
    return this.store ? this.store.remove(uri) : false;
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
   * 结构化契约（第十一轮）：settings 按契约字段投影、pluginData 仅按插件
   * manifest.privateSettings 显式声明剥离（privateKeysByPlugin），默认导出时
   * pluginData 整体不进包 —— 不再依赖键名词表猜测（NFR-008）。
   * 编码预检（第九轮 #2）作用于「将被导出字段的原始值」而非构建后的克隆包：
   * buildProjectPackage 先 structuredClone 再投影 —— Symbol 键/不可枚举属性/
   * 访问器已在克隆中被删除或物化，克隆后再检查看不到原输入问题，会静默产出
   * 丢字段的包。此处先按同一白名单（PUBLIC_PROJECT_FIELDS + 可选 pluginData）
   * 从原项目投影导出字段（引用原值，反射检查看到的就是原图），预检通过后才
   * 构建；构建/序列化抛错（DataCloneError/getter 副作用）归一为类型化失败。
   * 根级投影基于 property descriptor（第十一轮一般 #6）：字段存在/可导出性以
   * getOwnPropertyDescriptor 判定，不执行属性读取 —— getter 副作用不得发生在
   * 预检之前；访问器字段与反射异常（Proxy trap）在读取前被拒绝为类型化失败。
   */
  exportCurrent(options: { includePrivate?: boolean; privateKeysByPlugin?: Record<string, string[]> } = {}): ExportResult {
    const project = this.editor.getProject();
    if (!project) return { ok: false, message: '当前没有打开的项目' };
    const includePrivate = options.includePrivate ?? false;
    const projected: Record<string, unknown> = {};
    for (const field of PUBLIC_PROJECT_FIELDS) {
      const reflected = reflectProjectField(project, field);
      if (!reflected.ok) return reflected;
      if (reflected.value !== undefined) projected[field] = reflected.value;
    }
    if (includePrivate) {
      const reflected = reflectProjectField(project, 'pluginData');
      if (!reflected.ok) return reflected;
      if (reflected.value !== undefined) projected.pluginData = reflected.value;
    }
    const problem = findJsonEncodingProblem(projected);
    if (problem) {
      return { ok: false, message: `项目包含无法导出的数据（${problem}），导出被拒绝` };
    }
    let pkg: ProjectPackage;
    try {
      pkg = buildProjectPackage(project, { includePrivate, privateKeysByPlugin: options.privateKeysByPlugin });
    } catch (error) {
      return { ok: false, message: `项目无法导出（构建失败）：${failureMessage(error)}` };
    }
    let text: string;
    try {
      text = serializeProjectPackage(pkg);
    } catch (error) {
      return { ok: false, message: `项目无法导出（序列化失败）：${failureMessage(error)}` };
    }
    return { ok: true, text, filename: `${safeFilename(project.name)}.lumora`, bytes: estimatePackageBytes(text) };
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

  /** 卸载：冲刷未保存变更、断开自动保存与存储连接。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEditor?.dispose();
    this.unsubscribeEditor = null;
    await this.autosaver.dispose();
    this.store?.close();
    this.store = null;
    this.currentUri = null;
    this.events.dispose();
  }
}
