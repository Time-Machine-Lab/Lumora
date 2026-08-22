/**
 * 项目持久化门面（FR-001 / FR-011）：StudioRuntime 与 UI 之间的统一入口。
 *
 * - 本地存储：IndexedDB ProjectStore（新建/重命名/复制/删除/最近项目）；
 * - 自动保存：ProjectAutosaver 随编辑器事件防抖落盘（2 秒），失败保持脏状态；
 * - 工程包：导出（buildProjectPackage 剥离私有数据 + 配额预检）与导入
 *   （parseProjectPackage 纯函数解析，校验失败不产生任何副作用 —— 当前项目
 *   保持原样，失败回滚由「解析通过后才打开」保证）；
 * - 冲突解决：reloadOpenProject（以存储内容为基线重开，显式丢弃未保存变更）
 *   与 duplicateProject（打开中的项目以编辑器快照为准复制，磁盘记录可能落后）。
 *
 * 编辑器监听在构造期同步接入：IndexedDB 打开前的冷启动变更（project:changed）
 * 不会丢失（自动保存先以「仅内存」状态受理，init 完成后重新对账）。
 */

import { TypedEventEmitter, createBlankProject, genId } from '@lumora/core';
import type { Project, SceneEditor } from '@lumora/core';
import {
  buildProjectPackage,
  estimatePackageBytes,
  parseProjectPackage,
  serializeProjectPackage,
} from '@lumora/core';
import type { MissingAssetWarning, PackageImportError } from '@lumora/core';
import { ProjectAutosaver } from './autosave';
import type { AutosaveState } from './autosave';
import { ProjectStore, estimateStorage } from './project-store';
import type { DuplicateOutcome, ProjectSummary } from './project-store';

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
  private store: ProjectStore | null = null;
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

  /** 本地持久化是否可用（IndexedDB 打开失败时静默降级为仅内存编辑） */
  get available(): boolean {
    return this.store !== null;
  }

  /** 打开项目后的当前 uri（重命名/复制等操作据此分流） */
  get openUri(): string | null {
    return this.currentUri;
  }

  /** 初始化：打开存储并接入自动保存。幂等。 */
  async init(options: { debounceMs?: number; dbName?: string } = {}): Promise<void> {
    if (this.disposed || this.store) return;
    this.store = await ProjectStore.create(options.dbName);
    this.autosaver.setStore(this.store);
    if (options.debounceMs !== undefined) this.autosaver.setDebounceMs(options.debounceMs);
  }

  /** 最近项目列表（按保存时间倒序）。 */
  async listRecent(): Promise<ProjectSummary[]> {
    return this.store ? this.store.list() : [];
  }

  /** 加载本地项目（打开最近项目）。 */
  async loadProject(uri: string): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
    if (!this.store) return { ok: false, message: '本地持久化不可用' };
    const project = await this.store.load(uri);
    if (!project) return { ok: false, message: '本地项目不存在或已损坏' };
    return { ok: true, project };
  }

  /** 本地是否已存在同 uri 记录（导入防碰撞：同 uri 视为副本导入）。 */
  async hasLocal(uri: string): Promise<boolean> {
    if (!this.store) return false;
    return (await this.store.load(uri)) !== null;
  }

  /** 立即冲刷未保存变更（关闭项目 / 卸载前调用；不改变打开状态）。 */
  flushPending(): Promise<void> {
    return this.autosaver.flush();
  }

  /**
   * 冲突解决「加载较新版本」：以存储内容为基线重开当前项目。
   * 显式丢弃未保存变更是用户确认的选择；失败返回可操作错误（不改变编辑器状态）。
   */
  async reloadOpenProject(): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
    if (!this.store || !this.currentUri) return { ok: false, message: '本地持久化不可用' };
    const stored = await this.store.load(this.currentUri);
    if (!stored) return { ok: false, message: '本地项目不存在或已损坏' };
    // 先重置自动保存基线（丢弃脏快照），再重开编辑器（触发 project:changed 净态路径）
    this.autosaver.resetTo(stored);
    this.editor.openProject(stored);
    return { ok: true, project: stored };
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

  /** 导出当前项目为 `.lumora` 工程包（同步纯构建；私有数据恒排除，NFR-008）。 */
  exportCurrent(): ExportResult {
    const project = this.editor.getProject();
    if (!project) return { ok: false, message: '当前没有打开的项目' };
    const pkg = buildProjectPackage(project);
    const text = serializeProjectPackage(pkg);
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
