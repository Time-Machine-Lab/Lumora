import type { AssetData, Project, SceneObjectData, Vec3 } from './types';

/** 场景图查询与纯更新工具（不承载业务规则，规则在 SceneEditor 中）。 */

export function findObject(project: Project, id: string): SceneObjectData | undefined {
  return project.objects.find((object) => object.id === id);
}

/** 直接子对象，保持插入顺序 */
export function getChildren(project: Project, parentId: string | null): SceneObjectData[] {
  return project.objects.filter((object) => object.parentId === parentId);
}

export function getScene(project: Project, sceneId: string) {
  return project.scenes.find((scene) => scene.id === sceneId) ?? null;
}

export function getActiveScene(project: Project) {
  return project.scenes.find((scene) => scene.id === project.activeSceneId) ?? project.scenes[0] ?? null;
}

export function getSceneRoots(project: Project, sceneId: string): SceneObjectData[] {
  const scene = getScene(project, sceneId);
  if (!scene) return [];
  const roots = new Set(scene.rootObjectIds);
  return project.objects.filter((object) => object.parentId === null && roots.has(object.id));
}

/** 直接子对象 ID 列表（含顺序） */
export function getChildIds(project: Project, parentId: string | null): string[] {
  return project.objects.filter((object) => object.parentId === parentId).map((object) => object.id);
}

/** 全部后代 ID（不含自身），深度优先 */
export function getDescendantIds(project: Project, id: string): string[] {
  const result: string[] = [];
  const walk = (parentId: string) => {
    for (const child of project.objects.filter((o) => o.parentId === parentId)) {
      result.push(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return result;
}

/** maybeDescendant 是否位于 ancestor 的子树内（含自身） */
export function isInSubtree(project: Project, maybeDescendantId: string, ancestorId: string): boolean {
  if (maybeDescendantId === ancestorId) return true;
  const object = findObject(project, maybeDescendantId);
  if (!object?.parentId) return false;
  return isInSubtree(project, object.parentId, ancestorId);
}

export function isValidVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** 变换合法性：拒绝 NaN/Infinity（FR-004 异常处理） */
export function isValidTransform(transform: unknown): transform is import('./types').TransformData {
  if (!transform || typeof transform !== 'object') return false;
  const t = transform as { position?: unknown; rotation?: unknown; scale?: unknown };
  return (
    isValidVec3(t.position) && isValidVec3(t.rotation) && isValidVec3(t.scale)
  );
}

export function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 对对象执行纯更新；未命中时返回原项目 */
export function updateObject(project: Project, id: string, update: (o: SceneObjectData) => SceneObjectData): Project {
  let changed = false;
  const objects = project.objects.map((object) => {
    if (object.id !== id) return object;
    const next = update(object);
    if (next === object) return object;
    changed = true;
    return next;
  });
  return changed ? { ...project, objects } : project;
}

export function updateObjectById(project: Project, id: string, patch: Partial<SceneObjectData>): Project {
  return updateObject(project, id, (object) => ({ ...object, ...patch }));
}

export function removeObjects(project: Project, ids: Set<string>): Project {
  return {
    ...project,
    objects: project.objects.filter((object) => !ids.has(object.id)),
    scenes: project.scenes.map((scene) => ({
      ...scene,
      rootObjectIds: scene.rootObjectIds.filter((id) => !ids.has(id)),
      activeCameraId:
        scene.activeCameraId && ids.has(scene.activeCameraId) ? null : scene.activeCameraId,
    })),
  };
}

/** 未被任何对象引用的资源（删除对象后应释放） */
export function collectUnreferencedAssets(project: Project): AssetData[] {
  const referenced = new Set(
    project.objects.map((object) => object.assetId).filter((id): id is string => !!id),
  );
  return project.assets.filter((asset) => !referenced.has(asset.id));
}

export function getAssetById(project: Project, assetId: string): AssetData | undefined {
  return project.assets.find((asset) => asset.id === assetId);
}

export function findAssetByHash(project: Project, hash: string): AssetData | undefined {
  return project.assets.find((asset) => asset.hash === hash);
}

export function addAsset(project: Project, asset: AssetData): Project {
  if (project.assets.some((a) => a.id === asset.id)) return project;
  return { ...project, assets: [...project.assets, asset] };
}

export function removeAssets(project: Project, assetIds: Set<string>): Project {
  if (assetIds.size === 0) return project;
  return { ...project, assets: project.assets.filter((asset) => !assetIds.has(asset.id)) };
}
