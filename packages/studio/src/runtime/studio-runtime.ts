import { PluginHost, SceneEditor } from '@lumora/core';
import type { EventMap, Project } from '@lumora/core';

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
  openProject(project: Project): void;
  closeProject(): void;
  getProject(): Project | null;
  dispose(): Promise<void>;
}

export function createStudioRuntime(options: StudioRuntimeOptions = {}): StudioRuntime {
  const host = new PluginHost({
    hostVersion: options.hostVersion,
    onError: options.onError,
  });
  const editor = new SceneEditor();
  let disposed = false;
  // 编辑器每次变更（提交/撤销/重做/打开/关闭）都同步宿主快照并广播给插件
  const unsubscribe = editor.events.on('project:changed', ({ project }) => {
    if (disposed) return;
    host.setProject(project);
    host.events.emit('project:changed', { project });
  });
  return {
    host,
    editor,
    get events() {
      return host.events;
    },
    openProject(project) {
      host.setProject(project);
      host.events.emit('project:opened', { uri: project.uri, name: project.name, project });
      editor.openProject(project);
    },
    closeProject() {
      const current = host.getProject();
      if (current) {
        host.setProject(null);
        host.events.emit('project:closed', { uri: current.uri });
      }
      editor.reset();
    },
    getProject: () => editor.getProject(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe.dispose();
      editor.dispose();
      await host.dispose();
    },
  };
}
