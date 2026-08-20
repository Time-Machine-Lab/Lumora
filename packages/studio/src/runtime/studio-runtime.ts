import { PluginHost } from '@lumora/core';
import type { EventMap, Project } from '@lumora/core';

export interface StudioRuntimeOptions {
  hostVersion?: string;
  onError?: (error: unknown) => void;
}

/**
 * LumoraStudio 的运行时句柄：持有插件宿主并封装项目生命周期。
 * dispose() 停用全部插件、清空总线 —— 供宿主在卸载组件时释放 WebGL/订阅资源。
 */
export interface StudioRuntime {
  host: PluginHost;
  events: import('@lumora/core').TypedEventEmitter<EventMap>;
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
  let disposed = false;
  return {
    host,
    get events() {
      return host.events;
    },
    openProject(project) {
      host.setProject(project);
      host.events.emit('project:opened', { uri: project.uri, name: project.name, project });
    },
    closeProject() {
      const current = host.getProject();
      if (current) {
        host.setProject(null);
        host.events.emit('project:closed', { uri: current.uri });
      }
    },
    getProject: () => host.getProject(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await host.dispose();
    },
  };
}
