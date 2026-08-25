import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { PluginDescriptor, Project } from '@lumora/core';
import { createStudioRuntime } from '../runtime/studio-runtime';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { useSceneEditor } from '../hooks/use-scene-editor';
import { useTimelineSession } from '../hooks/use-timeline-session';
import type { StorageBackend } from '../persistence/project-storage';
import { PanelHost } from './panels/PanelHost';
import { Toolbar } from './Toolbar';
import { CommandPalette } from './CommandPalette';
import { PluginManager } from './PluginManager';
import { EditorViewport } from './editor/EditorViewport';
import { TimelinePanel } from './editor/TimelinePanel';
import { ObjectTree } from './editor/ObjectTree';
import { PropertiesPanel } from './editor/PropertiesPanel';
import { ToastHost, showToast } from './editor/toasts';
import { ContentCache } from './editor/content-cache';
import { DRIVE_KEY_CODES } from './editor/camera-drive';
import { isKeyboardEventForStudio, registerStudioKeyboardRoot } from './studio-keyboard-scope';
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
  { plugins = [], hostVersion, initialProject, onError, onCloseError, scene, storage, className },
  ref,
) {
  const runtimeRef = useRef<StudioRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createStudioRuntime({ hostVersion, onError });
  }
  const runtime = runtimeRef.current;
  const editorState = useSceneEditor(runtime.editor);
  const { project } = editorState;
  // 统一时间引擎会话（TML-52）：播放/录制/驾驶的时间权威
  const session = useTimelineSession(runtime.editor);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // 覆盖确认模态（复审阻断 4）：提升到壳层根级，打开时整壳 inert（工具栏/对象树/
  // 视口/时间线整体不可达），模态经 portal 挂到 body 脱离 inert 子树
  const overwriteModalRef = useRef<HTMLDivElement>(null);
  const overwriteTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!session.state.overwritePending) return;
    const dialog = overwriteModalRef.current;
    if (!dialog) return;
    overwriteTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusables()[0]?.focus();
    // 捕获阶段处理先于全局冒泡处理器，stopImmediatePropagation 使其不可达。
    // 应用快捷键统一小写匹配：Ctrl+Shift+K 的 key 为大写 K，未小写化时泄漏到
    // 命令面板开关（复审阻断 4）
    const isAppShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      return (
        key === 'delete' ||
        key === 'backspace' ||
        key === '1' ||
        key === '2' ||
        key === '3' ||
        ((event.ctrlKey || event.metaKey) &&
          (key === 'k' || key === 'z' || key === 'y' || key === 'd')) ||
        DRIVE_KEY_CODES.has(event.code)
      );
    };
    const onKeyDownCapture = (event: KeyboardEvent) => {
      // Escape 无条件取消，先于「模态外」分支判定：焦点逃逸到对话框外后
      // Escape 不得被 outside 分支吞掉（复审阻断 4）
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        session.cancelOverwrite();
        return;
      }
      const inside = event.target instanceof Node && dialog.contains(event.target);
      if (!inside) {
        // 模态外（含 window/document 上的按键）：一律拦截，不再穿透到全局处理器；
        // 焦点若已逃逸到对话框外（程序性 blur 等），Tab 把它拉回首项（焦点陷阱闭环）
        if (event.key === 'Tab') {
          focusables()[0]?.focus();
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (!dialog.contains(document.activeElement)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          event.stopImmediatePropagation();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          event.stopImmediatePropagation();
          first.focus();
        }
        return;
      }
      if (isAppShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === ' ') {
        // 对话框按钮的空格激活走原生行为，只阻断冒泡到全局播放切换
        event.stopImmediatePropagation();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
      const trigger = overwriteTriggerRef.current;
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, [session.state.overwritePending, session]);
  // 分镜缩略图截图通道：EditorViewport 的 FrameCaptureBridge 挂载后可用
  const captureRef = useRef<((cameraObjectId?: string | null) => string | null) | null>(null);
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

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    closeInFlightRef.current = (async (): Promise<{ ok: boolean; message?: string }> => {
      let outcome: { ok: boolean; message?: string };
      try {
        outcome = await runtime.dispose();
      } catch (error) {
        outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
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
    })();
    const inFlight = closeInFlightRef.current;
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
      // 已由内层处理（对话框/下拉等 stopPropagation 的兜底）：全局键处理不得越权执行
      if (event.defaultPrevented) return;
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
  }, [runtime]);

  return (
    <>
      <div
        ref={rootRef}
        className={`lumora-studio${className ? ` ${className}` : ''}`}
        data-testid="lumora-studio"
        // 覆盖确认模态打开时整壳 inert：工具栏/对象树/视口/时间线整体不可达
        // （复审阻断 4：仅时间线内容 inert 时其余应用仍可交互）
        inert={session.state.overwritePending || undefined}
      >
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
                  onCaptureReady={handleCaptureReady}
                  onRenderContentChange={handleRenderContentChange}
                  keyboardScopeRef={rootRef}
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
              />
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
      {session.state.overwritePending &&
        createPortal(
          <div
            className="lumora-studio lumora-studio--portal lumora-timeline__overlay"
            data-testid="overwrite-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="overwrite-confirm-title"
          >
            <div className="lumora-timeline__modal" ref={overwriteModalRef} tabIndex={-1}>
              <p id="overwrite-confirm-title">该机位已有录制轨道，覆盖现有关键帧？</p>
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
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});
