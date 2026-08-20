import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PluginDescriptor, Project } from '@lumora/core';
import { createStudioRuntime } from '../runtime/studio-runtime';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { PanelHost } from './panels/PanelHost';
import { Toolbar } from './Toolbar';
import { CommandPalette } from './CommandPalette';
import { PluginManager } from './PluginManager';
import { SceneView } from './SceneView';
import '../lumora.css';

export interface LumoraStudioProps {
  /** 挂载时注册的插件描述符；注册按声明顺序串行执行 */
  plugins?: PluginDescriptor[];
  hostVersion?: string;
  /** 挂载后自动打开的项目（同时发出 project:opened 事件） */
  initialProject?: Project;
  onError?: (error: unknown) => void;
  /** 场景槽位，缺省为内置 Three.js 场景视图 */
  scene?: (project: Project | null) => ReactNode;
  className?: string;
}

export interface LumoraStudioHandle {
  runtime: StudioRuntime;
}

/**
 * 可嵌入的 Lumora Studio 壳层：
 * - 创建并管理插件宿主运行时（事件总线、命令、贡献项）
 * - 卸载时释放全部资源：停用插件、移除订阅、销毁事件总线与 WebGL 场景
 */
export const LumoraStudio = forwardRef<LumoraStudioHandle, LumoraStudioProps>(function LumoraStudio(
  { plugins = [], hostVersion, initialProject, onError, scene, className },
  ref,
) {
  const runtimeRef = useRef<StudioRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createStudioRuntime({ hostVersion, onError });
  }
  const runtime = runtimeRef.current;

  const [project, setProject] = useState<Project | null>(initialProject ?? null);
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useImperativeHandle(ref, () => ({ runtime }), [runtime]);

  // 项目状态跟随运行时事件（外部可通过 handle.runtime.openProject 打开项目）
  useEffect(() => {
    const opened = runtime.events.on('project:opened', ({ project: openedProject }) =>
      setProject(openedProject),
    );
    const closed = runtime.events.on('project:closed', () => setProject(null));
    return () => {
      opened.dispose();
      closed.dispose();
    };
  }, [runtime]);

  // 挂载时一次性启动：注册插件并打开初始项目（与 props 变化解耦，避免重复注册）。
  // StrictMode 下 effect 会卸载重放：boot 只执行一次，重放与真实卸载都注册 cleanup，
  // 取消标记使慢入口在最终卸载后不再继续注册插件或写入初始项目
  const bootStartedRef = useRef(false);
  const cancelBootRef = useRef(false);
  useEffect(() => {
    // 每次 setup 清除取消标记：StrictMode 重放不会永久取消首个 effect 发起的启动
    cancelBootRef.current = false;
    if (!bootStartedRef.current) {
      bootStartedRef.current = true;
      const pluginsRef = plugins;
      const initialRef = initialProject;
      const onErrorRef = onError;
      const boot = async () => {
        for (const descriptor of pluginsRef) {
          if (cancelBootRef.current) return;
          try {
            await runtime.host.register(descriptor);
          } catch (error) {
            onErrorRef?.(error);
          }
        }
        if (!cancelBootRef.current && initialRef) runtime.openProject(initialRef);
      };
      void boot();
    }
    return () => {
      cancelBootRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 一次性启动，故意与 props 变化解耦
  }, [runtime]);

  // 真实卸载时释放运行时。StrictMode 会把 effect 卸载后重放：cleanup 若直接
  // dispose 会销毁重放后仍要使用的运行时；DOM ref 回调同样会被 React 19
  // StrictMode 重放。因此用「挂载计数 + 延迟确认」：cleanup 先减计数，
  // 重放的下轮 setup 及时加回则取消释放，仅在最终卸载时真正 dispose
  const mountedRef = useRef(0);
  useEffect(() => {
    mountedRef.current += 1;
    return () => {
      mountedRef.current -= 1;
      setTimeout(() => {
        if (mountedRef.current === 0) void runtime.dispose();
      }, 0);
    };
  }, [runtime]);

  // Ctrl/Cmd+K 打开命令面板
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`lumora-studio${className ? ` ${className}` : ''}`} data-testid="lumora-studio">
      <Toolbar
        runtime={runtime}
        project={project}
        onTogglePlugins={() => setPluginManagerOpen((open) => !open)}
        onTogglePalette={() => setPaletteOpen((open) => !open)}
      />
      <div className="lumora-studio__body">
        <PanelHost
          runtime={runtime}
          project={project}
          onDisablePlugin={(pluginId) => void runtime.host.disable(pluginId)}
        />
        <main className="lumora-studio__viewport">
          {scene ? scene(project) : <SceneView project={project} />}
          {!project && (
            <div className="lumora-studio__empty" data-testid="studio-empty-hint">
              尚未打开项目 —— 点击工具栏「打开示例项目」
            </div>
          )}
        </main>
      </div>
      {pluginManagerOpen && <PluginManager runtime={runtime} onClose={() => setPluginManagerOpen(false)} />}
      {paletteOpen && <CommandPalette runtime={runtime} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
});
