import { HistoryStack } from '../history/history';
import { genId } from '../scene/create';
import {
  addAsset,
  collectUnreferencedAssets,
  findAssetByHash,
  findObject,
  getDescendantIds,
  getScene,
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
    this.project = project;
    this.selection = [];
    this.history.clear();
    this.dragSnapshot = null;
    this.emitAll();
  }

  reset(): void {
    this.project = null;
    this.selection = [];
    this.history.clear();
    this.dragSnapshot = null;
    this.emitAll();
  }

  dispose(): void {
    this.events.clear();
  }

  // ---------- 选择 ----------

  setSelection(ids: string[]): void {
    const project = this.project;
    const next = project ? ids.filter((id) => findObject(project, id)) : [];
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
    const result = this.commit(
      { ...project, scenes: [...project.scenes, scene], activeSceneId: scene.id },
      `新建场景 ${scene.name}`,
    );
    if (!result.ok) return result;
    this.setSelection([]);
    return { ok: true, value: scene.id };
  }

  setActiveScene(sceneId: string): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    if (!getScene(project, sceneId)) return failure('场景不存在');
    if (project.activeSceneId === sceneId) return { ok: true };
    return this.commit({ ...project, activeSceneId: sceneId }, '切换场景');
  }

  setActiveCamera(objectId: string | null): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const scene = project.scenes.find((s) => s.id === project.activeSceneId);
    if (!scene) return failure('场景不存在');
    if (objectId !== null) {
      const object = findObject(project, objectId);
      if (!object || object.type !== 'camera') return failure('机位对象不存在');
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
    this.setSelection([object.id]);
    return { ok: true, value: object.id };
  }

  /** 删除选中对象（含子树）；子树含锁定对象时拒绝（FR-002） */
  deleteSelection(): Result<{ removed: number }> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const ids = new Set<string>();
    for (const id of this.selection) {
      if (findObject(project, id)) {
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
    if (!result.ok) return result;
    this.setSelection(parentId ? [parentId] : []);
    return { ok: true, value: { removed } };
  }

  /** 复制选中对象子树；同一组内的后代不重复复制（FR-002） */
  duplicateSelection(): Result<{ ids: string[] }> {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const roots = this.selection.filter(
      (id) =>
        findObject(project, id) &&
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
    this.setSelection(newRootIds);
    return { ok: true, value: { ids: newRootIds } };
  }

  /** 调整父子层级；拒绝父子循环与锁定对象（FR-002 异常处理） */
  setParent(objectId: string, parentId: string | null): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (object.locked) return failure(`「${object.name}」已锁定，无法变更层级`);
    if (parentId !== null) {
      const parent = findObject(project, parentId);
      if (!parent) return failure('目标父对象不存在');
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
    if (!isValidTransform(transform)) return failure('数值非法（不允许 NaN/Infinity）');
    if (object.locked) return failure(`「${object.name}」已锁定，无法变换`);
    return this.commit(updateObject(project, objectId, (o) => ({ ...o, transform })), label);
  }

  /** 一次 Gizmo 拖动：捕获拖动前快照 */
  beginTransform(): void {
    const project = this.project;
    if (project) this.dragSnapshot = { project: structuredClone(project), selection: [...this.selection] };
  }

  /** 拖动结束提交：应用最终变换并推入历史（无变化则不推，AC：一次拖动一步） */
  commitTransform(objectId: string, transform: TransformData, label = '变换对象'): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const object = findObject(project, objectId);
    if (!object) return failure('对象不存在');
    if (!isValidTransform(transform)) return failure('数值非法（不允许 NaN/Infinity）');
    if (object.locked) {
      this.dragSnapshot = null;
      return failure(`「${object.name}」已锁定，无法变换`);
    }
    const next = updateObject(project, objectId, (o) => ({ ...o, transform }));
    const before = this.dragSnapshot ?? { project, selection: [...this.selection] };
    this.dragSnapshot = null;
    if (this.sameProject(before.project, next)) return { ok: true };
    this.pushEntry({ label, before, after: { project: next, selection: [...this.selection] } });
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
    const nextObject = updater(object);
    if (!nextObject) return failure('属性值非法');
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
    const idSet = new Set(ids);
    const next = {
      ...project,
      objects: project.objects.map((o) => (idSet.has(o.id) ? { ...o, visible } : o)),
    };
    return this.commit(next, visible ? '显示对象' : '隐藏对象');
  }

  setLocked(ids: string[], locked: boolean): Result {
    const project = this.requireProject();
    if (!project) return failure('未打开项目');
    const idSet = new Set(ids);
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
    const scenes = project.scenes.map((s) =>
      s.id === scene.id ? { ...s, rootObjectIds: [...s.rootObjectIds, object.id] } : s,
    );
    const next: Project = {
      ...project,
      scenes,
      objects: [...project.objects, object],
      assets: existing ? project.assets : [...project.assets, effectiveAsset],
    };
    const result = this.commit(next, `导入模型 ${object.name}`, [object.id]);
    if (!result.ok) return result;
    this.setSelection([object.id]);
    return { ok: true, value: object.id };
  }

  // ---------- 视口 UI 状态（不进历史） ----------

  setTransformMode(mode: TransformMode): void {
    if (this.view.transformMode === mode) return;
    this.view = { ...this.view, transformMode: mode };
    this.events.emit('view:changed', { view: this.getView() });
  }

  setTransformSpace(space: TransformSpace): void {
    if (this.view.transformSpace === space) return;
    this.view = { ...this.view, transformSpace: space };
    this.events.emit('view:changed', { view: this.getView() });
  }

  setViewMode(mode: ViewMode): void {
    this.view = { ...this.view, viewMode: mode };
    this.events.emit('view:changed', { view: this.getView() });
  }

  setGuide(kind: 'thirds' | 'safeFrame', enabled: boolean): void {
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

  private pushEntry(entry: { label: string; before: EditorSnapshot; after: EditorSnapshot }): void {
    const before = { ...entry.before, project: this.bumpRevision(entry.before.project) };
    const after = { ...entry.after, project: this.bumpRevision(entry.after.project) };
    this.history.push({ ...entry, before, after });
    this.project = after.project;
    this.events.emit('project:changed', { project: after.project });
    this.emitHistory();
  }

  private applySnapshot(snapshot: EditorSnapshot): void {
    this.project = snapshot.project;
    const alive = new Set(snapshot.project.objects.map((o) => o.id));
    const selection = snapshot.selection.filter((id) => alive.has(id));
    this.selection = selection;
    this.events.emit('project:changed', { project: snapshot.project });
    this.events.emit('selection:changed', { ids: this.getSelection() });
    this.emitHistory();
  }

  private bumpRevision(project: Project): Project {
    return { ...project, revision: project.revision + 1 };
  }

  private sameProject(a: Project, b: Project): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private emitAll(): void {
    this.events.emit('project:changed', { project: this.project });
    this.events.emit('selection:changed', { ids: this.getSelection() });
    this.events.emit('view:changed', { view: this.getView() });
    this.emitHistory();
  }

  private emitHistory(): void {
    this.events.emit('history:changed', this.getHistoryState());
  }
}
