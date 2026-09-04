import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { findObject, fitRect, fovDegToFocalLength, getReachableIds } from '@lumora/core';
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
import {
  applyCameraWorldDelta,
  CameraDrive,
  captureCameraSample,
  DRIVE_KEY_CODES,
  getWorldRigidQuaternion,
  hasSingularWorldTransform,
  isCameraTakeoverTrack,
  restoreObjectOnNode,
  SINGULAR_CAMERA_WARNING,
  syncRigidCameraProxy,
} from './camera-drive';
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

/** Keep a right-button gesture owned by the viewport through an out-of-bounds release. */
function useViewportContextMenuGuard(viewportRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let gesturePointerId: number | null = null;
    let gestureExpiryTimer: number | null = null;
    let pendingContextMenu = false;
    let pendingContextMenuTimer: number | null = null;

    const clearGestureExpiry = () => {
      if (gestureExpiryTimer !== null) {
        globalThis.clearTimeout(gestureExpiryTimer);
        gestureExpiryTimer = null;
      }
    };
    const clearPendingContextMenu = () => {
      pendingContextMenu = false;
      if (pendingContextMenuTimer !== null) {
        globalThis.clearTimeout(pendingContextMenuTimer);
        pendingContextMenuTimer = null;
      }
    };
    const clearAll = () => {
      gesturePointerId = null;
      clearGestureExpiry();
      clearPendingContextMenu();
    };
    const armGesture = (pointerId: number) => {
      clearPendingContextMenu();
      gesturePointerId = pointerId;
      clearGestureExpiry();
      // A stuck pointer stream is abnormal; normal long presses remain armed
      // until pointerup/pointercancel rather than expiring after two seconds.
      gestureExpiryTimer = globalThis.setTimeout(() => {
        gesturePointerId = null;
        gestureExpiryTimer = null;
      }, 5 * 60_000);
    };
    const eventPath = (event: Event): EventTarget[] => {
      const path = event.composedPath?.();
      return path && path.length > 0 ? path : event.target ? [event.target] : [];
    };
    const isWithinViewport = (event: Event): boolean => {
      const path = eventPath(event);
      if (path.includes(viewport)) return true;
      const target = event.target;
      return target instanceof Node && (target === viewport || viewport.contains(target));
    };
    const isInteractiveTarget = (event: Event): boolean => eventPath(event).some((entry) => {
      if (!(entry instanceof Element)) return false;
      return entry.matches('button, input, select, textarea, [contenteditable="true"]') ||
        entry.closest('button, input, select, textarea, [contenteditable="true"]') !== null;
    });
    const onPointerDown = (event: PointerEvent) => {
      // Every pointer sequence supersedes any stale gesture state before the
      // current event is evaluated for viewport context-menu suppression.
      clearAll();
      if (event.button !== 2 || !isWithinViewport(event) || isInteractiveTarget(event)) return;
      armGesture(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== gesturePointerId) return;
      gesturePointerId = null;
      clearGestureExpiry();
      pendingContextMenu = true;
      if (pendingContextMenuTimer !== null) globalThis.clearTimeout(pendingContextMenuTimer);
      pendingContextMenuTimer = globalThis.setTimeout(clearPendingContextMenu, 10_000);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === gesturePointerId) clearAll();
    };
    const onContextMenu = (event: MouseEvent) => {
      if (gesturePointerId !== null || pendingContextMenu || isWithinViewport(event)) {
        event.preventDefault();
        clearAll();
      }
    };
    const onWindowBlur = () => clearAll();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') clearAll();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearAll();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [viewportRef]);
}

function normalizeEulerSignedZero(euler: THREE.Euler): void {
  const x = Object.is(euler.x, -0) ? 0 : euler.x;
  const y = Object.is(euler.y, -0) ? 0 : euler.y;
  const z = Object.is(euler.z, -0) ? 0 : euler.z;
  if (Object.is(euler.x, -0) || Object.is(euler.y, -0) || Object.is(euler.z, -0)) {
    euler.set(x, y, z, euler.order);
  }
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
  useViewportContextMenuGuard(containerRef);
  const rootRef = useRef<THREE.Group | null>(null);
  const [sceneRootGeneration, setSceneRootGeneration] = useState(0);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const cameraTransformWarningRef = useRef<string | null>(null);
  const cameraDriveActiveRef = useRef(false);
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
  const handleSceneRootReady = useCallback(() => {
    setSceneRootGeneration((generation) => generation + 1);
  }, []);

  // Selection chooses the idle drive target. Once recording starts, the
  // recorder owns that identity until the session ends, even if selection changes.
  const selectedCameraId = useMemo(() => {
    if (!project || selection.length !== 1) return null;
    const object = findObject(project, selection[0]!);
    return object && object.type === 'camera' ? object.id : null;
  }, [project, selection]);
  const povCameraId = view.viewMode !== 'director' ? view.viewMode.cameraObjectId : null;
  const drivenCameraId = session?.state.recording
    ? session.recorder.recordingCameraId
    : povCameraId ?? selectedCameraId;

  useCameraDrive(
    session,
    drivenCameraId,
    rootRef,
    cameraRef,
    cameraDriveActiveRef,
    cameraTransformWarningRef,
    editor,
    containerRef,
    keyboardScopeRef,
    driveEnabled,
    view.viewMode === 'director',
  );

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
      role="region"
      aria-label="3D scene viewport"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onContextMenu={(event) => event.preventDefault()}
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
          onRootReady={handleSceneRootReady}
          onRenderContentChange={onRenderContentChange}
        />
        {cameraView && project && (
          <CameraRig
            rootRef={rootRef}
            cameraObjectId={cameraView}
            aspect={aspect}
            project={project}
            warningRef={cameraTransformWarningRef}
          />
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
        {!cameraView && view.viewMode === 'director' && (
          <DirectorOrbitControls
            enabled={
              !dragging &&
              !session?.state.recording &&
              !session?.state.playing &&
              session?.state.cameraControls.mode !== 'keyboard-only'
            }
            driveActiveRef={cameraDriveActiveRef}
          />
        )}
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
          <PlaybackDriver
            session={session}
            editor={editor}
            rootRef={rootRef}
            sceneRootGeneration={sceneRootGeneration}
            skipIdsRef={skipIdsRef}
          />
          {/* 数值位姿读取钩子仅供 e2e 数值断言（复审一般 7）：dev 服务（e2e 即
              dev server）挂载，生产构建 tree-shake —— 60Hz JSON stringify 不进
              生产树 */}
          {(import.meta.env.DEV || import.meta.env.VITE_LUMORA_E2E === '1') && (
            <CameraPoseReadout session={session} editor={editor} rootRef={rootRef} cameraRef={cameraRef} />
          )}
        </>
      )}
      {cameraView && containerSize && project && (
        <GuidesOverlay rect={fitRect(containerSize.width, containerSize.height, aspect)} view={view} />
      )}
      <CameraDirectionIndicator cameraRef={cameraRef} warningRef={cameraTransformWarningRef} />
      <ViewportToolbar
        editor={editor}
        project={project}
        view={view}
        recording={!!session?.state.recording}
      />
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
  renderedCameraRef: React.MutableRefObject<THREE.Camera | null>,
  activityRef: React.MutableRefObject<boolean>,
  warningRef: React.MutableRefObject<string | null>,
  editor: SceneEditor,
  viewportRef: React.RefObject<HTMLElement | null>,
  keyboardScopeRef?: React.RefObject<HTMLElement | null>,
  driveEnabled = true,
  directorMode = false,
) {
  const cameraIdRef = useRef<string | null>(null);
  cameraIdRef.current = drivenCameraId;
  const directorModeRef = useRef(directorMode);
  directorModeRef.current = directorMode;
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
    let attachedScope: 'director' | 'recording' | 'scene' | null = null;
    let attachedNode: THREE.Object3D | null = null;
    let mirrorId: string | null = null;
    let mirrorNode: THREE.Object3D | null = null;
    const heldKeys = new Set<string>();
    let lookPointerId: number | null = null;
    let lookClientX = 0;
    let lookClientY = 0;
    const previousPrimaryPosition = new THREE.Vector3();
    const previousPrimaryQuaternion = new THREE.Quaternion();
    const currentPrimaryPosition = new THREE.Vector3();
    const currentPrimaryQuaternion = new THREE.Quaternion();
    let mirrorPoseInitialized = false;
    let previousPrimaryFov: number | null = null;
    let previousPrimaryFocal: number | null = null;

    const endLookGesture = () => {
      if (lookPointerId === null) return;
      const pointerId = lookPointerId;
      lookPointerId = null;
      const viewport = viewportRef.current;
      try {
        viewport?.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture can already be released by the browser.
      }
    };

    const clearDrive = () => {
      endLookGesture();
      heldKeys.clear();
      drive.stop();
      attachedId = null;
      attachedScope = null;
      attachedNode = null;
      mirrorId = null;
      mirrorNode = null;
      mirrorPoseInitialized = false;
      previousPrimaryFov = null;
      previousPrimaryFocal = null;
      activityRef.current = false;
      warningRef.current = null;
    };

    const attachCurrentCamera = (): boolean => {
      const cameraId = cameraIdRef.current;
      const recording = !!sessionRef.current?.state.recording;
      const isDirector = directorModeRef.current && !recording;
      const targetScope: 'director' | 'recording' | 'scene' = isDirector ? 'director' : recording ? 'recording' : 'scene';
      const root = rootRef.current;
      const node = isDirector
        ? renderedCameraRef.current
        : root && cameraId
          ? findNode(root, cameraId)
          : null;
      const targetId = isDirector ? '__director__' : cameraId;
      if (!targetId || !node) return false;
      const nextMirrorNode =
        isDirector && cameraId && root && !hasActiveTrack(cameraId) ? findNode(root, cameraId) : null;
      const nextMirrorId = isDirector && cameraId ? cameraId : null;
      const targetChanged =
        attachedId !== null &&
        (attachedId !== targetId ||
          attachedScope !== targetScope ||
          attachedNode !== node ||
          mirrorId !== nextMirrorId ||
          mirrorNode !== nextMirrorNode);
      if (targetChanged) {
        // A held key belongs to the previous logical target. Require a fresh
        // keydown after view/recording transitions instead of replaying it.
        heldKeys.clear();
        endLookGesture();
        drive.stop();
      }
      if (
        attachedId !== targetId ||
        attachedScope !== targetScope ||
        attachedNode !== node ||
        mirrorId !== nextMirrorId ||
        mirrorNode !== nextMirrorNode
      ) {
        restoreIfNeeded();
        drive.attach(node);
        attachedId = targetId;
        attachedScope = targetScope;
        attachedNode = node;
        mirrorId = nextMirrorId;
        mirrorNode = nextMirrorNode;
        mirrorPoseInitialized = false;
        previousPrimaryFov = null;
        previousPrimaryFocal = null;
        if (!targetChanged) {
          for (const code of heldKeys) {
            if (drive.acceptsKey(code)) drive.press(code);
          }
        }
      }
      return true;
    };

    const hasActiveTrack = (cameraId: string): boolean =>
      !!editor.getProject()?.tracks.some((track) => isCameraTakeoverTrack(track, cameraId));

    const canDriveCurrentCamera = (): boolean => {
      const st = sessionRef.current?.state;
      const cameraId = cameraIdRef.current;
      const isDirector = directorModeRef.current && !st?.recording;
      const hasTracks =
        !!st &&
        !isDirector &&
        !!cameraId &&
        hasActiveTrack(cameraId);
      return (
        !!st &&
        driveEnabledRef.current &&
        (isDirector || cameraId !== null) &&
        !st.overwritePending &&
        !st.recordingPaused &&
        (!st.playing || st.recording) &&
        (!hasTracks || st.recording)
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !driveEnabledRef.current) return;
      const liveSession = sessionRef.current;
      if (liveSession) drive.setSettings(liveSession.state.cameraControls);
      const keyboardRoot = keyboardScopeRef?.current;
      if (keyboardRoot && !isKeyboardEventForStudio(keyboardRoot, event)) return;
      if ((event.ctrlKey || event.metaKey || event.altKey) && heldKeys.size > 0) {
        // A modifier can become active after a drive key. Hard-stop existing
        // input and momentum so the pending browser/OS shortcut cannot keep
        // mutating the camera while it is being handled.
        clearDrive();
      }
      if (preservesNativeKeyboardSemantics(event)) return;
      if (DRIVE_KEY_CODES.has(event.code)) {
        // Ctrl/Meta/Alt combinations belong to browser/OS/application shortcuts.
        // In particular, never consume Ctrl+W: browsers own tab closing and a
        // page cannot reliably override that behavior.
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!drive.acceptsKey(event.code)) return;
        // Do not queue input while playback, export, or a paused recording owns
        // the camera. A later state transition must not replay that key press.
        if (!canDriveCurrentCamera()) {
          heldKeys.clear();
          drive.stop();
          return;
        }
        if (cameraIdRef.current || directorModeRef.current) event.preventDefault();
        heldKeys.add(event.code);
        if (attachCurrentCamera()) drive.press(event.code);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2) return;
      if (lookPointerId !== null) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('button, input, select, textarea, [contenteditable="true"]')
      ) return;
      const liveSession = sessionRef.current;
      if (!liveSession) return;
      drive.setSettings(liveSession.state.cameraControls);
      if (drive.getSettings().mode !== 'keyboard-mouse' || !canDriveCurrentCamera()) return;
      if (!attachCurrentCamera()) return;
      drive.cancelTranslationMomentum();
      lookPointerId = event.pointerId;
      activityRef.current = true;
      lookClientX = event.clientX;
      lookClientY = event.clientY;
      viewportRef.current?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
      try {
        viewportRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; window-level terminal events still clean up.
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (lookPointerId === null || event.pointerId !== lookPointerId) return;
      if ((event.buttons & 2) === 0) {
        endLookGesture();
        return;
      }
      const movementX = event.movementX || event.clientX - lookClientX;
      const movementY = event.movementY || event.clientY - lookClientY;
      lookClientX = event.clientX;
      lookClientY = event.clientY;
      drive.look(movementX, movementY);
      activityRef.current = true;
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === lookPointerId) endLookGesture();
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === lookPointerId) clearDrive();
    };
    const onLostPointerCapture = (event: PointerEvent) => {
      if (event.pointerId !== lookPointerId) return;
      drive.cancelLook();
      endLookGesture();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (heldKeys.delete(event.code)) {
        drive.release(event.code);
        // Keep OrbitControls disabled for one frame so a short tap cannot be
        // overwritten by its stale target before the next interactive sync.
        activityRef.current = true;
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
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    const viewport = viewportRef.current;
    viewport?.addEventListener('pointerdown', onPointerDown, true);
    viewport?.addEventListener('pointermove', onPointerMove);
    viewport?.addEventListener('pointerup', onPointerUp);
    viewport?.addEventListener('pointercancel', onPointerCancel);
    viewport?.addEventListener('lostpointercapture', onLostPointerCapture);

    const restoreIfNeeded = () => {
      if (attachedId === null || !attachedNode) return;
      const restoreId = attachedId === '__director__' ? mirrorId : attachedId;
      const restoreNode = attachedId === '__director__' ? mirrorNode : attachedNode;
      if (!restoreId || !restoreNode) return;
      const st = sessionRef.current?.state;
      // 回放中/录制中不还原（分别由回放驱动与录制接管）；覆盖确认冻结
      // 弹窗打开瞬间的姿态，只清输入/动量，不跳回项目静态位姿。
      if (st && (st.playing || st.recording || st.overwritePending)) return;
      const project = editor.getProject();
      // 绑定机位已有启用轨道：节点由轨道求值接管（回放驱动最后一次 apply
      // 已把播放头时刻的值写到节点），还原静态位姿会让画面与播放头脱节
      if (
        project?.tracks.some((track) => isCameraTakeoverTrack(track, restoreId))
      ) {
        return;
      }
      const object = project?.objects.find((o) => o.id === restoreId);
      if (object) restoreObjectOnNode(restoreNode, object);
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
      if (st) {
        const previousMode = drive.getSettings().mode;
        drive.setSettings(st.cameraControls);
        if (drive.getSettings().mode !== previousMode) {
          heldKeys.clear();
          endLookGesture();
        }
      }
      // 可驾驶：选中机位 && 录制未暂停 && （暂停 || 录制中）&& 无启用轨道（录制中无视轨道；
      // 禁用轨道不阻止驾驶 —— 禁用 = 该通道暂不参与回放）
      const canDrive = canDriveCurrentCamera();
      if (!canDrive) {
        endLookGesture();
        heldKeys.clear();
        activityRef.current = false;
        if (attachedId !== null) {
          restoreIfNeeded();
          drive.stop();
          attachedId = null;
          attachedScope = null;
          attachedNode = null;
          mirrorId = null;
          mirrorNode = null;
          mirrorPoseInitialized = false;
          previousPrimaryFov = null;
          previousPrimaryFocal = null;
        }
        raf = requestAnimationFrame(loop);
        return;
      }
      if (!attachCurrentCamera()) {
        warningRef.current = null;
        raf = requestAnimationFrame(loop);
        return;
      }
      const primary = attachedNode;
      const singularTransform = !!primary && (
        hasSingularWorldTransform(primary) || (!!mirrorNode && hasSingularWorldTransform(mirrorNode))
      );
      warningRef.current = singularTransform ? SINGULAR_CAMERA_WARNING : null;
      if (singularTransform) {
        clearDrive();
        warningRef.current = SINGULAR_CAMERA_WARNING;
        raf = requestAnimationFrame(loop);
        return;
      }
      if (primary && mirrorNode) {
        primary.updateMatrixWorld(true);
        if (!mirrorPoseInitialized) {
          primary.getWorldPosition(previousPrimaryPosition);
          getWorldRigidQuaternion(primary, previousPrimaryQuaternion);
          if (primary instanceof THREE.PerspectiveCamera) {
            previousPrimaryFov = primary.fov;
            const focal = (primary.userData as Record<string, unknown>).focalLength;
            previousPrimaryFocal = typeof focal === 'number' && Number.isFinite(focal) ? focal : null;
          }
          mirrorPoseInitialized = true;
        }
      }
      drive.update(dt);
      if (primary && mirrorNode) {
        primary.updateMatrixWorld(true);
        primary.getWorldPosition(currentPrimaryPosition);
        getWorldRigidQuaternion(primary, currentPrimaryQuaternion);
        const mirrorApplied = applyCameraWorldDelta(
          mirrorNode,
          previousPrimaryPosition,
          previousPrimaryQuaternion,
          currentPrimaryPosition,
          currentPrimaryQuaternion,
        );
        if (!mirrorApplied) {
          clearDrive();
          warningRef.current = SINGULAR_CAMERA_WARNING;
          raf = requestAnimationFrame(loop);
          return;
        }
        previousPrimaryPosition.copy(currentPrimaryPosition);
        previousPrimaryQuaternion.copy(currentPrimaryQuaternion);
        normalizeEulerSignedZero(mirrorNode.rotation);
        if (primary instanceof THREE.PerspectiveCamera && mirrorNode instanceof THREE.PerspectiveCamera) {
          const focal = (primary.userData as Record<string, unknown>).focalLength;
          const currentFocal = typeof focal === 'number' && Number.isFinite(focal) ? focal : null;
          if (primary.fov !== previousPrimaryFov || currentFocal !== previousPrimaryFocal) {
            mirrorNode.fov = primary.fov;
            mirrorNode.updateProjectionMatrix();
            if (currentFocal === null) delete (mirrorNode.userData as Record<string, unknown>).focalLength;
            else (mirrorNode.userData as Record<string, unknown>).focalLength = currentFocal;
          }
          previousPrimaryFov = primary.fov;
          previousPrimaryFocal = currentFocal;
        }
      }
      activityRef.current = drive.hasInput || lookPointerId !== null;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      viewport?.removeEventListener('pointerdown', onPointerDown, true);
      viewport?.removeEventListener('pointermove', onPointerMove);
      viewport?.removeEventListener('pointerup', onPointerUp);
      viewport?.removeEventListener('pointercancel', onPointerCancel);
      viewport?.removeEventListener('lostpointercapture', onLostPointerCapture);
      restoreIfNeeded();
      clearDrive();
    };
  }, [session, rootRef, renderedCameraRef, activityRef, warningRef, editor, viewportRef, keyboardScopeRef]);
}

function DirectorOrbitControls({
  enabled,
  driveActiveRef,
}: {
  enabled: boolean;
  driveActiveRef: React.MutableRefObject<boolean>;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const controlsInstanceRef = useRef<OrbitControlsImpl | null>(null);
  const interactiveRef = useRef<boolean | null>(null);
  const orbitTargetRef = useRef(new THREE.Vector3());
  const enabledRef = useRef(enabled);
  const pendingRemountStateRef = useRef<OrbitControlsRemountState | null>(null);
  const [controlsGeneration, setControlsGeneration] = useState(0);
  const queueRemount = useCallback((controls: OrbitControlsImpl) => {
    pendingRemountStateRef.current = captureOrbitControlsRemountState(controls);
    orbitTargetRef.current.copy(controls.target);
    setControlsGeneration((generation) => generation + 1);
  }, []);
  const setControlsRef = useCallback((controls: OrbitControlsImpl | null) => {
    controlsRef.current = controls;
    const remountState = pendingRemountStateRef.current;
    if (!controls || !remountState) return;
    restoreOrbitControlsRemountState(controls, remountState);
    orbitTargetRef.current.copy(remountState.target);
    pendingRemountStateRef.current = null;
  }, []);
  useLayoutEffect(() => {
    if (enabledRef.current === enabled) return;
    enabledRef.current = enabled;
    const controls = controlsRef.current;
    if (!controls) return;
    flushOrbitControlsPendingState(controls);
    queueRemount(controls);
  }, [enabled, queueRemount]);
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (controlsInstanceRef.current !== controls) {
      controls.target.copy(orbitTargetRef.current);
      controlsInstanceRef.current = controls;
      interactiveRef.current = null;
    }
    const interactive = enabled && !driveActiveRef.current;
    if (interactiveRef.current !== interactive) {
      const wasInteractive = interactiveRef.current;
      flushOrbitControlsPendingState(controls);
      if (interactive) {
        const direction = new THREE.Vector3();
        controls.object.getWorldDirection(direction);
        const distance = controls.target.distanceTo(controls.object.position);
        controls.target.copy(controls.object.position).addScaledVector(direction, distance > 1e-6 ? distance : 10);
      }
      controls.enabled = interactive;
      interactiveRef.current = interactive;
      if (wasInteractive === true && !interactive && enabled) {
        queueRemount(controls);
      }
    }
    orbitTargetRef.current.copy(controls.target);
  }, -2);
  return (
    <OrbitControls
      key={controlsGeneration}
      ref={setControlsRef}
      makeDefault
      enableDamping
      enabled={enabled && !driveActiveRef.current}
    />
  );
}

interface OrbitControlsRemountState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  up: THREE.Vector3;
  target: THREE.Vector3;
  zoom: number;
}

function captureOrbitControlsRemountState(controls: OrbitControlsImpl): OrbitControlsRemountState {
  return {
    position: controls.object.position.clone(),
    quaternion: controls.object.quaternion.clone(),
    up: controls.object.up.clone(),
    target: controls.target.clone(),
    zoom: controls.object.zoom,
  };
}

function restoreOrbitControlsRemountState(
  controls: OrbitControlsImpl,
  state: OrbitControlsRemountState,
): void {
  const object = controls.object;
  object.position.copy(state.position);
  object.quaternion.copy(state.quaternion);
  object.up.copy(state.up);
  const zoomChanged = object.zoom !== state.zoom;
  object.zoom = state.zoom;
  controls.target.copy(state.target);
  if (zoomChanged) object.updateProjectionMatrix();
  object.updateMatrixWorld(true);
}

export function flushOrbitControlsPendingState(controls: OrbitControlsImpl): void {
  const object = controls.object;
  const position = object.position.clone();
  const quaternion = object.quaternion.clone();
  const up = object.up.clone();
  const target = controls.target.clone();
  const zoom = object.zoom;
  const enableDamping = controls.enableDamping;
  const autoRotate = controls.autoRotate;
  // OrbitControls keeps damping deltas in closures and does not consume them
  // while disabled. Run one update to drain them, then restore the authoritative
  // camera pose so the next interaction starts from a clean state.
  controls.enableDamping = false;
  controls.autoRotate = false;
  controls.update();
  controls.enableDamping = enableDamping;
  controls.autoRotate = autoRotate;
  object.position.copy(position);
  object.quaternion.copy(quaternion);
  object.up.copy(up);
  const zoomChanged = object.zoom !== zoom;
  object.zoom = zoom;
  controls.target.copy(target);
  if (zoomChanged) object.updateProjectionMatrix();
  object.updateMatrixWorld(true);
}

/** 把当前渲染相机镜像给外层（点击拾取用） */
function CameraProxy({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);
  return null;
}

function CameraDirectionIndicator({
  cameraRef,
  warningRef,
}: {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  warningRef?: React.MutableRefObject<string | null>;
}) {
  const arrowRef = useRef<HTMLSpanElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const warningElementRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    let lastText = '';
    let lastVisibleText = '';
    let lastHeading: number | null = null;
    let lastWarning = '';
    let lastAnnouncement = -Infinity;
    const announcementInterval = 750;
    const direction = new THREE.Vector3();
    const refresh = (now: number) => {
      const camera = cameraRef.current;
      if (camera) {
        camera.getWorldDirection(direction);
        const heading = Math.round(
          ((THREE.MathUtils.radToDeg(Math.atan2(direction.x, -direction.z)) + 360) % 360),
        );
        const pitch = Math.round(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))));
        const text = `Heading ${heading} deg | Pitch ${pitch >= 0 ? '+' : ''}${pitch} deg`;
        if (arrowRef.current && heading !== lastHeading) {
          arrowRef.current.style.transform = `rotate(${heading}deg)`;
          lastHeading = heading;
        }
        if (readoutRef.current && text !== lastVisibleText) {
          readoutRef.current.textContent = text;
          lastVisibleText = text;
        }
        if (statusRef.current && text !== lastText && now - lastAnnouncement >= announcementInterval) {
          statusRef.current.textContent = text;
          lastText = text;
          lastAnnouncement = now;
        }
      }
      const warning = warningRef?.current ?? '';
      if (warningElementRef.current && warning !== lastWarning) {
        warningElementRef.current.textContent = warning;
        lastWarning = warning;
      }
      frame = requestAnimationFrame(refresh);
    };
    frame = requestAnimationFrame(refresh);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, warningRef]);

  return (
    <div className="lumora-camera-direction" data-testid="camera-direction-indicator">
      <span className="lumora-camera-direction__compass" aria-hidden="true">
        <span ref={arrowRef} className="lumora-camera-direction__arrow" />
      </span>
      <span
        ref={readoutRef}
        className="lumora-camera-direction__status"
        data-testid="camera-direction-status"
        aria-hidden="true"
      >
        Heading -- deg | Pitch -- deg
      </span>
      <span
        ref={statusRef}
        className="lumora-camera-direction__announcement"
        data-testid="camera-direction-announcement"
        aria-live="polite"
        aria-atomic="true"
      >
        Heading -- deg | Pitch -- deg
      </span>
      <span
        ref={warningElementRef}
        className="lumora-camera-direction__warning"
        data-testid="camera-transform-warning"
        aria-live="polite"
      />
    </div>
  );
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
  cameraRef,
}: {
  session: TimelineSession;
  editor: SceneEditor;
  rootRef: React.RefObject<THREE.Group | null>;
  cameraRef: React.RefObject<THREE.Camera | null>;
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
      const renderedCamera = cameraRef.current;
      if (renderedCamera) {
        renderedCamera.updateMatrixWorld(true);
        const position = renderedCamera.getWorldPosition(new THREE.Vector3());
        const rotation = renderedCamera.getWorldQuaternion(new THREE.Quaternion());
        const euler = new THREE.Euler().setFromQuaternion(rotation, 'XYZ');
        poses.__rendered__ = {
          position: [position.x, position.y, position.z],
          rotation: [euler.x, euler.y, euler.z],
          focalLength: renderedCamera instanceof THREE.PerspectiveCamera
            ? fovDegToFocalLength(renderedCamera.fov)
            : null,
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
  }, [session, editor, rootRef, cameraRef]);
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
  const cameraProxyRef = useRef<THREE.PerspectiveCamera | null>(null);
  useEffect(() => {
    const resolveCamera = (cameraObjectId?: string | null): THREE.Camera | null => {
      if (!cameraObjectId) return camera;
      const node = rootRef.current ? findNode(rootRef.current, cameraObjectId) : null;
      if (!(node instanceof THREE.PerspectiveCamera)) return null;
      if (!cameraProxyRef.current) cameraProxyRef.current = new THREE.PerspectiveCamera();
      return syncRigidCameraProxy(node, cameraProxyRef.current, aspect)
        ? cameraProxyRef.current
        : null;
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
  onRootReady,
  onRenderContentChange,
}: {
  editor: SceneEditor;
  rootRef: React.MutableRefObject<THREE.Group | null>;
  project: Project | null;
  cache: ContentCache;
  onRootReady: () => void;
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
      onRootReady();
      sessionRef.current = session;
      setContentVersion((v) => v + 1);
      onRenderContentChange?.();
    }
    prevProjectRef.current = project;
  }, [project, scene, rootRef, editor, onRootReady, onRenderContentChange]);

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
  warningRef,
}: {
  rootRef: React.MutableRefObject<THREE.Group | null>;
  cameraObjectId: string;
  aspect: number;
  project: Project;
  warningRef: React.MutableRefObject<string | null>;
}) {
  const set = useThree((s) => s.set);
  const camera = useThree((s) => s.camera);
  // 挂载首帧保存导演相机引用：此后机位视图内的重渲染（画幅/项目变化）里
  // state.camera 已是镜头相机，ref 守住首次值不被覆盖，卸载恢复才不会
  // 把镜头相机误当导演相机装回去。useThree 必须无条件调用（Rules of
  // Hooks），只把首次订阅到的相机写进 ref
  const restoreRef = useRef<RootState['camera'] | null>(null);
  const sourceRef = useRef<THREE.PerspectiveCamera | null>(null);
  const proxyRef = useRef<THREE.PerspectiveCamera | null>(null);
  if (!restoreRef.current) restoreRef.current = camera;

  useEffect(() => {
    const root = rootRef.current;
    const node = root ? findNode(root, cameraObjectId) : null;
    if (!node || !(node instanceof THREE.PerspectiveCamera)) return;
    node.aspect = aspect;
    node.updateProjectionMatrix();
    if (!proxyRef.current) proxyRef.current = new THREE.PerspectiveCamera();
    sourceRef.current = node;
    warningRef.current = hasSingularWorldTransform(node) ? SINGULAR_CAMERA_WARNING : null;
    syncRigidCameraProxy(node, proxyRef.current, aspect);
    set({ camera: proxyRef.current });
    return () => {
      sourceRef.current = null;
      warningRef.current = null;
      if (restoreRef.current) set({ camera: restoreRef.current });
    };
  }, [cameraObjectId, aspect, project, set, rootRef, warningRef]);

  useFrame(() => {
    const source = sourceRef.current;
    const proxy = proxyRef.current;
    if (!source || !proxy) return;
    warningRef.current = hasSingularWorldTransform(source) ? SINGULAR_CAMERA_WARNING : null;
    syncRigidCameraProxy(source, proxy, aspect);
  });

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
  recording = false,
}: {
  editor: SceneEditor;
  project: Project | null;
  view: ViewState;
  recording?: boolean;
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
        disabled={!project || recording}
        title={recording ? 'Recording view is locked to the active recording session' : undefined}
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
