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

/** 全部后代 ID（不含自身），深度优先。父级索引一次构建（O(n)），
 *  不再每层全量 filter（深层链 O(n²)，R6，TML-57 第六轮） */
export function getDescendantIds(project: Project, id: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const object of project.objects) {
    if (object.parentId === null) continue;
    const list = childrenOf.get(object.parentId);
    if (list) list.push(object.id);
    else childrenOf.set(object.parentId, [object.id]);
  }
  const result: string[] = [];
  // 逆序入栈保持先父后子、同层按插入序的深度优先输出（与原递归实现一致）
  const stack = [...(childrenOf.get(id) ?? [])].reverse();
  while (stack.length > 0) {
    const childId = stack.pop()!;
    result.push(childId);
    const grandchildren = childrenOf.get(childId);
    if (grandchildren) {
      // 保持深度优先且先父后子的输出顺序：逆序入栈
      for (let i = grandchildren.length - 1; i >= 0; i--) stack.push(grandchildren[i]!);
    }
  }
  return result;
}

/** maybeDescendant 是否位于 ancestor 的子树内（含自身）；父链迭代上溯 + byId 索引（R8-7） */
export function isInSubtree(project: Project, maybeDescendantId: string, ancestorId: string): boolean {
  const byId = new Map<string, SceneObjectData>();
  for (const object of project.objects) byId.set(object.id, object);
  let currentId: string | undefined = maybeDescendantId;
  while (currentId) {
    if (currentId === ancestorId) return true;
    currentId = byId.get(currentId)?.parentId ?? undefined;
  }
  return false;
}

/**
 * 场景可达对象集（场景根 + 全部后代）。selection/相机等按活动场景隔离的判定边界：
 * 只有可达对象属于该场景，跨场景对象不可选中、不可编辑。
 */
export function getReachableIds(project: Project, sceneId: string): Set<string> {
  const scene = getScene(project, sceneId);
  const reachable = new Set<string>();
  if (!scene) return reachable;
  const childrenOf = new Map<string | null, string[]>();
  for (const object of project.objects) {
    const list = childrenOf.get(object.parentId);
    if (list) list.push(object.id);
    else childrenOf.set(object.parentId, [object.id]);
  }
  // 迭代栈 + 已见集：深层链不爆栈，循环引用不无限扩张（R8-7）
  const stack: string[] = [];
  for (let i = scene.rootObjectIds.length - 1; i >= 0; i--) stack.push(scene.rootObjectIds[i]!);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const children = childrenOf.get(id);
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }
  return reachable;
}

/** 对象是否属于项目活动场景的可达集 */
export function isInActiveScene(project: Project, objectId: string): boolean {
  return getReachableIds(project, project.activeSceneId).has(objectId);
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
