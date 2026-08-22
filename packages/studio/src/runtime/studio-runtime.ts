import { PluginHost, SceneEditor } from '@lumora/core';
import type { EventMap, Project } from '@lumora/core';
import { ProjectPersistence } from '../persistence/project-persistence';

export interface StudioRuntimeOptions {
  hostVersion?: string;
  onError?: (error: unknown) => void;
}

/**
 * LumoraStudio 的运行时句柄：持有插件宿主与核心场景编辑器，封装项目生命周期。
 * 编辑器是项目数据的唯一权威来源：宿主快照与事件总线随编辑器每次变更同步
 * （插件/命令/面板经 host.getProject() 读到的永远是当前项目，而非打开时的旧快照）。
 * dispose() 停用全部插件、清空总线与编辑器 —— 供宿主在卸载组件时释放 WebGL/订阅资源。
 */
export interface StudioRuntime {
  host: PluginHost;
  events: import('@lumora/core').TypedEventEmitter<EventMap>;
  /** 核心场景编辑器：项目数据、选择、视口状态与历史栈（撤销/重做）的唯一持有者 */
  editor: SceneEditor;
  /**
   * 项目持久化门面：IndexedDB 本地存储（最近项目/重命名/复制/删除）、
   * 2 秒防抖自动保存与 `.lumora` 工程包导入导出。init() 后生效；
   * IndexedDB 不可用时静默降级（available = false，仅内存编辑）。
   */
  persistence: ProjectPersistence;
  /** 初始化本地存储并接入自动保存（幂等）。 */
  init(options?: { debounceMs?: number; dbName?: string }): Promise<void>;
  openProject(project: Project): void;
  /**
   * 关闭项目：等待未保存变更全量落盘（排空屏障）后重置编辑器。
   * 落盘失败时返回 { ok: false } 且不重置编辑器（未保存内容仍在编辑器中），
   * 调用方必须阻止关闭/切换。
   */
  closeProject(): Promise<{ ok: boolean; message?: string }>;
  getProject(): Project | null;
  dispose(): Promise<void>;
}

export function createStudioRuntime(options: StudioRuntimeOptions = {}): StudioRuntime {
  const host = new PluginHost({
    hostVersion: options.hostVersion,
    onError: options.onError,
  });
  const editor = new SceneEditor();
  const persistence = new ProjectPersistence(editor);
  let disposed = false;
  let initialized = false;
  // 编辑器每次变更（提交/撤销/重做/打开/关闭）都同步宿主快照并广播给插件
  const unsubscribe = editor.events.on('project:changed', ({ project }) => {
    if (disposed) return;
    host.setProject(project);
    host.events.emit('project:changed', { project });
  });
  return {
    host,
    editor,
    persistence,
    get events() {
      return host.events;
    },
    async init(options) {
      if (initialized || disposed) return;
      initialized = true;
      await persistence.init(options);
    },
    openProject(project) {
      // 编辑器先校验并取得 owned immutable 快照（深克隆 + 冻结），宿主/插件只能拿到
      // 编辑器持有的快照，调用方传入的项目此后与编辑器完全解耦
      editor.openProject(project);
      const owned = editor.getProject()!;
      host.setProject(owned);
      host.events.emit('project:opened', { uri: owned.uri, name: owned.name, project: owned });
    },
    async closeProject() {
      const current = host.getProject();
      if (current) {
        // 先等待未保存变更全量落盘（排空屏障，含在途保存）：失败时保留编辑器
        // 与未保存内容，放行关闭即丢失（恢复快照也不替代「仍在编辑器」的现场）
        const outcome = await persistence.flushPending();
        if (!outcome.ok) return { ok: false, message: outcome.message };
        host.setProject(null);
        host.events.emit('project:closed', { uri: current.uri });
      }
      editor.reset();
      return { ok: true };
    },
    getProject: () => editor.getProject(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe.dispose();
      // 先冲刷自动保存（flush 需读取未销毁的编辑器），再依次释放
      await persistence.dispose();
      editor.dispose();
      await host.dispose();
    },
  };
}
