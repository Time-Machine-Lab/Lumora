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

function failure(message: string): Result<never> {
  return { ok: false, error: new Error(message) };
}

/**
 * 核心 3D 场景编辑器（框架无关）：
 * - 持有项目、选择与视口 UI 状态；项目为不可变数据，所有变更经历史栈提交
 * - 锁定对象不可变换/删除/变更层级；NaN/Infinity 数值拒绝
 * - 一次 Gizmo 拖动 = 一个历史步骤（beginTransform/commitTransform 成对）
 */
export class SceneEditor {
  readonly events = new TypedEventEmitter<EditorEventMap>();

  private project: Project | null = null;
  private selection: string[] = [];
  private view: ViewState = { ...DEFAULT_VIEW, guides: { ...DEFAULT_VIEW.guides } };
  private history = new HistoryStack<EditorSnapshot>();
  /** beginTransform 捕获的拖动前快照 */
  private dragSnapshot: EditorSnapshot | null = null;
  /** 会话令牌：openProject/reset/dispose 时递增；异步流程据此绑定所属项目会话 */
  private sessionToken = 0;
  /** 已释放（runtime dispose）：任何写入/提交一律拒绝 */
  private disposed = false;
  /** 每次应用状态的单调序号（openProject/提交/撤销/重做各取新值） */
  private revisionCounter = 0;

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
    return { ...this.view, guides: { ...this.view.guides } };
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
    // 保持传入引用不变（宿主快照契约：getProject() 返回打开时的项目对象）；
    // 单调序号从项目持久化 revision 起步，后续每次应用状态（提交/撤销/重做）严格递增
    this.assertAlive();
    this.validateProject(project);
    this.revisionCounter = project.revision;
    this.history.clear();
    this.dragSnapshot = null;
    this.sessionToken += 1;
    this.transition(project, { selection: [], resetView: true, seedRevision: true });
    this.emitHistory();
  }

  reset(): void {
    this.assertAlive();
    this.history.clear();
    this.dragSnapshot = null;
    this.sessionToken += 1;
    this.transition(null, { resetView: true });
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
   * 原子关闭（project/selection/view 一次就位，发出 close 事件）后置终态标记、
   * 递增会话令牌（在途异步导入校验失败、取消提交）、清空历史并永久关闭事件总线；
   * 之后一切公开变更器拒绝 —— 卸载后不得有晚到写入。
   */
  dispose(): void {
    if (this.disposed) return;
    this.transition(null, { resetView: true });
    this.disposed = true;
    this.sessionToken += 1;
    this.history.clear();
    this.dragSnapshot = null;
    this.events.clear();
  }

  // ---------- 选择 ----------

  setSelection(ids: string[]): void {
    if (this.disposed) return;
    const project = this.project;
    // 选择严格限定在活动场景可达集内：跨场景对象不可选中
    const next = project
      ? ids.filter((id) => findObject(project, id) && isInActiveScene(project, id))
      : [];
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.events.emit('selection:changed', { ids: this.getSelection() });
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  // ---------- 场景操作（历史可撤销） ----------

  addScene(name: string): Result<string> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const scene = { id: genId('scene'), name: name || '场景', rootObjectIds: [], activeCameraId: null };
    // after.selection 默认沿用当前选择，pushEntry 按新场景可达集过滤（空场景 → 空选择）
    const result = this.commit(
      { ...project, scenes: [...project.scenes, scene], activeSceneId: scene.id },
      `新建场景 ${scene.name}`,
    );
    if (!result.ok) return result;
    return { ok: true, value: scene.id };
  }

  setActiveScene(sceneId: string): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    if (!getScene(project, sceneId)) return failure('场景不存在');
    if (project.activeSceneId === sceneId) return { ok: true };
    // 同一历史快照内，选择与场景切换原子一致：快照 after.selection 与活动场景同步
    const reachable = getReachableIds(project, sceneId);
    const filteredSelection = this.selection.filter((id) => reachable.has(id));
    const result = this.commit(
      { ...project, activeSceneId: sceneId },
      '切换场景',
      filteredSelection,
    );
    // 机位视图按活动场景隔离：transition 从下一个项目推导（机位不可达 → 导演视图）
    return result;
  }

  setActiveCamera(objectId: string | null): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
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
    return this.commit({ ...project, scenes }, '设置机位');
  }

  /** 新增对象（挂到当前场景根部并选中） */
  addObject(object: SceneObjectData): Result<string> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    if (!isSceneObject(object) || object.parentId !== null) return failure('对象数据不合法');
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) return failure('场景不存在');
    const scenes = project.scenes.map((s) =>
      s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, object.id] } : s,
    );
    const result = this.commit(
      { ...project, scenes, objects: [...project.objects, object] },
      `创建 ${object.name}`,
      [object.id],
    );
    if (!result.ok) return result;
    return { ok: true, value: object.id };
  }

  /** 删除选中对象（含子树）；子树含锁定对象时拒绝（FR-002） */
  deleteSelection(): Result<{ removed: number }> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const ids = new Set<string>();
    for (const id of this.selection) {
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
    const parentId = this.selection
      .map((id) => findObject(project, id)?.parentId)
      .find((pid): pid is string => !!pid);
    const result = this.commit(next, `删除 ${removed} 个对象`, parentId ? [parentId] : []);
    // 被删机位（含场景归属变化）：transition 从下一个项目推导回退导演视图
    if (!result.ok) return result;
    return { ok: true, value: { removed } };
  }

  /** 复制选中对象子树；同一组内的后代不重复复制（FR-002） */
  duplicateSelection(): Result<{ ids: string[] }> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const roots = this.selection.filter(
      (id) =>
        findObject(project, id) &&
        isInActiveScene(project, id) &&
        !this.selection.some((other) => other !== id && isInSubtree(project, id, other)),
    );
    if (roots.length === 0) return { ok: true, value: { ids: [] } };

    const idMap = new Map<string, string>();
    const runs: SceneObjectData[][] = [];
    for (const rootId of roots) {
      const run: SceneObjectData[] = [];
      this.duplicateSubtree(project, rootId, idMap, run);
      runs.push(run);
    }
    const newRootIds = runs.map((run) => run[0]!.id);
    // 层级不变量：parentId === null ⇔ 恰好出现在一个场景的根列表中。
    // 子对象副本沿用原 parentId（原父被复制时映射到副本父），不进入根列表
    const rootCopies = runs
      .filter((run) => run[0]!.parentId === null)
      .map((run) => run[0]!.id);

    // 副本树紧随原对象之后插入
    const objects: SceneObjectData[] = [];
    for (const object of project.objects) {
      objects.push(object);
      const index = roots.indexOf(object.id);
      if (index >= 0) objects.push(...runs[index]!);
    }
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    const scenes = scene
      ? project.scenes.map((s) =>
          s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, ...rootCopies] } : s,
        )
      : project.scenes;

    const result = this.commit({ ...project, objects, scenes }, `复制 ${newRootIds.length} 个对象`, newRootIds);
    if (!result.ok) return result;
    return { ok: true, value: { ids: newRootIds } };
  }

  /** 调整父子层级；拒绝父子循环与锁定对象（FR-002 异常处理） */
  setParent(objectId: string, parentId: string | null): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
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
    return this.commit({ ...next, scenes }, `调整「${object.name}」层级`);
  }

  /** 设置变换（数值属性编辑 / 数值输入提交），拒绝非法数值与锁定对象 */
  setTransform(objectId: string, transform: TransformData, label = '设置变换'): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    if (!isValidTransform(transform)) return failure('数值非法（不允许 NaN/Infinity）');
    if (object.locked) return failure(`「${object.name}」已锁定，无法变换`);
    return this.commit(updateObject(project, objectId, (o) => ({ ...o, transform })), label);
  }

  /**
   * 一次 Gizmo 拖动：捕获拖动前快照。
   * 项目为不可变数据（每次变更产生新 Project，旧引用永不改变），
   * 因此直接持有引用即可作为拖动前状态——不做结构化克隆，
   * 避免复制/序列化完整二进制 payload（大模型历史步骤与撤销无重负担）。
   */
  beginTransform(): void {
    const project = this.project;
    if (project) this.dragSnapshot = { project, selection: [...this.selection] };
  }

  /** 拖动结束提交：应用最终变换并推入历史（无变化则不推，AC：一次拖动一步） */
  commitTransform(objectId: string, transform: TransformData, label = '变换对象'): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    if (!isValidTransform(transform)) return failure('数值非法（不允许 NaN/Infinity）');
    if (object.locked) {
      this.dragSnapshot = null;
      return failure(`「${object.name}」已锁定，无法变换`);
    }
    const next = updateObject(project, objectId, (o) => ({ ...o, transform }));
    const before = this.dragSnapshot;
    this.dragSnapshot = null;
    const current: EditorSnapshot = { project, selection: [...this.selection] };
    // 拖动事务绑定基准：拖动期间项目被其他操作变更（并发编辑/撤销/重做）时，
    // 不得吞并并发编辑 —— 基于当前项目重建仅含本次 transform 的历史项
    // （并发编辑仍留在历史中，undo 时两者分开回退）
    if (before && before.project !== project) {
      if (this.sameTransform(project, next, objectId)) return { ok: true };
      this.pushEntry({ label, before: current, after: { project: next, selection: current.selection } });
      return { ok: true };
    }
    // 局部比较（仅目标对象三向量），不做整项目 JSON 序列化
    if (this.sameTransform(before?.project ?? project, next, objectId)) return { ok: true };
    this.pushEntry({ label, before: before ?? current, after: { project: next, selection: current.selection } });
    return { ok: true };
  }

  /** 通用属性更新（名称/材质/灯光/摄像机/几何体等），可撤销 */
  updateObjectProps(
    objectId: string,
    updater: (object: SceneObjectData) => SceneObjectData | null,
    label: string,
  ): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isInActiveScene(project, objectId)) return failure('对象不属于活动场景');
    const nextObject = updater(object);
    if (!nextObject) return failure('属性值非法');
    if (nextObject.id !== object.id || nextObject.type !== object.type) {
      return failure('结构标识（id/type）不可修改');
    }
    if (nextObject.transform !== object.transform && object.locked) {
      return failure(`「${object.name}」已锁定，无法变换`);
    }
    if (nextObject.parentId !== object.parentId) {
      return failure('层级变更请使用拖拽或层级操作');
    }
    if (!isSceneObject(nextObject)) return failure('属性值非法');
    return this.commit(updateObject(project, objectId, () => nextObject), label);
  }

  setVisible(ids: string[], visible: boolean): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    // 归属校验（防御）：只影响活动场景内的对象
    const idSet = new Set(ids.filter((id) => isInActiveScene(project, id)));
    if (idSet.size === 0) return { ok: true };
    const next = {
      ...project,
      objects: project.objects.map((o) => (idSet.has(o.id) ? { ...o, visible } : o)),
    };
    return this.commit(next, visible ? '显示对象' : '隐藏对象');
  }

  setLocked(ids: string[], locked: boolean): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    // 归属校验（防御）：只影响活动场景内的对象
    const idSet = new Set(ids.filter((id) => isInActiveScene(project, id)));
    if (idSet.size === 0) return { ok: true };
    const next = {
      ...project,
      objects: project.objects.map((o) => (idSet.has(o.id) ? { ...o, locked } : o)),
    };
    return this.commit(next, locked ? '锁定对象' : '解锁对象');
  }

  /** 注册资源并按哈希去重；作为一步历史（撤销导入时资源一并移除，无孤儿资源） */
  registerAsset(asset: AssetData): Result<{ asset: AssetData; deduped: boolean }> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const existing = findAssetByHash(project, asset.hash);
    if (existing) return { ok: true, value: { asset: existing, deduped: true } };
    const result = this.commit(addAsset(project, asset), `注册资源 ${asset.name}`);
    if (!result.ok) return result;
    return { ok: true, value: { asset, deduped: false } };
  }

  /** 导入模型 = 注册资源 + 创建模型对象，作为一步历史 */
  importModel(asset: AssetData, object: SceneObjectData): Result<string> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    if (!isSceneObject(object) || object.parentId !== null) return failure('对象数据不合法');
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) return failure('场景不存在');
    const existing = findAssetByHash(project, asset.hash);
    const effectiveAsset = existing ?? asset;
    // 同 hash 重复导入统一引用有效资源：无论调用方带什么 assetId，
    // 落库对象一律指向实际生效的资源（可能是已存在的去重资源）
    const normalizedObject: SceneObjectData = { ...object, assetId: effectiveAsset.id };
    const scenes = project.scenes.map((s) =>
      s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, normalizedObject.id] } : s,
    );
    const next: Project = {
      ...project,
      scenes,
      objects: [...project.objects, normalizedObject],
      assets: existing ? project.assets : [...project.assets, effectiveAsset],
    };
    const result = this.commit(next, `导入模型 ${normalizedObject.name}`, [normalizedObject.id]);
    if (!result.ok) return result;
    return { ok: true, value: normalizedObject.id };
  }

  // ---------- 视口 UI 状态（不进历史） ----------

  setTransformMode(mode: TransformMode): void {
    if (this.disposed) return;
    if (this.view.transformMode === mode) return;
    this.view = { ...this.view, transformMode: mode };
    this.events.emit('view:changed', { view: this.getView() });
  }

  setTransformSpace(space: TransformSpace): void {
    if (this.disposed) return;
    if (this.view.transformSpace === space) return;
    this.view = { ...this.view, transformSpace: space };
    this.events.emit('view:changed', { view: this.getView() });
  }

  setViewMode(mode: ViewMode): void {
    if (this.disposed) return;
    // 机位视图按活动场景隔离：机位不存在/不是相机/不属于活动场景 → 一律回退导演视图
    if (mode !== 'director') {
      const project = this.project;
      const cameraId = mode.cameraObjectId;
      const camera = project ? findObject(project, cameraId) : undefined;
      if (!camera || camera.type !== 'camera' || !isInActiveScene(project!, cameraId)) {
        mode = 'director';
      }
    }
    const same =
      this.view.viewMode === mode ||
      (this.view.viewMode !== 'director' &&
        mode !== 'director' &&
        this.view.viewMode.cameraObjectId === mode.cameraObjectId);
    if (same) return;
    this.view = { ...this.view, viewMode: mode };
    this.events.emit('view:changed', { view: this.getView() });
  }

  setGuide(kind: 'thirds' | 'safeFrame', enabled: boolean): void {
    if (this.disposed) return;
    this.view = { ...this.view, guides: { ...this.view.guides, [kind]: enabled } };
    this.events.emit('view:changed', { view: this.getView() });
  }

  // ---------- 撤销/重做 ----------

  undo(): Result {
    const snapshot = this.history.undo();
    if (!snapshot) return failure('没有可撤销的操作');
    this.applySnapshot(snapshot);
    return { ok: true };
  }

  redo(): Result {
    const snapshot = this.history.redo();
    if (!snapshot) return failure('没有可重做的操作');
    this.applySnapshot(snapshot);
    return { ok: true };
  }

  // ---------- 内部 ----------

  private requireProject(): Project | null {
    // 已释放的编辑器没有项目：一切写入都以「未打开项目」拒绝（无晚到提交）
    if (this.disposed) return null;
    return this.project;
  }

  private duplicateSubtree(
    project: Project,
    rootId: string,
    idMap: Map<string, string>,
    run: SceneObjectData[],
  ): void {
    const original = findObject(project, rootId);
    if (!original) return;
    const copy: SceneObjectData = {
      ...original,
      id: genId('obj'),
      parentId: original.parentId ? (idMap.get(original.parentId) ?? original.parentId) : null,
      name: `${original.name} 副本`,
    };
    idMap.set(rootId, copy.id);
    run.push(copy);
    for (const child of project.objects.filter((o) => o.parentId === rootId)) {
      this.duplicateSubtree(project, child.id, idMap, run);
    }
  }

  private commit(project: Project, label: string, afterSelection?: string[]): Result {
    this.pushEntry({
      label,
      before: { project: this.project!, selection: [...this.selection] },
      after: { project, selection: afterSelection ?? [...this.selection] },
    });
    return { ok: true };
  }

  /**
   * 推入历史并原子应用 after：transition 统一完成换入与事件（含视图推导）。
   * 历史栈保存未盖章 revision 的快照；revision 只由当前应用状态单调生成
   * （applySnapshot 应用时再取新值），undo/redo 每次应用都严格递增。
   */
  private pushEntry(entry: { label: string; before: EditorSnapshot; after: EditorSnapshot }): void {
    this.history.push({ ...entry, before: entry.before, after: entry.after });
    this.transition(entry.after.project, { selection: entry.after.selection });
    this.emitHistory();
  }

  /** 撤销/重做：过渡到快照（transition 取新 revision 并重新推导视图） */
  private applySnapshot(snapshot: EditorSnapshot): void {
    this.transition(snapshot.project, { selection: snapshot.selection });
    this.emitHistory();
  }

  /** 选择按项目活动场景可达集过滤：跨场景/已删除对象不可选中 */
  private filterSelection(project: Project, ids: string[]): string[] {
    return ids.filter((id) => findObject(project, id) && isInActiveScene(project, id));
  }

  /**
   * 原子应用状态（validate→swap→emit）：项目、选择、视图在发出任何事件前同时就位，
   * 按固定顺序发 project:changed → selection:changed → view:changed → history:changed。
   * 观察者（插件宿主/面板）不会看到「新项目 + 旧场景选择/旧机位」的跨场景中间态。
   * revision 只由当前应用状态单调生成；seedRevision 仅 openProject 从持久化值起步。
   */
  private transition(
    nextProject: Project | null,
    opts: { selection?: string[]; resetView?: boolean; seedRevision?: boolean } = {},
  ): void {
    this.assertAlive();
    if (nextProject) {
      this.validateProject(nextProject);
      if (opts.seedRevision) this.revisionCounter = nextProject.revision;
      else nextProject = { ...nextProject, revision: ++this.revisionCounter };
    }
    this.project = nextProject;
    this.selection = nextProject ? this.filterSelection(nextProject, opts.selection ?? this.selection) : [];
    this.view =
      opts.resetView || !nextProject
        ? { ...DEFAULT_VIEW, guides: { ...DEFAULT_VIEW.guides } }
        : this.deriveView(nextProject);
    this.events.emit('project:changed', { project: nextProject });
    this.events.emit('selection:changed', { ids: this.getSelection() });
    this.events.emit('view:changed', { view: this.getView() });
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
   * 项目结构校验（transition 每次应用前强制）：对象合法性、父子引用与循环、
   * 根列表一致性（parentId === null ⇔ 恰好出现在一个场景根列表）、
   * 活动场景与活动机位可达性。不合法即抛错（openProject 同步失败；
   * 提交路径为编辑器自身不变量的防御性校验）。
   */
  private validateProject(project: Project): void {
    for (const object of project.objects) {
      // 类型守卫对已类型化对象不会收窄失败分支（never），先取 id 供报错使用
      const objectId = object.id;
      if (!isSceneObject(object as unknown)) throw new Error(`对象数据不合法：${objectId}`);
      if (object.parentId !== null && !findObject(project, object.parentId)) {
        throw new Error(`对象缺少父级：${objectId}`);
      }
    }
    // 父子循环：沿 parent 链上行，节点重复访问即循环
    for (const object of project.objects) {
      const seen = new Set<string>();
      let cursor: SceneObjectData | undefined = object;
      while (cursor && cursor.parentId !== null) {
        if (seen.has(cursor.id)) throw new Error(`父子关系存在循环：${cursor.id}`);
        seen.add(cursor.id);
        cursor = findObject(project, cursor.parentId);
      }
    }
    // 根列表一致性：rootObjectIds 引用合法根对象；每个根对象恰好出现一次
    const rootCount = new Map<string, number>();
    for (const scene of project.scenes) {
      for (const rootId of scene.rootObjectIds) {
        const root = findObject(project, rootId);
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
    if (scene.activeCameraId !== null) {
      const camera = findObject(project, scene.activeCameraId);
      if (!camera || camera.type !== 'camera' || !isInActiveScene(project, scene.activeCameraId)) {
        throw new Error('活动机位不存在或不属于活动场景');
      }
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('编辑器已释放');
  }

  /** 拖动前后是否等价：仅比较目标对象三向量（局部比较，不序列化项目） */
  private sameTransform(a: Project, b: Project, objectId: string): boolean {
    const aObject = findObject(a, objectId);
    const bObject = findObject(b, objectId);
    if (!aObject || !bObject) return false;
    const { position: ap, rotation: ar, scale: as } = aObject.transform;
    const { position: bp, rotation: br, scale: bs } = bObject.transform;
    return (
      ap[0] === bp[0] && ap[1] === bp[1] && ap[2] === bp[2] &&
      ar[0] === br[0] && ar[1] === br[1] && ar[2] === br[2] &&
      as[0] === bs[0] && as[1] === bs[1] && as[2] === bs[2]
    );
  }

  private emitHistory(): void {
    this.events.emit('history:changed', this.getHistoryState());
  }
}
