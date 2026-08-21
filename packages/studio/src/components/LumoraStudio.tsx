import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PluginDescriptor, Project } from '@lumora/core';
import { createStudioRuntime } from '../runtime/studio-runtime';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { useSceneEditor } from '../hooks/use-scene-editor';
import { PanelHost } from './panels/PanelHost';
import { Toolbar } from './Toolbar';
import { CommandPalette } from './CommandPalette';
import { PluginManager } from './PluginManager';
import { EditorViewport } from './editor/EditorViewport';
import { ObjectTree } from './editor/ObjectTree';
import { PropertiesPanel } from './editor/PropertiesPanel';
import { ToastHost, showToast } from './editor/toasts';
import { ContentCache } from './editor/content-cache';
import '../lumora.css';

export interface LumoraStudioProps {
  /** 挂载时注册的插件描述符；注册按声明顺序串行执行 */
  plugins?: PluginDescriptor[];
  hostVersion?: string;
  /** 挂载后自动打开的项目（同时发出 project:opened 事件） */
  initialProject?: Project;
  onError?: (error: unknown) => void;
  /** 场景槽位，缺省为内置 3D 场景编辑器视口 */
  scene?: (project: Project | null) => ReactNode;
  className?: string;
}

export interface LumoraStudioHandle {
  runtime: StudioRuntime;
}

/**
 * 可嵌入的 Lumora Studio 壳层：
 * - 创建并管理插件宿主运行时与核心场景编辑器（对象树/属性/视口/历史）
 * - 卸载时释放全部资源：停用插件、移除订阅、销毁事件总线、资源缓存与 WebGL 场景
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
  const editorState = useSceneEditor(runtime.editor);
  const { project } = editorState;

  const cacheRef = useRef<ContentCache | null>(null);
  if (!cacheRef.current) cacheRef.current = new ContentCache();
  const cache = cacheRef.current;

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({ runtime }), [runtime]);

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
        if (mountedRef.current === 0) {
          cache.dispose();
          void runtime.dispose();
        }
      }, 0);
    };
  }, [runtime, cache]);

  // 编辑器快捷键：撤销/重做/复制/删除/取消选择/Gizmo 模式。
  // 按实例作用域（R8-9）：多个 Studio 实例共存时共享 window 监听，
  // 无焦点包含校验则每个实例都执行全部快捷键（一个实例内按 Delete
  // 会删掉其他实例的选择）——只响应按键落在本实例子树内的快捷
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) return;
      const key = event.key.toLowerCase();
      // 命令面板开关先于输入守卫处理：面板打开时焦点在其搜索输入框内，Ctrl+K 仍需能关闭
      if ((event.ctrlKey || event.metaKey) && key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const editor = runtime.editor;
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        const result = event.shiftKey ? editor.redo() : editor.undo();
        if (!result.ok) showToast(result.error.message, 'error');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        const result = editor.redo();
        if (!result.ok) showToast(result.error.message, 'error');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'd') {
        event.preventDefault();
        const result = editor.duplicateSelection();
        if (!result.ok) showToast(result.error.message, 'error');
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const result = editor.deleteSelection();
        if (!result.ok) showToast(result.error.message, 'error');
        return;
      }
      if (event.key === 'Escape') {
        editor.clearSelection();
        return;
      }
      if (event.key === '1') editor.setTransformMode('translate');
      else if (event.key === '2') editor.setTransformMode('rotate');
      else if (event.key === '3') editor.setTransformMode('scale');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runtime]);

  return (
    <div ref={rootRef} className={`lumora-studio${className ? ` ${className}` : ''}`} data-testid="lumora-studio">
      <Toolbar
        runtime={runtime}
        project={project}
        editorState={editorState}
        cache={cache}
        onTogglePlugins={() => setPluginManagerOpen((open) => !open)}
        onTogglePalette={() => setPaletteOpen((open) => !open)}
      />
      <div className="lumora-studio__body">
        <div className="lumora-studio__sidebar">
          <ObjectTree
            editor={runtime.editor}
            project={project}
            selection={editorState.selection}
            cache={cache}
          />
          <PanelHost
            runtime={runtime}
            project={project}
            onDisablePlugin={(pluginId) => void runtime.host.disable(pluginId)}
          />
        </div>
        <main className="lumora-studio__viewport">
          {scene ? (
            scene(project)
          ) : (
            <EditorViewport
              editor={runtime.editor}
              project={project}
              selection={editorState.selection}
              view={editorState.view}
              cache={cache}
            />
          )}
          {!project && (
            <div className="lumora-studio__empty" data-testid="studio-empty-hint">
              尚未打开项目 —— 点击工具栏「打开示例项目」
            </div>
          )}
        </main>
        <PropertiesPanel
          editor={runtime.editor}
          project={project}
          selection={editorState.selection}
        />
      </div>
      <ToastHost />
      {pluginManagerOpen && <PluginManager runtime={runtime} onClose={() => setPluginManagerOpen(false)} />}
      {paletteOpen && <CommandPalette runtime={runtime} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
});
