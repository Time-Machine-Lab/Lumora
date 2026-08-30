import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { findObject } from '@lumora/core';
import type { PluginDescriptor, Project } from '@lumora/core';
import { createStudioRuntime } from '../runtime/studio-runtime';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { BrowserPluginSettingsStorage } from '../runtime/browser-plugin-settings';
import { useSceneEditor } from '../hooks/use-scene-editor';
import { useTimelineSession } from '../hooks/use-timeline-session';
import type { AutosaveState } from '../persistence/autosave';
import type { StorageBackend } from '../persistence/project-storage';
import { PanelHost } from './panels/PanelHost';
import { Toolbar } from './Toolbar';
import { CommandPalette } from './CommandPalette';
import { PluginManager } from './PluginManager';
import { ModalDialog } from './ModalDialog';
import { EditorViewport } from './editor/EditorViewport';
import { TimelinePanel } from './editor/TimelinePanel';
import { ObjectTree } from './editor/ObjectTree';
import { PropertiesPanel } from './editor/PropertiesPanel';
import { StoryboardWorkspace } from './storyboard/StoryboardWorkspace';
import { ExportWorkspace } from './export/ExportWorkspace';
import type { ExportFrameCapture } from './export/ExportWorkspace';
import { ToastHost, showToast } from './editor/toasts';
import { ContentCache } from './editor/content-cache';
import { LiveTransformStore } from './editor/live-transform-store';
import { DRIVE_KEY_CODES } from './editor/camera-drive';
import type { KeyboardShortcut } from './editor/recording-shortcut';
import {
  loadRecordingShortcut,
  matchesShortcut,
  saveRecordingShortcut,
} from './editor/recording-shortcut';
import {
  isKeyboardEventForStudio,
  preservesNativeKeyboardSemantics,
  registerStudioKeyboardRoot,
} from './studio-keyboard-scope';
import '../lumora.css';

/**
 * 第三十六轮一般 4：宿主 onCloseError 回调的统一安全调用 —— 同步 throw 隔离，
 * 返回 thenable（async 回调）的 rejection 吸收（挂空 catch 接住，绝不产生
 * unhandledrejection）。修复前调用点各自 try/catch 只覆盖同步异常，宿主传
 * async 回调时 Promise rejection 被直接丢弃。
 */
function invokeCloseError(
  callback: ((message: string) => void | Promise<void>) | undefined,
  message: string,
): void {
  if (!callback) return;
  try {
    const result = callback(message);
    if (result && typeof (result as Promise<void>).then === 'function') {
      void Promise.resolve(result).catch(() => {
        // 吸收宿主异步回调的 rejection，不让其外溢为未处理拒绝
      });
    }
  } catch {
    // 宿主同步 throw 已隔离，不外溢
  }
}

function isStudioEditingShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (
    key === ' ' ||
    key === 'delete' ||
    key === 'backspace' ||
    key === 'escape' ||
    key === '1' ||
    key === '2' ||
    key === '3' ||
    ((event.ctrlKey || event.metaKey) && (key === 'k' || key === 'z' || key === 'y' || key === 'd')) ||
    DRIVE_KEY_CODES.has(event.code)
  );
}

function isExportIsolatedShortcut(
  event: KeyboardEvent,
  recordingShortcut: KeyboardShortcut,
): boolean {
  return isStudioEditingShortcut(event) || matchesShortcut(event, recordingShortcut);
}

export interface LumoraStudioProps {
  /** 挂载时注册的插件描述符；注册按声明顺序串行执行 */
  plugins?: PluginDescriptor[];
  hostVersion?: string;
  /** 挂载后自动打开的项目（同时发出 project:opened 事件） */
  initialProject?: Project;
  onError?: (error: unknown) => void;
  /** 卸载失败回调（第三十轮严重 6）：卸载屏障返回失败时收到失败原因（字符串），
   *  运行时保留未 teardown —— 宿主应保持壳层挂载并等待 handle.close() 重试。
   *  允许 async 回调（第三十六轮一般 4：rejection 由壳层统一吸收，绝不产生
   *  未处理拒绝） */
  onCloseError?: (message: string) => void | Promise<void>;
  /** 场景槽位，缺省为内置 3D 场景编辑器视口 */
  scene?: (project: Project | null) => ReactNode;
  /** 本地存储后端（缺省 indexeddb；opfs = Origin Private File System） */
  storage?: StorageBackend;
  /**
   * 非敏感插件设置的 Studio 实例命名空间。嵌入方需要跨卸载/重载恢复设置时应提供稳定值；
   * 缺省使用 React 实例 id，保证同页多个 Studio 不共享设置。
   */
  pluginSettingsNamespace?: string;
  className?: string;
}

export interface LumoraStudioHandle {
  runtime: StudioRuntime;
  /** 卸载屏障（第三十轮严重 6）：宿主卸载前可等待的释放 —— 冲刷失败或存在未解决
   *  恢复 fork 时返回 { ok: false }，运行时保留未 teardown（未落盘内容仍可恢复，
   *  资源缓存不释放）；成功后运行时与资源缓存一同释放（缓存恰好释放一次）。
   *  返回即最终裁决，宿主据此决定是否真正卸载 UI / 等待用户解决后重试 */
  close(): Promise<{ ok: boolean; message?: string }>;
}

/**
 * 可嵌入的 Lumora Studio 壳层：
 * - 创建并管理插件宿主运行时与核心场景编辑器（对象树/属性/视口/历史）
 * - 卸载时释放全部资源：停用插件、移除订阅、销毁事件总线、资源缓存与 WebGL 场景
 */
export const LumoraStudio = forwardRef<LumoraStudioHandle, LumoraStudioProps>(function LumoraStudio(
  {
    plugins = [],
    hostVersion,
    initialProject,
    onError,
    onCloseError,
    scene,
    storage,
    pluginSettingsNamespace,
    className,
  },
  ref,
) {
  const generatedPluginSettingsNamespace = useId();
  const pluginSettingsStorageRef = useRef<BrowserPluginSettingsStorage | null>(null);
  if (!pluginSettingsStorageRef.current) {
    pluginSettingsStorageRef.current = new BrowserPluginSettingsStorage(
      pluginSettingsNamespace ?? generatedPluginSettingsNamespace,
    );
  }
  const runtimeRef = useRef<StudioRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createStudioRuntime({
      hostVersion,
      onError,
      pluginSettingsStorage: pluginSettingsStorageRef.current,
    });
  }
  const runtime = runtimeRef.current;
  const editorState = useSceneEditor(runtime.editor);
  const { project } = editorState;
  // 统一时间引擎会话（TML-52）：播放/录制/驾驶的时间权威
  const session = useTimelineSession(runtime.editor);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [recordingShortcut, setRecordingShortcut] = useState(() => loadRecordingShortcut());
  const recordingShortcutRef = useRef(recordingShortcut);
  recordingShortcutRef.current = recordingShortcut;
  const handleRecordingShortcutChange = useCallback((shortcut: KeyboardShortcut) => {
    if (!saveRecordingShortcut(shortcut)) return false;
    setRecordingShortcut(shortcut);
    return true;
  }, []);
  const [saveState, setSaveState] = useState<AutosaveState>({ status: 'idle' });
  const overwriteTitleId = useId();

  useEffect(() => {
    const sub = runtime.persistence.events.on('save-state', ({ state }) => setSaveState(state));
    return () => {
      void sub.dispose();
    };
  }, [runtime.persistence.events]);

  const protectBeforeUnload =
    session.state.recording ||
    saveState.status === 'dirty' ||
    saveState.status === 'saving' ||
    saveState.status === 'error' ||
    saveState.status === 'memory';
  useEffect(() => {
    if (!protectBeforeUnload) return;
    const preventDataLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = 'Lumora 仍有未保存的录制内容';
    };
    window.addEventListener('beforeunload', preventDataLoss);
    return () => window.removeEventListener('beforeunload', preventDataLoss);
  }, [protectBeforeUnload]);
  // 分镜缩略图截图通道：EditorViewport 的 FrameCaptureBridge 挂载后可用
  const captureRef = useRef<((cameraObjectId?: string | null) => string | null) | null>(null);
  const exportFrameRef = useRef<ExportFrameCapture | null>(null);
  // 通道就绪状态：仅写 ref 不触发渲染，缩略图链依赖该状态在通道就绪后重跑
  // （复审阻断 2：初载时 effect 早于 FrameCaptureBridge 挂载而空转）
  const [captureReady, setCaptureReady] = useState(false);
  const handleCaptureReady = useCallback((ready: boolean) => setCaptureReady(ready), []);
  const [captureGeneration, setCaptureGeneration] = useState(0);
  const handleRenderContentChange = useCallback(() => setCaptureGeneration((generation) => generation + 1), []);

  const cacheRef = useRef<ContentCache | null>(null);
  if (!cacheRef.current) cacheRef.current = new ContentCache();
  const cache = cacheRef.current;
  const cacheDisposedRef = useRef(false);
  const liveTransformStoreRef = useRef<LiveTransformStore | null>(null);
  if (!liveTransformStoreRef.current) liveTransformStoreRef.current = new LiveTransformStore();
  const liveTransformStore = liveTransformStoreRef.current;

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [storyboardOpen, setStoryboardOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [editorPanel, setEditorPanel] = useState<'scene' | 'objects' | 'properties'>('scene');
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const paletteButtonRef = useRef<HTMLButtonElement>(null);
  const pluginButtonRef = useRef<HTMLButtonElement>(null);
  const paletteReturnFocusRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rememberPaletteReturnFocus = useCallback(() => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    paletteReturnFocusRef.current =
      activeElement && activeElement !== document.body ? activeElement : paletteButtonRef.current;
  }, []);

  useEffect(() => {
    const closeWorkspace = () => {
      setStoryboardOpen(false);
      setExportOpen(false);
    };
    const opened = runtime.events.on('project:opened', closeWorkspace);
    const closed = runtime.events.on('project:closed', closeWorkspace);
    return () => {
      opened.dispose();
      closed.dispose();
    };
  }, [runtime.events]);

  // 第三十轮严重 6：统一卸载屏障 —— 卸载 cleanup 与宿主显式卸载共用同一通道。
  // 释放失败（冲刷失败 / 未解决恢复 fork）时运行时保留未 teardown，缓存也不
  // 释放（宿主重试期间壳层完整可用）；成功才释放缓存，且只释放一次（宿主
  // 多次调用 / cleanup 与显式调用并发时不会重复 dispose）。
  // 第三十一轮严重 3 改 single-flight：发布先行 —— 首次调用把 in-flight 结果
  // promise 缓存进 closeInFlightRef，close() 直接返回该缓存（非 async 包装，
  // 并发调用拿到同一 promise 对象，双击/StrictMode cleanup 与宿主显式调用
  // 并发时 runtime.dispose 只执行一次）；失败 settle 后清空缓存允许重试
  // （运行时未 teardown，壳层完整可用），成功后永久复用成功结果（已全部释放，
  // 重复调用幂等）。runtime/cache 的意外拒绝归一为类型化失败返回，绝不把
  // unhandled rejection 交给调用方
  const closeInFlightRef = useRef<Promise<{ ok: boolean; message?: string }> | null>(null);
  const close = useCallback((): Promise<{ ok: boolean; message?: string }> => {
    if (closeInFlightRef.current) return closeInFlightRef.current;
    // Defer the body so the shared promise is published before any synchronous
    // recording commit can emit an event that re-enters close(). The outer
    // catch also preserves the typed-result contract for unexpected finalizer
    // failures and lets the caller retry with the retained recorder samples.
    const inFlight: Promise<{ ok: boolean; message?: string }> = Promise.resolve()
      .then(async (): Promise<{ ok: boolean; message?: string }> => {
        // recorder.active is synchronous, while state.recording can lag a start
        // by one render. Finalization is two-phase: a failed atomic commit keeps
        // the paused samples in memory and blocks runtime teardown for retry.
        const activeSession = sessionRef.current;
        if (activeSession.recorder.active) {
          const recordingOutcome = activeSession.stopRecording();
          if (!recordingOutcome.ok) return recordingOutcome;
        }
        const outcome = await runtime.dispose();
        // preflight 失败（冲刷失败 / 未解决恢复 fork）：运行时无任何 teardown，
        // 完整可编辑 —— 宿主保持挂载重试，缓存也不释放（第三十轮严重 6 语义）
        if (!outcome.ok) return outcome;
        // 终态 commit 已收敛（runtime 已终态释放）：缓存释放是终态的最后一步。
        // cache.dispose 契约为 best-effort 不抛错（内部逐资源清理，第三十三轮
        // 阻断 3）—— 意外拒绝归一后仍返回成功：运行态已收敛，卸载不受阻。
        // 修复前 cache 抛错返回 {ok:false}，但 runtime 已销毁：宿主保持挂载
        // 面对「可编辑但不可保存」死壳，重试时跳过缓存释放假报成功。
        // 第三十四轮严重 5：逐层聚合 —— runtime 的 {ok:true, message}（store/
        // host 终态失败明细）与 cache 顶层异常全部并入 message 透传，修复前
        // 无条件返回裸 {ok:true} 连续丢弃诊断
        const messages: string[] = [];
        if (outcome.message) messages.push(outcome.message);
        if (!cacheDisposedRef.current) {
          try {
            cache.dispose();
          } catch (error) {
            messages.push(`缓存资源释放失败：${error instanceof Error ? error.message : String(error)}`);
          }
          cacheDisposedRef.current = true;
        }
        return messages.length === 0 ? { ok: true } : { ok: true, message: messages.join('；') };
      })
      .catch((error): { ok: false; message: string } => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
    closeInFlightRef.current = inFlight;
    // 失败：清空缓存允许重试 —— 仅当 ref 仍指向本次结果（并发调用共享同一
    // promise，慢成员 settle 时不得清掉已在重试的新一轮）
    void inFlight.then((settled) => {
      if (!settled.ok && closeInFlightRef.current === inFlight) closeInFlightRef.current = null;
    });
    return inFlight;
  }, [runtime, cache]);

  useImperativeHandle(ref, () => ({ runtime, close }), [runtime, close]);

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
        // 先接入本地持久化与自动保存，再打开初始项目（自动保存脏基线以打开为准）
        await runtime.init({ storage });
        for (const descriptor of pluginsRef) {
          if (cancelBootRef.current) return;
          try {
            await runtime.host.register(descriptor);
          } catch (error) {
            onErrorRef?.(error);
          }
        }
        // 启动时无已打开项目：切换屏障为空操作，失败只会是初始项目非法（抛错）
        if (!cancelBootRef.current && initialRef) await runtime.openProject(initialRef);
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
  const onCloseErrorRef = useRef(onCloseError);
  onCloseErrorRef.current = onCloseError;
  useEffect(() => {
    mountedRef.current += 1;
    return () => {
      mountedRef.current -= 1;
      setTimeout(() => {
        if (mountedRef.current === 0) {
          // 第三十轮严重 6：卸载走统一 close() 屏障 —— dispose 结果不得静默
          // 丢弃。释放失败时如实上报 onCloseError（宿主可等待 handle.close()
          // 这一可等待屏障，解决后重试），运行时保留未 teardown —— 未落盘内容
          // 仍可恢复，绝不「假装已卸载」丢弃内容；资源缓存随成功释放（恰好
          // 一次），宿主重试期间壳层仍完整可用。宿主确需放弃内容时先经
          // persistence.clearRecovery 显式丢弃后重试
          // 第三十五轮一般 5 + 第三十六轮一般 4：宿主 onCloseError 回调统一经
          // invokeCloseError 调用 —— 同步 throw 隔离、返回 thenable 的 rejection
          // 吸收（修复前只捕同步异常，async 回调的 Promise rejection 被丢弃、
          // 产生 unhandledrejection）
          void close().then(
            (outcome) => {
              if (!outcome.ok) invokeCloseError(onCloseErrorRef.current, outcome.message ?? '运行时释放失败');
            },
            (error) => {
              invokeCloseError(onCloseErrorRef.current, error instanceof Error ? error.message : String(error));
            },
          );
        }
      }, 0);
    };
  }, [runtime, cache, close]);

  useEffect(() => {
    if (!exportOpen) return;
    const root = rootRef.current;
    if (!root) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (
        !isKeyboardEventForStudio(root, event) ||
        !isExportIsolatedShortcut(event, recordingShortcutRef.current)
      ) return;
      if (!preservesNativeKeyboardSemantics(event)) event.preventDefault();
    };
    // Mark editor-only shortcuts before viewport listeners can consume drive keys.
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => window.removeEventListener('keydown', onKeyDownCapture, true);
  }, [exportOpen]);

  // 编辑器快捷键：撤销/重做/复制/删除/取消选择/Gizmo 模式。
  // 按实例作用域（R8-9）：多个 Studio 实例共存时共享 window 监听，
  // 无焦点包含校验则每个实例都执行全部快捷键（一个实例内按 Delete
  // 会删掉其他实例的选择）——按键须落在本实例子树内；页面只挂载一个
  // Studio 时（常见嵌入形态）放行实例外按键，点击画布后焦点在 body 的
  // 正常操作（Ctrl+K/Delete）仍生效
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const unregisterRoot = registerStudioKeyboardRoot(root);
    const onKey = (event: KeyboardEvent) => {
      if (!isKeyboardEventForStudio(root, event)) return;
      if (exportOpen && isExportIsolatedShortcut(event, recordingShortcutRef.current)) {
        if (preservesNativeKeyboardSemantics(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // 已由内层处理（对话框/下拉等 stopPropagation 的兜底）：全局键处理不得越权执行
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      // 命令面板开关先于输入守卫处理：面板打开时焦点在其搜索输入框内，Ctrl+K 仍需能关闭
      if ((event.ctrlKey || event.metaKey) && key === 'k') {
        event.preventDefault();
        setStoryboardOpen(false);
        setPaletteOpen((open) => {
          if (!open) rememberPaletteReturnFocus();
          return !open;
        });
        return;
      }
      if (preservesNativeKeyboardSemantics(event)) return;
      const editor = runtime.editor;
      if (matchesShortcut(event, recordingShortcutRef.current)) {
        event.preventDefault();
        if (event.repeat) return;
        const activeSession = sessionRef.current;
        if (activeSession.state.recording) {
          if (activeSession.state.recordingPaused) activeSession.resumeRecording();
          else activeSession.stopRecording();
          return;
        }
        const project = editor.getProject();
        const selection = editor.getSelection();
        const selected = project && selection.length === 1 ? findObject(project, selection[0]!) : null;
        if (selected?.type === 'camera') activeSession.startRecording(selected.id);
        else showToast('请先选择一个机位再开始录制', 'error');
        return;
      }
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
      if (event.key === ' ') {
        event.preventDefault();
        sessionRef.current.togglePlay();
        return;
      }
      if (event.key === '1') editor.setTransformMode('translate');
      else if (event.key === '2') editor.setTransformMode('rotate');
      else if (event.key === '3') editor.setTransformMode('scale');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unregisterRoot();
    };
  }, [runtime, exportOpen, rememberPaletteReturnFocus]);

  return (
    <>
      <div
        ref={rootRef}
        className={`lumora-studio${className ? ` ${className}` : ''}`}
        data-testid="lumora-studio"
        data-workspace={storyboardOpen ? 'storyboard' : exportOpen ? 'export' : undefined}
      >
        <Toolbar
          runtime={runtime}
          project={project}
          editorState={editorState}
          cache={cache}
          storyboardOpen={storyboardOpen}
          exportOpen={exportOpen}
          exportButtonRef={exportButtonRef}
          paletteButtonRef={paletteButtonRef}
          pluginButtonRef={pluginButtonRef}
          onToggleStoryboard={() => {
            setPluginManagerOpen(false);
            setPaletteOpen(false);
            setExportOpen(false);
            setStoryboardOpen((open) => !open);
          }}
          onToggleExport={() => {
            setPluginManagerOpen(false);
            setPaletteOpen(false);
            setStoryboardOpen(false);
            setExportOpen((open) => !open);
          }}
          onTogglePlugins={() => {
            setStoryboardOpen(false);
            setExportOpen(false);
            setPluginManagerOpen((open) => !open);
          }}
          onTogglePalette={() => {
            setStoryboardOpen(false);
            setExportOpen(false);
            setPaletteOpen((open) => {
              if (!open) rememberPaletteReturnFocus();
              return !open;
            });
          }}
        />
        <div className="lumora-studio__stage">
        <div
          className="lumora-studio__mobile-tabs"
          role="tablist"
          aria-label="编辑器面板"
          inert={storyboardOpen || exportOpen || undefined}
        >
          {([
            ['scene', '场景'],
            ['objects', '对象'],
            ['properties', '属性'],
          ] as const).map(([panel, label]) => (
            <button
              key={panel}
              type="button"
              role="tab"
              id={`editor-panel-tab-${panel}`}
              data-testid={`editor-panel-${panel}`}
              aria-controls={`editor-panel-content-${panel}`}
              aria-selected={editorPanel === panel}
              tabIndex={editorPanel === panel ? 0 : -1}
              disabled={panel !== 'scene' && !project}
              onClick={() => setEditorPanel(panel)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                const tabs = Array.from(
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]:not(:disabled)',
                  ) ?? [],
                );
                if (tabs.length === 0) return;
                event.preventDefault();
                event.stopPropagation();
                const current = tabs.indexOf(event.currentTarget);
                let next = 0;
                if (event.key === 'End') next = tabs.length - 1;
                else if (event.key === 'ArrowLeft') next = current <= 0 ? tabs.length - 1 : current - 1;
                else if (event.key === 'ArrowRight') next = current === tabs.length - 1 ? 0 : current + 1;
                const nextTab = tabs[next];
                const nextPanel = nextTab?.dataset.editorPanel as typeof editorPanel | undefined;
                if (!nextTab || !nextPanel) return;
                setEditorPanel(nextPanel);
                nextTab.focus();
              }}
              data-editor-panel={panel}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="lumora-studio__body"
          data-editor-panel={editorPanel}
          inert={storyboardOpen || exportOpen || undefined}
        >
          <div
            className="lumora-studio__sidebar"
            id="editor-panel-content-objects"
            role="tabpanel"
            aria-labelledby="editor-panel-tab-objects"
          >
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
          <main
            className="lumora-studio__viewport"
            id="editor-panel-content-scene"
            role="tabpanel"
            aria-labelledby="editor-panel-tab-scene"
          >
            <div className="lumora-studio__scene-slot">
              {scene ? (
                scene(project)
              ) : (
                <EditorViewport
                  editor={runtime.editor}
                  project={project}
                  selection={editorState.selection}
                  view={editorState.view}
                  cache={cache}
                  session={session}
                  captureRef={captureRef}
                  exportFrameRef={exportFrameRef}
                  onCaptureReady={handleCaptureReady}
                  onRenderContentChange={handleRenderContentChange}
                  keyboardScopeRef={rootRef}
                  driveEnabled={!exportOpen}
                  liveTransformStore={liveTransformStore}
                />
              )}
              {!project && (
                <div className="lumora-studio__empty" data-testid="studio-empty-hint">
                  尚未打开项目 —— 点击工具栏「打开示例项目」
                </div>
              )}
            </div>
            {project && !scene && (
              <TimelinePanel
                session={session}
                editor={runtime.editor}
                project={project}
                selection={editorState.selection}
                captureRef={captureRef}
                captureReady={captureReady}
                captureGeneration={captureGeneration}
                recordingShortcut={recordingShortcut}
                onRecordingShortcutChange={handleRecordingShortcutChange}
              />
            )}
          </main>
          <div
            className="lumora-studio__inspector-slot"
            id="editor-panel-content-properties"
            role="tabpanel"
            aria-labelledby="editor-panel-tab-properties"
          >
            <PropertiesPanel
              editor={runtime.editor}
              project={project}
              selection={editorState.selection}
              liveTransformStore={liveTransformStore}
            />
          </div>
        </div>
        {storyboardOpen && project && (
          <StoryboardWorkspace
            key={project.uri}
            runtime={runtime}
            project={project}
            onClose={() => setStoryboardOpen(false)}
          />
        )}
        {exportOpen && project && (
          <ExportWorkspace
            key={`${project.uri}:${runtime.editor.getSessionToken()}`}
            runtime={runtime}
            project={project}
            projectSessionToken={runtime.editor.getSessionToken()}
            session={session}
            captureRef={captureRef}
            exportFrameRef={exportFrameRef}
            captureReady={captureReady}
            onClose={() => {
              setExportOpen(false);
              queueMicrotask(() => exportButtonRef.current?.focus());
            }}
          />
        )}
        </div>
        <ToastHost />
        {pluginManagerOpen && (
          <PluginManager
            runtime={runtime}
            returnFocusRef={pluginButtonRef}
            onClose={() => setPluginManagerOpen(false)}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            runtime={runtime}
            returnFocusRef={paletteReturnFocusRef}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
      {session.state.overwritePending && (
        <ModalDialog
          backdropClassName="lumora-timeline__overlay"
          dialogClassName="lumora-timeline__modal"
          dialogTestId="overwrite-confirm"
          ariaLabelledBy={overwriteTitleId}
          closeOnBackdrop={false}
          onClose={session.cancelOverwrite}
        >
          <p id={overwriteTitleId}>该机位已有录制轨道，覆盖现有关键帧？</p>
          <div className="lumora-timeline__modal-actions">
            <button
              type="button"
              className="lumora-button lumora-button--danger"
              onClick={session.confirmOverwrite}
            >
              覆盖录制
            </button>
            <button type="button" className="lumora-button" onClick={session.cancelOverwrite}>
              取消
            </button>
          </div>
        </ModalDialog>
      )}
    </>
  );
});
