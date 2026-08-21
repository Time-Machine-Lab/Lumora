import { HistoryStack } from '../history/history';
import { genId } from '../scene/create';
import {
  addAsset,
  collectUnreferencedAssets,
  findAssetByHash,
  findObject,
  getDescendantIds,
  getReachableIds,
  getScene,
  isInActiveScene,
  isInSubtree,
  isValidTransform,
  removeAssets,
  removeObjects,
  updateObject,
} from '../scene/scene-graph';
import { deepFreeze } from '../scene/immutable';
import { validateProjectSchema, validateSceneObjectData } from '../scene/validate';
import { isSceneObject } from '../scene/types';
import type { AssetData, Project, SceneObjectData, TransformData } from '../scene/types';
import { TypedEventEmitter } from '../events/typed-event-emitter';

/** 视口变换模式（FR-004） */
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';
/** director = 导演自由视角；cameraObjectId = 从该机位查看（FR-005） */
export type ViewMode = 'director' | { cameraObjectId: string };

export interface ViewState {
  transformMode: TransformMode;
  transformSpace: TransformSpace;
  viewMode: ViewMode;
  guides: { thirds: boolean; safeFrame: boolean };
}

export type Result<T = void> =
  | { ok: true; value?: T; deduped?: boolean; asset?: AssetData }
  | { ok: false; error: Error };

export interface EditorEventMap {
  'project:changed': { project: Project | null };
  'selection:changed': { ids: string[] };
  'history:changed': {
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string | null;
    redoLabel: string | null;
  };
  'view:changed': { view: ViewState };
  [event: string]: unknown;
}

function freshDefaultView(): ViewState {
  return { ...DEFAULT_VIEW, guides: { ...DEFAULT_VIEW.guides } };
}

const DEFAULT_VIEW: ViewState = {
  transformMode: 'translate',
  transformSpace: 'local',
  viewMode: 'director',
  guides: { thirds: true, safeFrame: true },
};

/** 历史快照：项目 + 选择（撤销/重做同步恢复两者） */
interface EditorSnapshot {
  project: Project;
  selection: string[];
}

/**
 * 事务基线（R9-M1）：入口最开始时捕获的项目引用 + 会话/版本号。
 * 外部窗口（输入对象克隆、updater 回调、transform 数组元素读取）后必须
 * guardReentry 复验：dispose 或任何状态写（嵌套提交/嵌套 openProject/嵌套
 * selection/视图写）都使本次操作失效——不得移动历史、不得覆盖内层结果、
 * 不得复活已释放编辑器。project 可为 null：openProject 在首次打开（尚无
 * 项目）时同样需要基线复验。
 */
interface Baseline {
  project: Project | null;
  selection: string[];
  version: number;
  session: number;
}

/**
 * 视图写事务基线（R10-M1）：view setter 的轻量基线——不含 project/session，
 * 只捕获版本号与视图快照（视图写不触碰项目状态，读项目属于越界防御）。
 */
interface ViewBaseline {
  version: number;
  view: ViewState;
}

function failure(message: string): Result<never> {
  return { ok: false, error: new Error(message) };
}

/** 视图状态等价（getView 副本引用必然不同，基线复验必须按值比较） */
function sameViewState(a: ViewState, b: ViewState): boolean {
  if (a.transformMode !== b.transformMode) return false;
  if (a.transformSpace !== b.transformSpace) return false;
  if (a.guides.thirds !== b.guides.thirds) return false;
  if (a.guides.safeFrame !== b.guides.safeFrame) return false;
  if (a.viewMode === b.viewMode) return true;
  if (a.viewMode === 'director' || b.viewMode === 'director') return false;
  return a.viewMode.cameraObjectId === b.viewMode.cameraObjectId;
}

/** 变换值等价（克隆副本引用必然不同，锁定校验必须按值比较） */
function sameTransformData(a: TransformData, b: TransformData): boolean {
  const { position: ap, rotation: ar, scale: as } = a;
  const { position: bp, rotation: br, scale: bs } = b;
  return (
    ap[0] === bp[0] && ap[1] === bp[1] && ap[2] === bp[2] &&
    ar[0] === br[0] && ar[1] === br[1] && ar[2] === br[2] &&
    as[0] === bs[0] && as[1] === bs[1] && as[2] === bs[2]
  );
}

/**
 * 核心 3D 场景编辑器（框架无关）：
 * - 持有 owned immutable project：openProject 深克隆输入并递归冻结，编辑器外的任何
 *   改动（宿主快照/插件/调用方持有的旧引用）都不可能影响编辑器状态；getProject() 等
 *   getter 只暴露冻结引用，写入在严格模式下抛 TypeError、非严格模式静默失败
 * - 提交路径为同一原子操作：validate/derive/stamp（校验 + 单调 revision + 冻结）、
 *   状态换入、history 游标提交 —— 任一校验失败时状态与游标均不变
 * - 锁定对象不可变换/删除/变更层级；NaN/Infinity 数值拒绝
 * - 一次 Gizmo 拖动 = 一个历史步骤（beginTransform/commitTransform 成对）
 * - dispose() 在任何同步事件前进入不可重入终态：失效 session/事务、永久关闭事件总线
 */
export class SceneEditor {
  readonly events = new TypedEventEmitter<EditorEventMap>();

  private project: Project | null = null;
  private selection: string[] = [];
  private view: ViewState = freshDefaultView();
  private history = new HistoryStack<EditorSnapshot>();
  /** beginTransform 捕获的拖动前快照（冻结引用，只读） */
  private dragSnapshot: EditorSnapshot | null = null;
  /** 会话令牌：openProject/reset/dispose 时递增；异步流程据此绑定所属项目会话 */
  private sessionToken = 0;
  /** 已释放（runtime dispose）：任何写入/提交一律拒绝 */
  private disposed = false;
  /** 每次应用状态的单调序号（openProject/提交/撤销/重做各取新值） */
  private revisionCounter = 0;
  /** 状态变迁版本（R10-M1）：project/selection/view 三类状态任何一次实际写入
   *  （swapState/dispose/选择写/视图写）都递增；外部回调/克隆后据此检测重入 */
  private mutationVersion = 0;

  /** 当前项目（owned immutable：只读冻结引用，不泄露可写引用） */
  getProject(): Project | null {
    return this.project;
  }

  getSelection(): string[] {
    return [...this.selection];
  }

  getSelectedObjects(): SceneObjectData[] {
    return this.selection
      .map((id) => (this.project ? findObject(this.project, id) : undefined))
      .filter((o): o is SceneObjectData => !!o);
  }

  getView(): ViewState {
    return {
      ...this.view,
      viewMode:
        this.view.viewMode === 'director'
          ? 'director'
          : { cameraObjectId: this.view.viewMode.cameraObjectId },
      guides: { ...this.view.guides },
    };
  }

  getHistoryState() {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      redoLabel: this.history.redoLabel,
    };
  }

  openProject(project: Project): void {
    // 原子提交（R6）：先在局部完成 clone → 校验 → 冻结与 next state 构造，
    // 全部就绪后才一次性提交 project/history/session/revision；
    // 任何一步失败（DataCloneError/校验失败）都不触碰既有状态。
    this.assertAlive();
    const baseline: Baseline = {
      project: this.project,
      selection: [...this.selection],
      version: this.mutationVersion,
      session: this.sessionToken,
    };
    const owned = this.own(project); // clone 先行：校验与冻结都在编辑器自有副本上进行
    // 输入对象 getter 可能在 structuredClone 期间副作用地释放/重入编辑器（R8）：
    // 克隆后复验终态，不得复活已释放编辑器或覆盖内层 openProject 结果
    const reentered = this.guardReentry(baseline);
    if (reentered) throw reentered.error;
    this.validateProject(owned);
    this.swapState(owned, [], { resetView: true });
    this.revisionCounter = owned.revision;
    this.history.clear();
    this.dragSnapshot = null;
    this.sessionToken += 1;
    this.emitProjectEvents();
    this.emitHistory();
  }

  reset(): void {
    this.assertAlive();
    this.history.clear();
    this.dragSnapshot = null;
    this.sessionToken += 1;
    this.swapState(null, [], { resetView: true });
    this.emitProjectEvents();
    this.emitHistory();
  }

  /** 当前会话令牌（异步导入等流程在恢复执行后校验所属会话） */
  getSessionToken(): number {
    return this.sessionToken;
  }

  /** token 是否仍为当前会话 */
  isCurrentSession(token: number): boolean {
    return token === this.sessionToken;
  }

  /**
   * 释放编辑器（不可逆终态）：runtime 卸载（组件 unmount）时调用。
   * 在任何同步事件发出前进入不可重入终态：置终态标记、递增会话令牌（在途异步导入
   * 校验失败、取消提交）、清空历史与拖动事务、置空状态，最后永久关闭事件总线
   * （on/once/onAny 此后一律抛「事件总线已关闭」）。dispose 自身不发出任何事件。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionToken += 1;
    this.mutationVersion += 1;
    this.history.clear();
    this.dragSnapshot = null;
    this.project = null;
    this.selection = [];
    this.view = freshDefaultView();
    this.events.dispose();
  }

  // ---------- 选择 ----------

  setSelection(ids: string[]): void {
    const version = this.mutationVersion;
    const project = this.project;
    // 选择严格限定在活动场景可达集内：跨场景对象不可选中；重复 ID 首次出现去重（R8-8）。
    // 读取 ids 期间可能触发 getter 副作用（dispose/嵌套写），读取后必须复验版本（R10-M1）
    const next = project ? this.filterSelection(project, ids) : [];
    if (this.disposed || this.mutationVersion !== version) return;
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.mutationVersion += 1;
    this.events.emit('selection:changed', { ids: this.getSelection() });
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  // ---------- 场景操作（历史可撤销） ----------

  addScene(name: string): Result<string> {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const scene = { id: genId('scene'), name: name || '场景', rootObjectIds: [], activeCameraId: null };
    // after.selection 默认沿用当前选择，pushEntry 按新场景可达集过滤（空场景 → 空选择）
    const result = this.commit(
      baseline,
      { ...project, scenes: [...project.scenes, scene], activeSceneId: scene.id },
      `新建场景 ${scene.name}`,
    );
    if (!result.ok) return result;
    return { ok: true, value: scene.id };
  }

  setActiveScene(sceneId: string): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    if (!getScene(project, sceneId)) return failure('场景不存在');
    if (project.activeSceneId === sceneId) return { ok: true };
    // 同一历史快照内，选择与场景切换原子一致：快照 after.selection 与活动场景同步
    const reachable = getReachableIds(project, sceneId);
    const filteredSelection = baseline.selection.filter((id) => reachable.has(id));
    const result = this.commit(
      baseline,
      { ...project, activeSceneId: sceneId },
      '切换场景',
      filteredSelection,
    );
    // 机位视图按活动场景隔离：transition 从下一个项目推导（机位不可达 → 导演视图）
    return result;
  }

  setActiveCamera(objectId: string | null): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) return failure('场景不存在');
    if (objectId !== null) {
      const object = findObject(project, objectId);
      if (!object || object.type !== 'camera') return failure('机位对象不存在');
      // 机位必须属于活动场景可达集：跨场景机位不可设（多场景隔离）
      if (!isInActiveScene(project, objectId)) return failure('机位不属于活动场景');
    }
    if (scene.activeCameraId === objectId) return { ok: true };
    const scenes = project.scenes.map((s) =>
      s.id === scene.id ? { ...s, activeCameraId: objectId } : s,
    );
    return this.commit(baseline, { ...project, scenes }, '设置机位');
  }

  /** 新增对象（挂到当前场景根部并选中） */
  addObject(object: SceneObjectData): Result<string> {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const owned = this.own(object); // 无条件克隆为编辑器自有数据（R6）
    // 输入对象 getter 可能 dispose/嵌套 openProject（R9-M1）：克隆后复验基线
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (!isSceneObject(owned) || owned.parentId !== null) return failure('对象数据不合法');
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) return failure('场景不存在');
    const scenes = project.scenes.map((s) =>
      s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, owned.id] } : s,
    );
    const result = this.commit(
      baseline,
      { ...project, scenes, objects: [...project.objects, owned] },
      `创建 ${owned.name}`,
      [owned.id],
    );
    if (!result.ok) return result;
    return { ok: true, value: owned.id };
  }

  /** 删除选中对象（含子树）；子树含锁定对象时拒绝（FR-002） */
  deleteSelection(): Result<{ removed: number }> {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const ids = new Set<string>();
    for (const id of baseline.selection) {
      // 归属校验（防御）：选择已按活动场景过滤，此处再确认对象属于活动场景
      if (findObject(project, id) && isInActiveScene(project, id)) {
        ids.add(id);
        for (const descendant of getDescendantIds(project, id)) ids.add(descendant);
      }
    }
    if (ids.size === 0) return { ok: true, value: { removed: 0 } };
    const locked = project.objects.filter((o) => ids.has(o.id) && o.locked);
    if (locked.length > 0) {
      return failure(`无法删除：子树包含 ${locked.length} 个锁定对象（如「${locked[0]!.name}」）`);
    }
    const removed = ids.size;
    let next = removeObjects(project, ids);
    const unreferenced = new Set(collectUnreferencedAssets(next).map((a) => a.id));
    next = removeAssets(next, unreferenced);
    const parentId = baseline.selection
      .map((id) => findObject(project, id)?.parentId)
      .find((pid): pid is string => !!pid);
    const result = this.commit(baseline, next, `删除 ${removed} 个对象`, parentId ? [parentId] : []);
    // 被删机位（含场景归属变化）：transition 从下一个项目推导回退导演视图
    if (!result.ok) return result;
    return { ok: true, value: { removed } };
  }

  /** 复制选中对象子树；同一组内的后代不重复复制（FR-002）。
   *  选择先去重（R8-8）：重复 root 会产生第二个副本 run，而 indexOf 只取
   *  首个下标 → 副本被丢弃但 ID 仍进返回列表（指向不存在的对象）。 */
  duplicateSelection(): Result<{ ids: string[] }> {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const selection = this.dedupeSelection(baseline.selection);
    // 复制根筛选收敛（R11-1 #7）：旧实现对每个选中 id 重建可达集
    // （isInActiveScene）并逐对重建 byId Map（isInSubtree）→ 平级根全选 O(n³)。
    // 子树闭包性质：选中对象的祖先链必在活动场景可达集内，故从场景根单次 DFS
    // 传播「已有选中祖先」即可定根；不可达/不存在的选中 id 天然不进 rootsSet
    // （保持 findObject + isInActiveScene 过滤语义），selection 原序保序输出。
    const scene = getScene(project, project.activeSceneId);
    const idMap = new Map<string, string>();
    const runs: SceneObjectData[][] = [];
    // 一次 childrenOf 索引在全部复制根间共享：替代逐层 project.objects.filter，
    // 深链不爆栈（迭代栈，R9-M2）
    const childrenOf = new Map<string | null, string[]>();
    for (const object of project.objects) {
      const list = childrenOf.get(object.parentId);
      if (list) list.push(object.id);
      else childrenOf.set(object.parentId, [object.id]);
    }
    // 一次 byId 索引在全部复制根间共享：替代 duplicateSubtree 逐节点 findObject
    // 全量扫描（复制 n 节点链 ≈ n²/2 次谓词执行，R10-M3 #7）
    const byId = new Map(project.objects.map((object) => [object.id, object]));
    const selected = new Set(selection);
    const rootsSet = new Set<string>();
    // 已见集防循环引用（与 getReachableIds 同语义）；栈元素 [id, 父链是否含选中对象]
    const seen = new Set<string>();
    const stack: Array<[string, boolean]> = (scene?.rootObjectIds ?? []).map((id) => [id, false]);
    while (stack.length > 0) {
      const [id, hasSelectedAncestor] = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!byId.has(id)) continue; // 幽灵根：不参与定根（findObject 过滤语义）
      if (selected.has(id) && !hasSelectedAncestor) rootsSet.add(id);
      const children = childrenOf.get(id);
      if (children) {
        const next = hasSelectedAncestor || selected.has(id);
        for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, next]);
      }
    }
    const roots = selection.filter((id) => rootsSet.has(id));
    if (roots.length === 0) return { ok: true, value: { ids: [] } };

    for (const rootId of roots) {
      const run: SceneObjectData[] = [];
      this.duplicateSubtree(rootId, idMap, run, childrenOf, byId);
      runs.push(run);
    }
    const newRootIds = runs.map((run) => run[0]!.id);
    // 层级不变量：parentId === null ⇔ 恰好出现在一个场景的根列表中。
    // 子对象副本沿用原 parentId（原父被复制时映射到副本父），不进入根列表
    const rootCopies = runs
      .filter((run) => run[0]!.parentId === null)
      .map((run) => run[0]!.id);

    // 副本树紧随原对象之后插入（root→run Map 替代 roots.indexOf，O(1) 每对象）
    const runsByRoot = new Map<string, SceneObjectData[]>();
    roots.forEach((id, i) => runsByRoot.set(id, runs[i]!));
    const objects: SceneObjectData[] = [];
    for (const object of project.objects) {
      objects.push(object);
      const run = runsByRoot.get(object.id);
      if (run) objects.push(...run);
    }
    const scenes = scene
      ? project.scenes.map((s) =>
          s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, ...rootCopies] } : s,
        )
      : project.scenes;

    const result = this.commit(baseline, { ...project, objects, scenes }, `复制 ${newRootIds.length} 个对象`, newRootIds);
    if (!result.ok) return result;
    return { ok: true, value: { ids: newRootIds } };
  }

  /** 调整父子层级；拒绝父子循环与锁定对象（FR-002 异常处理） */
  setParent(objectId: string, parentId: string | null): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    if (object.locked) return failure(`「${object.name}」已锁定，无法变更层级`);
    if (parentId !== null) {
      const parent = findObject(project, parentId);
      if (!parent) return failure('目标父对象不存在');
      // 目标父级必须属于活动场景：跨场景挂载会破坏可达集不变量
      if (!isInActiveScene(project, parentId)) return failure('目标父对象不属于活动场景');
      if (isInSubtree(project, parentId, objectId)) {
        return failure('无法挂载：目标处于自身子树内（父子循环）');
      }
    }
    if (object.parentId === parentId) return { ok: true };
    const next = updateObject(project, objectId, (o) => ({ ...o, parentId }));
    // 层级不变量：parentId === null ⇔ 恰好出现在一个场景的根列表中 ——
    // 挂到父级时从所有场景根列表移除；提为根时也从所有场景根列表移除
    // （对象只会归属当前活动场景），再挂入活动场景根列表
    const scenes = project.scenes.map((s) =>
      s.rootObjectIds.includes(objectId)
        ? { ...s, rootObjectIds: s.rootObjectIds.filter((id) => id !== objectId) }
        : s,
    );
    if (parentId === null) {
      const scene = project.scenes.find((s) => s.id === project.activeSceneId);
      if (scene) {
        return this.commit(
          baseline,
          {
            ...next,
            scenes: scenes.map((s) =>
              s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, objectId] } : s,
            ),
          },
          `调整「${object.name}」层级`,
        );
      }
    }
    return this.commit(baseline, { ...next, scenes }, `调整「${object.name}」层级`);
  }

  /** 设置变换（数值属性编辑 / 数值输入提交），拒绝非法数值与锁定对象 */
  setTransform(objectId: string, transform: TransformData, label = '设置变换'): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    if (object.locked) return failure(`「${object.name}」已锁定，无法变换`);
    // 先复制外部数组为自有数据、再复验基线：元素 getter 的副作用窗口必须先被捕获
    // （getter 内 dispose/嵌套提交后不得用旧基线继续提交），再对自有副本做数值校验
    const ownedTransform = this.ownTransform(transform);
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (!isValidTransform(ownedTransform)) return failure('数值非法（不允许 NaN/Infinity）');
    return this.commit(
      baseline,
      updateObject(project, objectId, (o) => ({ ...o, transform: ownedTransform })),
      label,
    );
  }

  /**
   * 一次 Gizmo 拖动：捕获拖动前快照。
   * 项目为 owned immutable（每次变更产生新 Project，旧引用递归冻结、永不改变），
   * 因此直接持有冻结引用即可作为拖动前状态——不做结构化克隆，
   * 避免复制/序列化完整二进制 payload（大模型历史步骤与撤销无重负担）。
   */
  beginTransform(): void {
    const project = this.project;
    if (project) this.dragSnapshot = { project, selection: [...this.selection] };
  }

  /** 拖动结束提交：应用最终变换并推入历史（无变化则不推，AC：一次拖动一步） */
  commitTransform(objectId: string, transform: TransformData, label = '变换对象'): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    if (object.locked) {
      this.dragSnapshot = null;
      return failure(`「${object.name}」已锁定，无法变换`);
    }
    // 先复制外部数组为自有数据、再复验基线：元素 getter 的副作用窗口必须先被捕获
    const ownedTransform = this.ownTransform(transform);
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (!isValidTransform(ownedTransform)) return failure('数值非法（不允许 NaN/Infinity）');
    const next = updateObject(project, objectId, (o) => ({ ...o, transform: ownedTransform }));
    const before = this.dragSnapshot;
    this.dragSnapshot = null;
    const current: EditorSnapshot = { project, selection: [...baseline.selection] };
    // 拖动事务绑定基准：拖动期间项目被其他操作变更（并发编辑/撤销/重做）时，
    // 不得吞并并发编辑 —— 基于当前项目重建仅含本次 transform 的历史项
    // （并发编辑仍留在历史中，undo 时两者分开回退）
    if (before && before.project !== project) {
      if (this.sameTransform(project, next, objectId)) return { ok: true };
      return this.commitEntry(label, current, next, current.selection, baseline);
    }
    // 局部比较（仅目标对象三向量），不做整项目 JSON 序列化
    if (this.sameTransform(before?.project ?? project, next, objectId)) return { ok: true };
    return this.commitEntry(label, before ?? current, next, current.selection, baseline);
  }

  /**
   * 通用属性更新（名称/材质/灯光/摄像机/几何体等），可撤销。
   * updater 收到结构化克隆的工作副本：原地篡改（改 id/type/transform）不可能污染编辑器
   * 状态；返回结果再做结构标识、锁定（按变换值比较）与完整 schema 校验后提交。
   */
  updateObjectProps(
    objectId: string,
    updater: (object: SceneObjectData) => SceneObjectData | null,
    label: string,
  ): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    // 外部回调可能 dispose/嵌套提交/openProject：回调后必须复验基线（R8），
    // 否则外层会把已释放编辑器复活、或用回调前的旧快照覆盖内层结果
    const nextObject = updater(structuredClone(object));
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (!nextObject) return failure('属性值非法');
    if (nextObject.id !== object.id || nextObject.type !== object.type) {
      return failure('结构标识（id/type）不可修改');
    }
    // 锁定校验按变换值比较：克隆副本引用必然不同，引用比较会误伤只读变换的更新（改名等）
    if (!sameTransformData(nextObject.transform, object.transform) && object.locked) {
      return failure(`「${object.name}」已锁定，无法变换`);
    }
    if (nextObject.parentId !== object.parentId) {
      return failure('层级变更请使用拖拽或层级操作');
    }
    const problem = validateSceneObjectData(nextObject);
    if (problem) return failure('属性值非法');
    // 返回对象可能嵌入调用方持有的嵌套结构：克隆为编辑器自有数据后再提交，
    // 不就地冻结调用方对象（R6）；返回对象 getter 也可能副作用变更编辑器（R8），
    // 克隆后再次复验基线
    const owned = this.own(nextObject);
    const reenteredClone = this.guardReentry(baseline);
    if (reenteredClone) return reenteredClone;
    return this.commit(baseline, updateObject(project, objectId, () => owned), label);
  }

  setVisible(ids: string[], visible: boolean): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    // 归属校验（防御）：只影响活动场景内的对象。
    // ids 读取（filter/Set 枚举）期间可能触发 getter 副作用：复验后再走快路（R10-M1）
    const idSet = new Set(ids.filter((id) => isInActiveScene(project, id)));
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (idSet.size === 0) return { ok: true };
    const next = {
      ...project,
      objects: project.objects.map((o) => (idSet.has(o.id) ? { ...o, visible } : o)),
    };
    return this.commit(baseline, next, visible ? '显示对象' : '隐藏对象');
  }

  setLocked(ids: string[], locked: boolean): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    // 归属校验（防御）：只影响活动场景内的对象。
    // ids 读取（filter/Set 枚举）期间可能触发 getter 副作用：复验后再走快路（R10-M1）
    const idSet = new Set(ids.filter((id) => isInActiveScene(project, id)));
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (idSet.size === 0) return { ok: true };
    const next = {
      ...project,
      objects: project.objects.map((o) => (idSet.has(o.id) ? { ...o, locked } : o)),
    };
    return this.commit(baseline, next, locked ? '锁定对象' : '解锁对象');
  }

  /** 注册资源并按哈希去重；作为一步历史（撤销导入时资源一并移除，无孤儿资源） */
  registerAsset(asset: AssetData): Result<{ asset: AssetData; deduped: boolean }> {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    // own 先行：asset 字段（含 hash）的读取必须发生在复验之前——getter 副作用
    // （dispose/嵌套写）后不得再走 dedupe 快路返回成功（R10-M1）
    const owned = this.own(asset); // 无条件克隆为编辑器自有数据（R6）
    const reentered = this.guardReentry(baseline); // 克隆 getter 副作用（R8）
    if (reentered) return reentered;
    const existing = findAssetByHash(project, owned.hash);
    if (existing) return { ok: true, value: { asset: existing, deduped: true } };
    const result = this.commit(baseline, addAsset(project, owned), `注册资源 ${owned.name}`);
    if (!result.ok) return result;
    return { ok: true, value: { asset: owned, deduped: false } };
  }

  /** 导入模型 = 注册资源 + 创建模型对象，作为一步历史 */
  importModel(asset: AssetData, object: SceneObjectData): Result<string> {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    const project = baseline.project!; // beginIngress 已保证非空（disposed/无项目返回 null）
    const ownedAsset = this.own(asset);
    const ownedObject = this.own(object); // 无条件克隆为编辑器自有数据（R6）
    const reentered = this.guardReentry(baseline); // 克隆 getter 副作用（R8）
    if (reentered) return reentered;
    if (!isSceneObject(ownedObject) || ownedObject.parentId !== null) return failure('对象数据不合法');
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) return failure('场景不存在');
    const existing = findAssetByHash(project, ownedAsset.hash);
    const effectiveAsset = existing ?? ownedAsset;
    // 同 hash 重复导入统一引用有效资源：无论调用方带什么 assetId，
    // 落库对象一律指向实际生效的资源（可能是已存在的去重资源）
    const normalizedObject: SceneObjectData = { ...ownedObject, assetId: effectiveAsset.id };
    const scenes = project.scenes.map((s) =>
      s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, normalizedObject.id] } : s,
    );
    const next: Project = {
      ...project,
      scenes,
      objects: [...project.objects, normalizedObject],
      assets: existing ? project.assets : [...project.assets, effectiveAsset],
    };
    const result = this.commit(baseline, next, `导入模型 ${normalizedObject.name}`, [normalizedObject.id]);
    if (!result.ok) return result;
    return { ok: true, value: normalizedObject.id };
  }

  // ---------- 视口 UI 状态（不进历史） ----------

  setTransformMode(mode: TransformMode): void {
    const baseline = this.captureViewBaseline();
    // 视图写不读取任何外部输入（mode 为字符串字面量），基线捕获与复验之间无外部窗口
    if (this.guardViewReentry(baseline)) return;
    if (this.view.transformMode === mode) return;
    this.view = { ...this.view, transformMode: mode };
    this.mutationVersion += 1;
    this.events.emit('view:changed', { view: this.getView() });
  }

  setTransformSpace(space: TransformSpace): void {
    const baseline = this.captureViewBaseline();
    if (this.guardViewReentry(baseline)) return;
    if (this.view.transformSpace === space) return;
    this.view = { ...this.view, transformSpace: space };
    this.mutationVersion += 1;
    this.events.emit('view:changed', { view: this.getView() });
  }

  setViewMode(mode: ViewMode): void {
    const baseline = this.captureViewBaseline();
    // 参数复制为自有数据：调用方事后改 mode 对象不影响编辑器（R6）。
    // mode 读取（cameraObjectId getter）是外部窗口：复验后再做校验与写入（R10-M1）
    let owned: ViewMode =
      mode === 'director' ? 'director' : { cameraObjectId: mode.cameraObjectId };
    if (this.guardViewReentry(baseline)) return;
    // 机位视图按活动场景隔离：机位不存在/不是相机/不属于活动场景 → 一律回退导演视图
    if (owned !== 'director') {
      const project = this.project;
      const cameraId = owned.cameraObjectId;
      const camera = project ? findObject(project, cameraId) : undefined;
      if (!camera || camera.type !== 'camera' || !isInActiveScene(project!, cameraId)) {
        owned = 'director';
      }
    }
    const same =
      this.view.viewMode === owned ||
      (this.view.viewMode !== 'director' &&
        owned !== 'director' &&
        this.view.viewMode.cameraObjectId === owned.cameraObjectId);
    if (same) return;
    this.view = { ...this.view, viewMode: owned };
    this.mutationVersion += 1;
    this.events.emit('view:changed', { view: this.getView() });
  }

  setGuide(kind: 'thirds' | 'safeFrame', enabled: boolean): void {
    const baseline = this.captureViewBaseline();
    if (this.guardViewReentry(baseline)) return;
    // 同值 no-op（R11-3，对齐 setViewMode same 检查）：不推进事务版本、
    // 不 emit——updater 内嵌套同值调用不背止外层合法提交
    if (this.view.guides[kind] === enabled) return;
    this.view = { ...this.view, guides: { ...this.view.guides, [kind]: enabled } };
    this.mutationVersion += 1;
    this.events.emit('view:changed', { view: this.getView() });
  }

  // ---------- 撤销/重做 ----------

  undo(): Result {
    const snapshot = this.history.peekUndo();
    if (!snapshot) return failure('没有可撤销的操作');
    return this.applyHistorySnapshot(snapshot.before, 'undo');
  }

  redo(): Result {
    const snapshot = this.history.peekRedo();
    if (!snapshot) return failure('没有可重做的操作');
    return this.applyHistorySnapshot(snapshot.after, 'redo');
  }

  // ---------- 内部 ----------

  /**
   * 入口事务基线捕获（R9-M1）：disposed/无项目时返回 null（一切写入都以
   * 「未打开项目」拒绝，无晚到提交）。所有公开写入口先 beginIngress 捕获
   * {project, epoch, session}，外部窗口（克隆/回调/getter）后 guardReentry 复验。
   */
  private beginIngress(): Baseline | null {
    if (this.disposed || !this.project) return null;
    return {
      project: this.project,
      selection: [...this.selection],
      version: this.mutationVersion,
      session: this.sessionToken,
    };
  }

  /**
   * 基线复验（R9-M1，幂等）：编辑器被 dispose、会话切换或任何状态写
   * （嵌套提交/嵌套 openProject/undo/redo 的 swapState，以及嵌套 selection/
   * 视图写——R10-M1 起全部写都递增 mutationVersion）都使本次操作失效——
   * 不得移动历史、不得覆盖内层结果、不得复活已释放编辑器。
   */
  private guardReentry(baseline: Baseline): { ok: false; error: Error } | null {
    if (this.disposed) return { ok: false, error: new Error('编辑器已释放') };
    if (
      this.sessionToken !== baseline.session ||
      this.mutationVersion !== baseline.version ||
      this.project !== baseline.project
    ) {
      return { ok: false, error: new Error('编辑器状态已变更，操作被取消') };
    }
    return null;
  }

  /** 视图写入口的轻量基线捕获（R10-M1）：版本号 + 视图快照（不含 project/session） */
  private captureViewBaseline(): ViewBaseline {
    return { version: this.mutationVersion, view: this.getView() };
  }

  /**
   * 视图基线复验（R10-M1，幂等）：dispose 或任何状态写（嵌套视图写/嵌套提交/
   * openProject/undo/redo）都使本次视图写失效——不得覆盖内层写入结果。
   * 视图快照按值比较兜底：即使某处视图写漏递增版本，也能被捕获。
   */
  private guardViewReentry(baseline: ViewBaseline): boolean {
    if (this.disposed) return true;
    if (this.mutationVersion !== baseline.version) return true;
    return !sameViewState(this.view, baseline.view);
  }

  /** 公开 ingress 的统一收口：克隆为编辑器自有数据再递归冻结（R6）。
   *  校验与冻结都发生在自有副本上，调用方持有的对象永不被就地冻结、永不被别名。 */
  private own<T>(value: T): T {
    return deepFreeze(structuredClone(value));
  }

  /** transform 参数收口：三向量数组复制为自有数据（不复制整个对象） */
  private ownTransform(transform: TransformData): TransformData {
    return {
      position: [...transform.position],
      rotation: [...transform.rotation],
      scale: [...transform.scale],
    };
  }

  /** 复制一棵子树（迭代栈 + 共享 childrenOf/byId 索引，R9-M2 + R10-M3 #7）：
   *  先序 parent-first、子节点按原插入顺序（逆序入栈），6000 层链不爆栈；
   *  原对象经共享 byId 索引取（O(1)），不再逐节点 findObject 全量扫描 */
  private duplicateSubtree(
    rootId: string,
    idMap: Map<string, string>,
    run: SceneObjectData[],
    childrenOf: Map<string | null, string[]>,
    byId: Map<string, SceneObjectData>,
  ): void {
    const stack: string[] = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const original = byId.get(id);
      if (!original) continue;
      const copy: SceneObjectData = {
        ...original,
        id: genId('obj'),
        parentId: original.parentId ? (idMap.get(original.parentId) ?? original.parentId) : null,
        name: `${original.name} 副本`,
      };
      idMap.set(id, copy.id);
      run.push(copy);
      const children = childrenOf.get(id);
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
      }
    }
  }

  private commit(baseline: Baseline, project: Project, label: string, afterSelection?: string[]): Result {
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    const before: EditorSnapshot = { project: baseline.project!, selection: [...baseline.selection] };
    return this.commitEntry(label, before, project, afterSelection ?? baseline.selection, baseline);
  }

  /**
   * 原子提交：背止复验 → stamp（校验 + 单调 revision + 冻结）→ 推入历史 →
   * 换入 → 发事件。候选状态校验失败时抛错被转换为失败结果，状态与历史游标
   * 均保持原样。事件按固定顺序 project → selection → view → history 发出，
   * 观察者不会看到「新项目 + 旧场景选择/旧机位」的跨场景中间态。
   */
  private commitEntry(
    label: string,
    before: EditorSnapshot,
    afterProject: Project,
    afterSelection: string[],
    baseline: Baseline,
  ): Result {
    // 背止（R9-M1）：提交时刻再次复验基线——入口内的任何外部窗口（嵌套提交的
    // swapState 已使 epoch 递增）或 dispose 都会在这里被拦截，杜绝晚到提交
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    let stamped: Project;
    try {
      stamped = this.stampAndFreeze(afterProject);
    } catch (error) {
      return failure(error instanceof Error ? error.message : '提交失败');
    }
    const after: EditorSnapshot = {
      project: stamped,
      selection: this.filterSelection(stamped, afterSelection),
    };
    this.history.push({ label, before, after });
    this.swapState(stamped, after.selection);
    this.emitProjectEvents();
    this.emitHistory();
    return { ok: true };
  }

  /** 撤销/重做：peek 目标 → 盖章（失败时游标不动、状态不变）→ 复验 → 游标提交 → 换入 → 发事件 */
  private applyHistorySnapshot(snapshot: EditorSnapshot, move: 'undo' | 'redo'): Result {
    const baseline = this.beginIngress();
    if (!baseline) return failure('未打开项目');
    let stamped: Project;
    try {
      stamped = this.stampAndFreeze({ ...snapshot.project });
    } catch (error) {
      return failure(error instanceof Error ? error.message : '应用历史快照失败');
    }
    const reentered = this.guardReentry(baseline);
    if (reentered) return reentered;
    if (move === 'undo') this.history.commitUndo();
    else this.history.commitRedo();
    this.swapState(stamped, snapshot.selection);
    this.emitProjectEvents();
    this.emitHistory();
    return { ok: true };
  }

  /** 首次出现去重（保持顺序）：选择/历史快照中的 ID 不重复（R8-8） */
  private dedupeSelection(ids: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  /** 选择按项目活动场景可达集过滤：跨场景/已删除对象不可选中；去重后过滤（R8-8）。
   *  可达集一次构建共享给全部候选（替代逐 id isInActiveScene 重建索引，
   *  n 选 k 从 O(n·k) 收敛到 O(n)，R11-1） */
  private filterSelection(project: Project, ids: string[]): string[] {
    const reachable = getReachableIds(project, project.activeSceneId);
    return this.dedupeSelection(ids).filter(
      (id) => findObject(project, id) && reachable.has(id),
    );
  }

  /** 状态换入：项目/选择/视图一次就位（不发事件；事件由调用方按固定顺序发出） */
  private swapState(
    project: Project | null,
    selection: string[],
    opts: { resetView?: boolean } = {},
  ): void {
    this.mutationVersion += 1;
    this.project = project;
    this.selection = project ? this.filterSelection(project, selection) : [];
    this.view = opts.resetView || !project ? freshDefaultView() : this.deriveView(project);
  }

  /** 固定顺序广播当前状态快照：project → selection → view */
  private emitProjectEvents(): void {
    this.events.emit('project:changed', { project: this.project });
    this.events.emit('selection:changed', { ids: this.getSelection() });
    this.events.emit('view:changed', { view: this.getView() });
  }

  /**
   * 候选状态盖章：完整校验（schema + 结构）→ 单调 revision → 深度冻结。
   * 校验失败抛错且无任何副作用：调用方（提交/撤销/重做）据此保证
   * 「失败时状态与历史游标均不变」。
   */
  private stampAndFreeze(candidate: Project): Project {
    this.validateProject(candidate);
    return deepFreeze({ ...candidate, revision: ++this.revisionCounter });
  }

  /** 机位视图从下一个项目推导：机位不存在/不是相机/不属于活动场景 → 导演视图 */
  private deriveView(project: Project): ViewState {
    if (this.view.viewMode === 'director') return this.view;
    const cameraId = this.view.viewMode.cameraObjectId;
    const camera = findObject(project, cameraId);
    if (!camera || camera.type !== 'camera' || !isInActiveScene(project, cameraId)) {
      return { ...this.view, viewMode: 'director' };
    }
    return this.view;
  }

  /**
   * 项目校验（O(n)：对象索引 + 三色 parent 链检测，不做整项目扫描）：
   * 完整 schema 与有限数值校验（validateProjectSchema）→ 父引用存在 →
   * 父子循环 → 根列表一致性（parentId === null ⇔ 恰好出现在一个场景根列表）→
   * 活动场景与活动机位可达性。不合法即抛错（openProject 同步失败；
   * 提交路径为编辑器自身不变量的防御性校验）。
   */
  private validateProject(project: Project): void {
    const schemaProblem = validateProjectSchema(project);
    if (schemaProblem) throw new Error(schemaProblem);
    const byId = new Map<string, SceneObjectData>();
    for (const object of project.objects) {
      if (byId.has(object.id)) throw new Error(`对象数据不合法：${object.id}`);
      byId.set(object.id, object);
    }
    for (const object of project.objects) {
      if (object.parentId !== null && !byId.has(object.parentId)) {
        throw new Error(`对象缺少父级：${object.id}`);
      }
    }
    // 三色循环检测（O(n) 摊还）：顺序遍历 parent 链，路径内重复即循环；
    // 已确认无环（'ok'）的链直接复用，不重复走
    const status = new Map<string, 'in-progress' | 'ok'>();
    for (const object of project.objects) {
      const path: string[] = [];
      let cursor: SceneObjectData | undefined = object;
      while (cursor && cursor.parentId !== null) {
        const s = status.get(cursor.id);
        if (s === 'ok') break;
        if (s === 'in-progress') throw new Error(`父子关系存在循环：${cursor.id}`);
        status.set(cursor.id, 'in-progress');
        path.push(cursor.id);
        cursor = byId.get(cursor.parentId);
      }
      for (const id of path) status.set(id, 'ok');
    }
    // 根列表一致性：rootObjectIds 引用合法根对象；每个根对象恰好出现一次
    const rootCount = new Map<string, number>();
    for (const scene of project.scenes) {
      for (const rootId of scene.rootObjectIds) {
        const root = byId.get(rootId);
        if (!root || root.parentId !== null) throw new Error(`场景根列表引用非法：${rootId}`);
        rootCount.set(rootId, (rootCount.get(rootId) ?? 0) + 1);
      }
    }
    for (const object of project.objects) {
      if (object.parentId === null && !rootCount.has(object.id)) {
        throw new Error(`孤立根对象：${object.id}`);
      }
    }
    for (const [rootId, count] of rootCount) {
      if (count > 1) throw new Error(`根对象重复挂载：${rootId}`);
    }
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) throw new Error('活动场景不存在');
    // 所有场景的 activeCameraId 都必须指向本场景可达的相机（R6：非活动场景同样校验）
    for (const s of project.scenes) {
      if (s.activeCameraId === null) continue;
      const camera = byId.get(s.activeCameraId);
      if (!camera || camera.type !== 'camera') {
        throw new Error(`场景「${s.name}」的机位不存在或不是相机`);
      }
      if (!this.isReachableFrom(s.rootObjectIds, project.objects, s.activeCameraId)) {
        throw new Error(`场景「${s.name}」的机位不属于该场景`);
      }
    }
  }

  /** 从场景根列表出发（DFS，按父级索引）目标是否可达 */
  private isReachableFrom(roots: string[], objects: SceneObjectData[], target: string): boolean {
    const childrenOf = new Map<string, string[]>();
    for (const object of objects) {
      if (object.parentId === null) continue;
      const list = childrenOf.get(object.parentId);
      if (list) list.push(object.id);
      else childrenOf.set(object.parentId, [object.id]);
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === target) return true;
      for (const childId of childrenOf.get(id) ?? []) stack.push(childId);
    }
    return false;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('编辑器已释放');
  }

  /** 拖动前后是否等价：仅比较目标对象三向量（局部比较，不序列化项目） */
  private sameTransform(a: Project, b: Project, objectId: string): boolean {
    const aObject = findObject(a, objectId);
    const bObject = findObject(b, objectId);
    if (!aObject || !bObject) return false;
    return sameTransformData(aObject.transform, bObject.transform);
  }

  private emitHistory(): void {
    this.events.emit('history:changed', this.getHistoryState());
  }
}
