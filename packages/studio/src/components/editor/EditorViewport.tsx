import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { findObject, fitRect, getReachableIds } from '@lumora/core';
import type { Project, SceneEditor, TransformData, ViewState } from '@lumora/core';
import { resolveFormat } from './content-cache';
import type { CacheLease, ContentCache } from './content-cache';
import { collectModelObjectIds } from './model-content';
import {
  applyTransform,
  attachModelContent,
  buildScene,
  disposeNode,
  findNode,
  resolveOwnedIdAboveContent,
  syncScene,
} from './scene-builder';
import { showToast } from './toasts';
import { CameraDrive, captureCameraSample, DRIVE_KEY_CODES, restoreObjectOnNode } from './camera-drive';
import { PlaybackDriver } from './PlaybackDriver';
import { captureProjectFrame, renderProjectFrameToCanvas } from './frame-capture';
import type { ProjectFrameCapture } from './frame-capture';
import type { TimelineSession } from '../../hooks/use-timeline-session';
import {
  isKeyboardEventForStudio,
  preservesNativeKeyboardSemantics,
} from '../studio-keyboard-scope';
import type { LiveTransformStore } from './live-transform-store';

interface EditorViewportProps {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
  view: ViewState;
  cache: ContentCache;
  /** 时间线会话：提供后启用回放驱动与键鼠机位驾驶（TML-52） */
  session?: TimelineSession | null;
  /** 帧截图通道：FrameCaptureBridge 在 Canvas 内注册（分镜缩略图用）；
   *  可选参数 = 分镜绑定机位 id，传参时按该机位渲染 */
  captureRef?: React.RefObject<((cameraObjectId?: string | null) => string | null) | null>;
  /** Exact-size export frame channel used by the WebM/PNG export workspace. */
  exportFrameRef?: React.RefObject<ProjectFrameCapture | null>;
  /** 截图通道就绪通知（FrameCaptureBridge 挂载/卸载时回调；缩略图链据此
   *  启动，复审阻断 2） */
  onCaptureReady?: (ready: boolean) => void;
  /** Scene tree or deferred model content changed and cached frames are stale. */
  onRenderContentChange?: () => void;
  /** Owning Studio root used to isolate window-level camera-drive keys. */
  keyboardScopeRef?: React.RefObject<HTMLElement | null>;
  /** Whether keyboard camera drive input is currently available. */
  driveEnabled?: boolean;
  /** Selected live THREE-node transform exposed through the visible inspector. */
  liveTransformStore?: LiveTransformStore;
}

/** 沿父链找到最近的对象 id（GLB 内容网格挂在模型组下，需要向上追溯）。
 *  内容边界统一解析（R11-2）：完整走父链，遇 CONTENT_MARK 丢弃其下全部
 *  候选（内容后代反射伪造品牌也不劫持拾取），只返回边界上方品牌节点 */
export function findObjectId(object: THREE.Object3D): string | null {
  return resolveOwnedIdAboveContent(object);
}

/**
 * 3D 视口：
 * - 场景树由项目数据增量同步（scene-builder），模型内容经 ContentCache lease 挂载
 * - Gizmo 拖动 = beginTransform/commitTransform 一步历史；局部/世界空间可切换
 * - 导演视图全容器拾取；相机视图 letterbox 到项目画幅（gl viewport/scissor
 *   传 CSS 像素，three 内部按 pixelRatio 换算），三分线/安全框以 DOM 覆盖层
 *   绘制在相同矩形上 —— 辅助线永不进入 canvas
 */
export function EditorViewport({
  editor,
  project,
  selection,
  view,
  cache,
  session = null,
  captureRef: captureRefProp,
  exportFrameRef: exportFrameRefProp,
  onCaptureReady,
  onRenderContentChange,
  keyboardScopeRef,
  driveEnabled = true,
  liveTransformStore,
}: EditorViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const [dragging, setDragging] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  // 同步引用：Gizmo 的原生 pointerdown 监听先于容器 React 处理器执行，
  // 用 ref 而非异步的 state 判断「拖动已在 Gizmo 上开始」，避免拾取改选/清选
  const draggingRef = useRef(false);
  // 回放驱动跳过集：gizmo 拖拽中的对象不被轨道求值覆盖
  const skipIdsRef = useRef<Set<string> | null>(null);
  // 分镜缩略图截图通道（FrameCaptureBridge 在 Canvas 内挂载后可用）
  const localCaptureRef = useRef<((cameraObjectId?: string | null) => string | null) | null>(null);
  const captureRef = captureRefProp ?? localCaptureRef;
  const localExportFrameRef = useRef<ProjectFrameCapture | null>(null);
  const exportFrameRef = exportFrameRefProp ?? localExportFrameRef;

  // 驾驶目标：单选机位；已有轨道机位在暂停态不驾驶（时间线接管），录制中始终可驾驶
  const drivenCameraId = useMemo(() => {
    if (!project || selection.length !== 1) return null;
    const object = findObject(project, selection[0]!);
    return object && object.type === 'camera' ? object.id : null;
  }, [project, selection]);

  useCameraDrive(session, drivenCameraId, rootRef, editor, keyboardScopeRef, driveEnabled);

  // 录制采样源：视口把机位节点映射为通道样本（录制期间节点由驾驶/静止接管）
  useEffect(() => {
    if (!session) return;
    session.setCaptureSource((cameraId) => {
      const root = rootRef.current;
      if (!root) return null;
      const node = findNode(root, cameraId);
      if (!node) return null;
      return captureCameraSample(node);
    });
    return () => session.setCaptureSource(null);
  }, [session]);

  const aspect = project ? project.settings.aspect[0] / project.settings.aspect[1] : 16 / 9;
  // 相机视图按活动场景隔离：仅当机位对象存在且属于活动场景可达集时生效
  const reachableIds = useMemo(
    () => (project ? getReachableIds(project, project.activeSceneId) : null),
    [project],
  );
  const cameraView =
    view.viewMode !== 'director' && project && reachableIds
      ? findObject(project, view.viewMode.cameraObjectId)?.type === 'camera' &&
        reachableIds.has(view.viewMode.cameraObjectId)
        ? view.viewMode.cameraObjectId
        : null
      : null;

  // 机位失效（删除、撤销、切场景后不属于活动场景）→ 回退导演视图
  useEffect(() => {
    if (!project || view.viewMode === 'director') return;
    const cameraId = view.viewMode.cameraObjectId;
    const camera = findObject(project, cameraId);
    if (!camera || camera.type !== 'camera' || !reachableIds?.has(cameraId)) {
      editor.setViewMode('director');
    }
  }, [project, view.viewMode, reachableIds, editor]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const updateDragging = (value: boolean) => {
    draggingRef.current = value;
    setDragging(value);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target;
    const interactiveTarget =
      pointerTarget instanceof HTMLElement &&
      pointerTarget.closest('button, input, select, textarea, [contenteditable="true"]');
    if (!interactiveTarget) event.currentTarget.focus({ preventScroll: true });
    if (event.button !== 0 || !project || draggingRef.current) return;
    const root = rootRef.current;
    const camera = cameraRef.current;
    const el = containerRef.current;
    if (!root || !camera || !el) return;
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // 相机视图按画幅矩形映射（letterbox 黑边点击 = 取消选择）；
    // 导演视图使用全容器映射，无黑边区域
    const fit = cameraView
      ? fitRect(rect.width, rect.height, aspect)
      : { x: 0, y: 0, width: rect.width, height: rect.height };
    const inBars = x < fit.x || x >= fit.x + fit.width || y < fit.y || y >= fit.y + fit.height;
    if (inBars) {
      if (!event.ctrlKey && !event.metaKey) editor.clearSelection();
      return;
    }
    const ndc = new THREE.Vector2(((x - fit.x) / fit.width) * 2 - 1, -(((y - fit.y) / fit.height) * 2 - 1));
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(root, true).find((h) => findObjectId(h.object));
    if (hit) {
      const objectId = findObjectId(hit.object)!;
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(editor.getSelection());
        if (next.has(objectId)) next.delete(objectId);
        else next.add(objectId);
        editor.setSelection([...next]);
      } else {
        editor.setSelection([objectId]);
      }
    } else if (!event.ctrlKey && !event.metaKey) {
      editor.clearSelection();
    }
  };

  return (
    <div
      ref={containerRef}
      className="lumora-scene lumora-viewport"
      data-testid="lumora-viewport"
      tabIndex={-1}
      onPointerDown={handlePointerDown}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [7, 5, 7], fov: 45 }}
        onCreated={() => undefined}
      >
        <color attach="background" args={['#14161f']} />
        <ambientLight intensity={0.35} />
        <gridHelper args={[20, 20, '#3a3f52', '#2a2e3d']} />
        <SceneContent
          editor={editor}
          rootRef={rootRef}
          project={project}
          cache={cache}
          onRenderContentChange={onRenderContentChange}
        />
        {cameraView && project && (
          <CameraRig rootRef={rootRef} cameraObjectId={cameraView} aspect={aspect} project={project} />
        )}
        <ViewportLetterbox enabled={!!cameraView && !!project} aspect={aspect} />
        <EditorGizmo
          editor={editor}
          project={project}
          selection={selection}
          view={view}
          rootRef={rootRef}
          dragging={dragging}
          setDragging={updateDragging}
          playbackActive={!!session && session.state.playing}
          skipIdsRef={skipIdsRef}
        />
        {!cameraView && <OrbitControls makeDefault enableDamping enabled={!dragging} />}
        <CameraProxy cameraRef={cameraRef} />
        <FrameCaptureBridge
          captureRef={captureRef}
          exportFrameRef={exportFrameRef}
          onCaptureReady={onCaptureReady}
          rootRef={rootRef}
          aspect={aspect}
        />
        {liveTransformStore && (
          <LiveTransformBridge
            objectId={drivenCameraId}
            rootRef={rootRef}
            store={liveTransformStore}
          />
        )}
      </Canvas>
      {session && (
        <>
          <PlaybackDriver session={session} editor={editor} rootRef={rootRef} skipIdsRef={skipIdsRef} />
          {/* 数值位姿读取钩子仅供 e2e 数值断言（复审一般 7）：dev 服务（e2e 即
              dev server）挂载，生产构建 tree-shake —— 60Hz JSON stringify 不进
              生产树 */}
          {import.meta.env.DEV && <CameraPoseReadout session={session} editor={editor} rootRef={rootRef} />}
        </>
      )}
      {cameraView && containerSize && project && (
        <GuidesOverlay rect={fitRect(containerSize.width, containerSize.height, aspect)} view={view} />
      )}
      <ViewportToolbar editor={editor} project={project} view={view} />
    </div>
  );
}

function LiveTransformBridge({
  objectId,
  rootRef,
  store,
}: {
  objectId: string | null;
  rootRef: React.RefObject<THREE.Group | null>;
  store: LiveTransformStore;
}) {
  useEffect(() => {
    if (!objectId) store.clear();
    return () => {
      if (objectId) store.clear(objectId);
    };
  }, [objectId, store]);
  useFrame(() => {
    if (!objectId) return;
    const root = rootRef.current;
    const node = root ? findNode(root, objectId) : null;
    if (!node) {
      store.clear(objectId);
      return;
    }
    store.publish(objectId, [node.position.x, node.position.y, node.position.z]);
  });
  return null;
}

/**
 * 键鼠机位驾驶（TML-52）：选中机位且非播放态时启用（录制中强制可驾驶），
 * rAF 每帧把按键意图积分到节点。脱离驾驶（取消选中/开始回放/录制暂停）时
 * 还原静态位姿 —— 回放中与录制采样中除外（分别由回放驱动与录制接管）；
 * 绑定机位已有启用轨道时也跳过还原（轨道求值已接管节点，见 restoreIfNeeded）。
 * window blur → 硬停（速度立即归零，无失控位移）。
 * 会话对象稳定（useTimelineSession 内部 useRef 持有），本 effect 录制期间
 * 不重建 —— 按键输入不再被每帧 drive.stop() 清空（TML-52 审查第 1 项）。
 */
function useCameraDrive(
  session: TimelineSession | null,
  drivenCameraId: string | null,
  rootRef: React.RefObject<THREE.Group | null>,
  editor: SceneEditor,
  keyboardScopeRef?: React.RefObject<HTMLElement | null>,
  driveEnabled = true,
) {
  const cameraIdRef = useRef<string | null>(null);
  cameraIdRef.current = drivenCameraId;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const driveEnabledRef = useRef(driveEnabled);
  driveEnabledRef.current = driveEnabled;

  useEffect(() => {
    if (!session) return;
    const drive = new CameraDrive();
    let raf = 0;
    let last = performance.now();
    let attachedId: string | null = null;
    let attachedNode: THREE.Object3D | null = null;
    const heldKeys = new Set<string>();

    const clearDrive = () => {
      heldKeys.clear();
      drive.stop();
      attachedId = null;
      attachedNode = null;
    };

    const attachCurrentCamera = (): boolean => {
      const cameraId = cameraIdRef.current;
      const root = rootRef.current;
      const node = root && cameraId ? findNode(root, cameraId) : null;
      if (!cameraId || !node) return false;
      if (attachedId !== cameraId || attachedNode !== node) {
        drive.attach(node);
        attachedId = cameraId;
        attachedNode = node;
        for (const code of heldKeys) drive.press(code);
      }
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !driveEnabledRef.current) return;
      const keyboardRoot = keyboardScopeRef?.current;
      if (keyboardRoot && !isKeyboardEventForStudio(keyboardRoot, event)) return;
      if (preservesNativeKeyboardSemantics(event)) return;
      if (DRIVE_KEY_CODES.has(event.code)) {
        if (cameraIdRef.current) event.preventDefault();
        heldKeys.add(event.code);
        if (attachCurrentCamera()) drive.press(event.code);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (heldKeys.delete(event.code)) {
        drive.release(event.code);
        return;
      }
      if (event.defaultPrevented) return;
      const keyboardRoot = keyboardScopeRef?.current;
      if (keyboardRoot && !isKeyboardEventForStudio(keyboardRoot, event)) return;
      drive.release(event.code);
    };
    const onFocusIn = (event: FocusEvent) => {
      const keyboardRoot = keyboardScopeRef?.current;
      if (keyboardRoot && !isKeyboardEventForStudio(keyboardRoot, event)) {
        clearDrive();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      const keyboardRoot = keyboardScopeRef?.current;
      const target = event.target;
      if (!keyboardRoot || !(target instanceof Node) || !keyboardRoot.contains(target)) return;
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && keyboardRoot.contains(nextTarget)) return;
      clearDrive();
    };
    const onBlur = () => clearDrive();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    const restoreIfNeeded = () => {
      if (attachedId === null || !attachedNode) return;
      const st = sessionRef.current?.state;
      // 回放中/录制中不还原（分别由回放驱动与录制接管）；覆盖确认冻结
      // 弹窗打开瞬间的姿态，只清输入/动量，不跳回项目静态位姿。
      if (st && (st.playing || st.recording || st.overwritePending)) return;
      const project = editor.getProject();
      // 绑定机位已有启用轨道：节点由轨道求值接管（回放驱动最后一次 apply
      // 已把播放头时刻的值写到节点），还原静态位姿会让画面与播放头脱节
      if (
        project?.tracks.some(
          (t) => t.objectId === attachedId && t.keyframes.length > 0 && !t.disabled,
        )
      ) {
        return;
      }
      const object = project?.objects.find((o) => o.id === attachedId);
      if (object) restoreObjectOnNode(attachedNode, object);
    };

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!driveEnabledRef.current) {
        clearDrive();
        raf = requestAnimationFrame(loop);
        return;
      }
      const st = sessionRef.current?.state;
      const cameraId = cameraIdRef.current;
      // 可驾驶：选中机位 && 录制未暂停 && （暂停 || 录制中）&& 无启用轨道（录制中无视轨道；
      // 禁用轨道不阻止驾驶 —— 禁用 = 该通道暂不参与回放）
      const hasTracks =
        !!st &&
        !!editor.getProject()?.tracks.some(
          (t) => t.objectId === cameraId && t.keyframes.length > 0 && !t.disabled,
        );
      const canDrive =
        !!st &&
        cameraId !== null &&
        !st.overwritePending &&
        !st.recordingPaused &&
        (!st.playing || st.recording) &&
        (!hasTracks || st.recording);
      if (!canDrive) {
        if (attachedId !== null) {
          restoreIfNeeded();
          drive.detach();
          attachedId = null;
          attachedNode = null;
        }
        raf = requestAnimationFrame(loop);
        return;
      }
      if (!attachCurrentCamera()) {
        raf = requestAnimationFrame(loop);
        return;
      }
      drive.update(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      restoreIfNeeded();
      clearDrive();
    };
  }, [session, rootRef, editor, keyboardScopeRef]);
}

/** 把当前渲染相机镜像给外层（点击拾取用） */
function CameraProxy({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);
  return null;
}

/**
 * 数值位姿读取钩子（e2e AC1/AC3 数值断言）：把各相机节点当前的 position /
 * rotation / focalLength 序列化进隐藏 span 的 textContent。开发环境逐帧刷新，
 * 让浏览器测试也能观察连续驾驶；不使用 React 状态，因此不会触发重渲染。
 * 事件订阅注册在 PlaybackDriver 之后，同一次事件里读到已应用轨道求值的位姿。
 */
function CameraPoseReadout({
  session,
  editor,
  rootRef,
}: {
  session: TimelineSession;
  editor: SceneEditor;
  rootRef: React.RefObject<THREE.Group | null>;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const refresh = () => {
      const root = rootRef.current;
      const project = editor.getProject();
      if (!root || !project) return;
      const poses: Record<string, unknown> = {};
      for (const object of project.objects) {
        if (object.type !== 'camera') continue;
        const node = findNode(root, object.id);
        if (!node) continue;
        const focal = (node.userData as Record<string, unknown>).focalLength;
        poses[object.id] = {
          position: [node.position.x, node.position.y, node.position.z],
          rotation: [node.rotation.x, node.rotation.y, node.rotation.z],
          focalLength: typeof focal === 'number' && Number.isFinite(focal) ? focal : null,
        };
      }
      host.textContent = JSON.stringify(poses);
    };
    const subs = [
      session.timeline.events.on('time:changed', refresh),
      session.timeline.events.on('state:changed', refresh),
      editor.events.on('project:changed', refresh),
    ];
    refresh();
    let animationFrame = 0;
    const refreshEachFrame = () => {
      refresh();
      animationFrame = requestAnimationFrame(refreshEachFrame);
    };
    animationFrame = requestAnimationFrame(refreshEachFrame);
    return () => {
      cancelAnimationFrame(animationFrame);
      for (const sub of subs) sub.dispose();
    };
  }, [session, editor, rootRef]);
  return <span ref={hostRef} data-testid="camera-pose-readout" aria-hidden="true" style={{ display: 'none' }} />;
}

/**
 * 帧截图桥（分镜缩略图）：把「立即截一帧 PNG dataURL」注册给外层。测试 mock 的
 * gl 没有 render/toDataURL，typeof guard 后返回 null（缩略图占位）。
 */
function FrameCaptureBridge({
  captureRef,
  exportFrameRef,
  onCaptureReady,
  rootRef,
  aspect,
}: {
  captureRef: React.RefObject<((cameraObjectId?: string | null) => string | null) | null>;
  exportFrameRef: React.RefObject<ProjectFrameCapture | null>;
  /** 通道就绪通知：挂载置 true、卸载置 false。仅写 ref 不触发 React 渲染，
   *  缩略图链依赖该回调启动（复审阻断 2） */
  onCaptureReady?: (ready: boolean) => void;
  /** 场景根：分镜机位截图时经 findNode 解析绑定相机节点 */
  rootRef: React.RefObject<THREE.Group | null>;
  /** 项目画幅比例：机位截图前同步 aspect（与 CameraRig 同源模式） */
  aspect: number;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const resolveCamera = (cameraObjectId?: string | null): THREE.Camera | null => {
      if (!cameraObjectId) return camera;
      const node = rootRef.current ? findNode(rootRef.current, cameraObjectId) : null;
      return node instanceof THREE.PerspectiveCamera ? node : null;
    };
    captureRef.current = (cameraObjectId?: string | null) => {
      if (typeof gl.render !== 'function') return null;
      try {
        // 分镜机位截图：解析绑定相机并按项目画幅校正投影；绑定缺失时返回 null
        // 让缩略图保持占位，而不是用当前相机渲染出错误画面（复审阻断 2）
        const viewCamera = resolveCamera(cameraObjectId);
        if (!viewCamera) return null;
        return captureProjectFrame(gl, scene, viewCamera, aspect);
      } catch {
        return null;
      }
    };
    exportFrameRef.current = (cameraObjectId, canvas, options) => {
      if (typeof gl.render !== 'function') return false;
      try {
        const viewCamera = resolveCamera(cameraObjectId);
        if (!viewCamera) return false;
        return renderProjectFrameToCanvas(gl, scene, viewCamera, canvas, {
          ...options,
          excludeEditorHelpers: true,
        });
      } catch {
        return false;
      }
    };
    onCaptureReady?.(true);
    return () => {
      captureRef.current = null;
      exportFrameRef.current = null;
      onCaptureReady?.(false);
    };
  }, [gl, scene, camera, captureRef, exportFrameRef, onCaptureReady, rootRef, aspect]);
  return null;
}

function SceneContent({
  editor,
  rootRef,
  project,
  cache,
  onRenderContentChange,
}: {
  editor: SceneEditor;
  rootRef: React.MutableRefObject<THREE.Group | null>;
  project: Project | null;
  cache: ContentCache;
  onRenderContentChange?: () => void;
}) {
  const scene = useThree((s) => s.scene);
  const prevProjectRef = useRef<Project | null>(null);
  // 会话代：openProject/reset 自增会话令牌；令牌变化 = 新项目会话，强制全量重建，
  // 否则复用 ID 的项目切换会把旧类型/旧资源节点保留下来（R8-4）
  const sessionRef = useRef(editor.getSessionToken());
  // 内容挂载代：身份分叉重建的模型（rebuiltModelIds）需要重新挂载内容（R9-M2）
  const [contentVersion, setContentVersion] = useState(0);

  useEffect(() => {
    const current = rootRef.current;
    if (!project) {
      if (current) {
        scene.remove(current);
        disposeNode(current);
        rootRef.current = null;
      }
      prevProjectRef.current = null;
      sessionRef.current = editor.getSessionToken();
      return;
    }
    const aspect = project.settings.aspect[0] / project.settings.aspect[1];
    const session = editor.getSessionToken();
    const sceneSwitched = prevProjectRef.current && prevProjectRef.current.activeSceneId !== project.activeSceneId;
    const newSession = session !== sessionRef.current;
    if (current && prevProjectRef.current && !sceneSwitched && !newSession) {
      const { rebuiltModelIds, structuralChange } = syncScene(current, prevProjectRef.current, project, aspect);
      if (structuralChange || rebuiltModelIds.length > 0) {
        setContentVersion((v) => v + 1);
        onRenderContentChange?.();
      }
    } else {
      // 切场景/新会话（或重建）：旧树节点整体释放，避免跨场景残留 GPU 资源
      if (current) {
        scene.remove(current);
        disposeNode(current);
      }
      const root = buildScene(project, aspect);
      rootRef.current = root;
      scene.add(root);
      sessionRef.current = session;
      setContentVersion((v) => v + 1);
      onRenderContentChange?.();
    }
    prevProjectRef.current = project;
  }, [project, scene, rootRef, editor, onRenderContentChange]);

  // 模型内容挂载：渲染消费者在使用期持有 lease（禁止裸资源旁路）——
  // 按「活动场景内 hash → 全部模型对象 id」映射，统一「先 retain，失败再 seed」：
  // 条目存活（含 loading）一律复用；仅缺失/判死刑时才从持久化载荷重建（seed）。
  // 内容就绪后把克隆挂到引用该 hash 的每个节点（Ctrl+D 复制/多对象共享同一资源）。
  // 异步回调在触碰资源前校验 lease 未释放且效应未重建（卸载/项目切换/缓存释放后
  // 一律不得再挂载）。项目变更/卸载时释放全部 lease，由缓存按引用关系 + lease
  // 计数决定清理。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !project) return;
    const leases: CacheLease[] = [];
    let active = true;
    for (const [hash, objectIds] of collectModelObjectIds(project)) {
      const object = project.objects.find((o) => o.id === objectIds[0]!);
      const asset = object ? project.assets.find((a) => a.id === object.assetId) : undefined;
      if (!asset) continue;
      let lease: CacheLease | null = cache.retain(hash);
      if (!lease && asset.payload) {
        try {
          lease = cache.seed(hash, asset.payload, {
            format: asset.format ?? resolveFormat(asset.name, asset.mime),
            parts: asset.parts ?? [],
          });
        } catch {
          // 缓存已释放（卸载竞态）：渲染消费者随之卸载，无需再挂内容
          lease = null;
        }
      }
      if (!lease) continue;
      leases.push(lease);
      void lease.content.then(
        (gltf) => {
          // 失效守卫：lease 已释放（cleanup/缓存 dispose 撤销）或效应已重建后不再挂载
          if (!active || lease.isReleased) return;
          let attached = false;
          for (const objectId of objectIds) {
            const node = findNode(root, objectId);
            if (node) {
              attachModelContent(node, gltf);
              attached = true;
            }
          }
          if (attached) onRenderContentChange?.();
        },
        () => undefined,
      );
    }
    return () => {
      active = false;
      for (const lease of leases) lease.release();
    };
    // contentVersion：身份分叉重建的模型（rebuiltModelIds）需要重新挂载内容；
    // attachModelContent 幂等（已有内容子树直接返回），全量重跑安全
  }, [project, cache, rootRef, contentVersion, onRenderContentChange]);

  // 项目变更后按 Project 全量 model→asset 关系清扫缓存（null=关闭项目，全部释放）
  useEffect(() => {
    cache.sweep(project);
  }, [project, cache]);

  return null;
}

/** 相机视图：把活动机位节点设为渲染相机并维持项目画幅 */
function CameraRig({
  rootRef,
  cameraObjectId,
  aspect,
  project,
}: {
  rootRef: React.MutableRefObject<THREE.Group | null>;
  cameraObjectId: string;
  aspect: number;
  project: Project;
}) {
  const set = useThree((s) => s.set);
  const camera = useThree((s) => s.camera);
  // 挂载首帧保存导演相机引用：此后机位视图内的重渲染（画幅/项目变化）里
  // state.camera 已是镜头相机，ref 守住首次值不被覆盖，卸载恢复才不会
  // 把镜头相机误当导演相机装回去。useThree 必须无条件调用（Rules of
  // Hooks），只把首次订阅到的相机写进 ref
  const restoreRef = useRef<RootState['camera'] | null>(null);
  if (!restoreRef.current) restoreRef.current = camera;

  useEffect(() => {
    const root = rootRef.current;
    const node = root ? findNode(root, cameraObjectId) : null;
    if (!node || !(node instanceof THREE.PerspectiveCamera)) return;
    node.aspect = aspect;
    node.updateProjectionMatrix();
    set({ camera: node });
    return () => {
      if (restoreRef.current) set({ camera: restoreRef.current });
    };
  }, [cameraObjectId, aspect, project, set, rootRef]);

  return null;
}

/**
 * letterbox：相机视图把渲染区域收窄到项目画幅，其余区域留黑（辅助线是 DOM，不在 canvas 内）。
 * 开启 scissor 后渲染器的 auto-clear 只清画幅矩形，黑边区域会残留上一帧内容，
 * 因此每次先关闭 scissor 全画布清黑、再画画幅矩形（DPR 1/2 下黑边均为纯黑）。
 */
function ViewportLetterbox({ enabled, aspect }: { enabled: boolean; aspect: number }) {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  useFrame(() => {
    // three 的 setViewport/setScissor 内部按 pixelRatio 换算，这里传 CSS 像素
    const { width, height } = size;
    if (!enabled) {
      gl.setScissorTest(false);
      gl.setViewport(0, 0, width, height);
      gl.setClearColor('#14161f', 1);
      return;
    }
    gl.setScissorTest(false);
    gl.setViewport(0, 0, width, height);
    gl.setClearColor('#000000', 1);
    gl.clear();
    const rect = fitRect(width, height, aspect);
    // WebGL 视口原点在左下，fitRect 返回左上坐标
    const y = height - (rect.y + rect.height);
    gl.setViewport(rect.x, y, rect.width, rect.height);
    gl.setScissor(rect.x, y, rect.width, rect.height);
    gl.setScissorTest(true);
    gl.setClearColor('#14161f', 1);
  });

  return null;
}

/** Gizmo：绑定单个未锁定选中对象；一次拖动 = 一步历史（AC3） */
function EditorGizmo({
  editor,
  project,
  selection,
  view,
  rootRef,
  dragging,
  setDragging,
  playbackActive,
  skipIdsRef,
}: {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
  view: ViewState;
  rootRef: React.MutableRefObject<THREE.Group | null>;
  dragging: boolean;
  setDragging: (value: boolean) => void;
  /** 回放/录制中禁用 Gizmo（时间线与驾驶接管节点） */
  playbackActive: boolean;
  /** 拖拽期间登记对象 id，回放驱动跳过该节点 */
  skipIdsRef: React.RefObject<Set<string> | null>;
}) {
  const root = rootRef.current;
  const target = selection.length === 1 && project && root ? findNode(root, selection[0]) : null;
  const data = target ? findObject(project!, target.userData.objectId as string) : undefined;
  const locked = !!data?.locked;
  // 场景同步（SceneContent 的 useEffect）在渲染后执行，且只重渲染 SceneContent
  // 子树——本组件首次渲染时选中节点可能尚未挂入场景。命中「选中但节点缺失」
  // 时补一次重渲染，待同步提交后确定性挂载 gizmo，不再依赖无关状态更新竞速
  const [, bumpRender] = useState(0);
  useEffect(() => {
    if (!target && selection.length === 1 && project) bumpRender((v) => v + 1);
  }, [target, selection, project]);
  /** 正常提交路径标记：commit 先置位再收尾 dragging，cleanup 据此区分中断回滚 */
  const committedRef = useRef(false);

  // 拖拽期间登记 skip 集：回放驱动不覆盖被 Gizmo 握住的节点
  useEffect(() => {
    if (!target || !dragging) return;
    const objectId = target.userData.objectId as string;
    skipIdsRef.current = new Set([objectId]);
    return () => {
      skipIdsRef.current = null;
    };
  }, [dragging, target, skipIdsRef]);

  // 拖动期间的全部中断路径（Hook 必须先于条件返回调用，保证 Hook 顺序稳定）：
  // Escape / window blur / pointercancel / 组件卸载（Delete 删除、Escape 清选、切对象）。
  // 中断统一回滚节点到拖动前变换并清理拖动态，不产生历史。
  useEffect(() => {
    if (!target || !dragging) return;
    committedRef.current = false;
    const initial: TransformData = {
      position: [target.position.x, target.position.y, target.position.z],
      rotation: [target.rotation.x, target.rotation.y, target.rotation.z],
      scale: [target.scale.x, target.scale.y, target.scale.z],
    };
    const rollback = () => {
      applyTransform(target, initial);
      setDragging(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') rollback();
    };
    const onBlur = () => rollback();
    // pointercancel 只在指针流被中断时触发（捕获丢失/元素被移除），任何指针类型都应回滚
    const onPointerCancel = () => rollback();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (!committedRef.current) rollback();
    };
  }, [dragging, target, setDragging]);

  if (!target || locked || !project || playbackActive) return null;

  const commit = () => {
    const objectId = target.userData.objectId as string;
    const transform: TransformData = {
      position: [target.position.x, target.position.y, target.position.z],
      rotation: [target.rotation.x, target.rotation.y, target.rotation.z],
      scale: [target.scale.x, target.scale.y, target.scale.z],
    };
    const result = editor.commitTransform(objectId, transform);
    // 仅提交成功才标记正常路径；失败时 cleanup 按中断回滚节点，保持视觉与数据一致
    committedRef.current = result.ok;
    setDragging(false);
    if (!result.ok) showToast(result.error.message, 'error');
  };

  return (
    <TransformControls
      object={target}
      mode={view.transformMode}
      space={view.transformSpace}
      onMouseDown={() => {
        setDragging(true);
        editor.beginTransform();
      }}
      onMouseUp={commit}
    />
  );
}

/** 相机视图画幅矩形上的辅助线：三分线与安全框（DOM 覆盖层，截图不可见） */
function GuidesOverlay({
  rect,
  view,
}: {
  rect: { x: number; y: number; width: number; height: number };
  view: ViewState;
}) {
  const { x, y, width, height } = rect;
  return (
    <div
      className="lumora-guides"
      data-testid="lumora-guides"
      style={{ left: x, top: y, width, height }}
      aria-hidden
    >
      <svg width={width} height={height} className="lumora-guides__svg">
        {view.guides.thirds && (
          <g stroke="rgba(255,255,255,0.28)" strokeWidth={1}>
            <line x1={width / 3} y1={0} x2={width / 3} y2={height} />
            <line x1={(width * 2) / 3} y1={0} x2={(width * 2) / 3} y2={height} />
            <line x1={0} y1={height / 3} x2={width} y2={height / 3} />
            <line x1={0} y1={(height * 2) / 3} x2={width} y2={(height * 2) / 3} />
          </g>
        )}
        {view.guides.safeFrame && (
          <rect
            x={width * 0.05}
            y={height * 0.05}
            width={width * 0.9}
            height={height * 0.9}
            fill="none"
            stroke="rgba(255,255,255,0.28)"
          />
        )}
      </svg>
    </div>
  );
}

/** 视口内工具条：导演/相机视图切换、辅助线开关、Gizmo 模式与空间 */
function ViewportToolbar({
  editor,
  project,
  view,
}: {
  editor: SceneEditor;
  project: Project | null;
  view: ViewState;
}) {
  // 机位列表按活动场景隔离：只列活动场景可达集内的相机
  const reachableIds = useMemo(
    () => (project ? getReachableIds(project, project.activeSceneId) : null),
    [project],
  );
  const cameras =
    project && reachableIds
      ? project.objects.filter((o) => o.type === 'camera' && reachableIds.has(o.id))
      : [];
  const cameraView = view.viewMode !== 'director' ? view.viewMode.cameraObjectId : null;
  return (
    <div
      className="lumora-viewport-toolbar"
      data-testid="viewport-toolbar"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <select
        className="lumora-select"
        data-testid="view-mode-select"
        value={cameraView ?? 'director'}
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'director') editor.setViewMode('director');
          else editor.setViewMode({ cameraObjectId: value });
        }}
        disabled={!project}
      >
        <option value="director">导演视图</option>
        {cameras.map((camera) => (
          <option key={camera.id} value={camera.id}>
            相机 · {camera.name}
          </option>
        ))}
      </select>
      <label className="lumora-check">
        <input
          type="checkbox"
          checked={view.guides.thirds}
          onChange={(e) => editor.setGuide('thirds', e.target.checked)}
        />
        三分线
      </label>
      <label className="lumora-check">
        <input
          type="checkbox"
          checked={view.guides.safeFrame}
          onChange={(e) => editor.setGuide('safeFrame', e.target.checked)}
        />
        安全框
      </label>
      <span className="lumora-viewport-toolbar__sep" />
      {(
        [
          ['translate', '平移'],
          ['rotate', '旋转'],
          ['scale', '缩放'],
        ] as const
      ).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          className={`lumora-toolbutton${view.transformMode === mode ? ' lumora-toolbutton--active' : ''}`}
          data-testid={`gizmo-mode-${mode}`}
          onClick={() => editor.setTransformMode(mode)}
        >
          {label}
        </button>
      ))}
      <span className="lumora-viewport-toolbar__sep" />
      <button
        type="button"
        className="lumora-toolbutton"
        data-testid="gizmo-space"
        title="切换局部/世界空间"
        onClick={() => editor.setTransformSpace(view.transformSpace === 'local' ? 'world' : 'local')}
      >
        {view.transformSpace === 'local' ? '局部' : '世界'}
      </button>
    </div>
  );
}
