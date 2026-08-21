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
  isContentNode,
  isOwnedNode,
  syncScene,
} from './scene-builder';
import { showToast } from './toasts';

interface EditorViewportProps {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
  view: ViewState;
  cache: ContentCache;
}

/** 沿父链找到最近的对象 id（GLB 内容网格挂在模型组下，需要向上追溯）。
 *  只读品牌节点（R10-M2）：内容子树透明——内容根带 CONTENT_MARK，即使内容
 *  伪造 objectId/brand 也不读取，继续上溯到模型 */
export function findObjectId(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!isContentNode(current) && isOwnedNode(current)) {
      return current.userData.objectId as string;
    }
    current = current.parent;
  }
  return null;
}

/**
 * 3D 视口：
 * - 场景树由项目数据增量同步（scene-builder），模型内容经 ContentCache lease 挂载
 * - Gizmo 拖动 = beginTransform/commitTransform 一步历史；局部/世界空间可切换
 * - 导演视图全容器拾取；相机视图 letterbox 到项目画幅（gl viewport/scissor
 *   传 CSS 像素，three 内部按 pixelRatio 换算），三分线/安全框以 DOM 覆盖层
 *   绘制在相同矩形上 —— 辅助线永不进入 canvas
 */
export function EditorViewport({ editor, project, selection, view, cache }: EditorViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const [dragging, setDragging] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  // 同步引用：Gizmo 的原生 pointerdown 监听先于容器 React 处理器执行，
  // 用 ref 而非异步的 state 判断「拖动已在 Gizmo 上开始」，避免拾取改选/清选
  const draggingRef = useRef(false);

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
      onPointerDown={handlePointerDown}
    >
      <Canvas dpr={[1, 2]} camera={{ position: [7, 5, 7], fov: 45 }}>
        <color attach="background" args={['#14161f']} />
        <ambientLight intensity={0.35} />
        <gridHelper args={[20, 20, '#3a3f52', '#2a2e3d']} />
        <SceneContent editor={editor} rootRef={rootRef} project={project} cache={cache} />
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
        />
        {!cameraView && <OrbitControls makeDefault enableDamping enabled={!dragging} />}
        <CameraProxy cameraRef={cameraRef} />
      </Canvas>
      {cameraView && containerSize && project && (
        <GuidesOverlay rect={fitRect(containerSize.width, containerSize.height, aspect)} view={view} />
      )}
      <ViewportToolbar editor={editor} project={project} view={view} />
    </div>
  );
}

/** 把当前渲染相机镜像给外层（点击拾取用） */
function CameraProxy({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);
  return null;
}

function SceneContent({
  editor,
  rootRef,
  project,
  cache,
}: {
  editor: SceneEditor;
  rootRef: React.MutableRefObject<THREE.Group | null>;
  project: Project | null;
  cache: ContentCache;
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
      const { rebuiltModelIds } = syncScene(current, prevProjectRef.current, project, aspect);
      if (rebuiltModelIds.length > 0) setContentVersion((v) => v + 1);
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
    }
    prevProjectRef.current = project;
  }, [project, scene, rootRef, editor]);

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
          for (const objectId of objectIds) {
            const node = findNode(root, objectId);
            if (node) attachModelContent(node, gltf);
          }
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
  }, [project, cache, rootRef, contentVersion]);

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
}: {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
  view: ViewState;
  rootRef: React.MutableRefObject<THREE.Group | null>;
  dragging: boolean;
  setDragging: (value: boolean) => void;
}) {
  const root = rootRef.current;
  const target = selection.length === 1 && project && root ? findNode(root, selection[0]) : null;
  const data = target ? findObject(project!, target.userData.objectId as string) : undefined;
  const locked = !!data?.locked;
  /** 正常提交路径标记：commit 先置位再收尾 dragging，cleanup 据此区分中断回滚 */
  const committedRef = useRef(false);

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

  if (!target || locked || !project) return null;

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
