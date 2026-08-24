import { SCENE_OBJECT_TYPES } from './types';
import type { AssetData, Project, SceneObjectData, TrackData, TransformData, Vec3 } from './types';

/** 完整 schema + 有限数值校验：候选状态在提交/打开前必须通过（M1，TML-57 第五轮）。 */

export const PRIMITIVE_KINDS = ['box', 'sphere', 'cone', 'torus', 'plane'] as const;
export const LIGHT_KINDS = ['directional', 'point', 'spot'] as const;
export const CAMERA_PROJECTIONS = ['perspective'] as const;
export const TRACK_TARGET_PATHS = ['position', 'rotation', 'scale', 'focalLength'] as const;
export const TRACK_INTERPOLATIONS = ['linear', 'step', 'smooth'] as const;
/** 标量通道（关键帧 value 为数值而非 Vec3） */
export const SCALAR_TRACK_PATHS = ['focalLength'] as const;

// ---------- 非 JSON 结构拒绝（R8-6）：Map/Set/Date 冻结壳封堵 ----------
// deepFreeze 只遍历自有属性：Map/Set 内部槽位（[[MapData]]）与 Date 时间槽位
// 不在自有属性上，冻结「壳」仍可 .set()/.setTime() —— 持有项目引用的调用方
// 可无历史地改写编辑器状态。候选载荷必须整树 JSON 纯结构（字面量对象/数组），
// 任何层级出现 Map/Set/Date/类实例一律拒绝。
// 未知普通字段保留：round-6 冻结基线要求含自引用未知键（loop）的输入可正常
// 打开；只要整树是 JSON 纯结构，deepFreeze 即能真正冻结，不产生绕过。
function findNonJsonPlain(value: unknown, visited: WeakSet<object>): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (visited.has(value)) return null;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = findNonJsonPlain(item, visited);
      if (problem) return problem;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return proto.constructor?.name ?? '非 JSON 结构';
  }
  for (const key of Object.keys(value)) {
    const problem = findNonJsonPlain((value as Record<string, unknown>)[key], visited);
    if (problem) return problem;
  }
  return null;
}

function assertJsonPlainDeep(value: unknown, label: string): string | null {
  const bad = findNonJsonPlain(value, new WeakSet());
  return bad ? `${label}不是 JSON 结构（含不可冻结的 ${bad}）` : null;
}

function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function isFinitePair(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 单个对象的完整校验：返回第一个问题描述；null 表示合法 */
export function validateSceneObjectData(object: unknown): string | null {
  if (!object || typeof object !== 'object') return '不是对象';
  const jsonProblem = assertJsonPlainDeep(object, '对象');
  if (jsonProblem) return jsonProblem;
  const o = object as Partial<SceneObjectData>;
  if (typeof o.id !== 'string' || o.id.length === 0) return 'id 缺失或非法';
  if (typeof o.type !== 'string' || !(SCENE_OBJECT_TYPES as readonly string[]).includes(o.type)) {
    return 'type 不属于场景对象类型全集';
  }
  if (typeof o.name !== 'string') return 'name 非法';
  if (o.parentId !== null && typeof o.parentId !== 'string') return 'parentId 非法';
  if (typeof o.visible !== 'boolean' || typeof o.locked !== 'boolean') return 'visible/locked 非法';
  if (o.transform === undefined) return 'transform 缺失';
  const t = o.transform as Partial<TransformData>;
  if (!isFiniteVec3(t.position) || !isFiniteVec3(t.rotation) || !isFiniteVec3(t.scale)) {
    return '数值非法（不允许 NaN/Infinity）';
  }
  // 分类型判别（R6，TML-57 第六轮）：载荷必须按类型存在，且字段类型与联合匹配
  if (o.type === 'camera' && o.camera === undefined) return 'camera 对象缺少 camera 载荷';
  if (o.type === 'light' && o.light === undefined) return 'light 对象缺少 light 载荷';
  if (o.type === 'model' && typeof o.assetId !== 'string') {
    return 'model 对象缺少资源引用（assetId）';
  }
  if (o.geometry !== undefined) {
    if (typeof o.geometry !== 'object' || o.geometry === null) return 'geometry 非法';
    const kind = (o.geometry as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !(PRIMITIVE_KINDS as readonly string[]).includes(kind)) {
      return 'geometry.kind 非法';
    }
  }
  if (o.material !== undefined) {
    const color = (o.material as { color?: unknown }).color;
    if (typeof color !== 'string') return 'material.color 非法';
  }
  if (o.light !== undefined) {
    const light = o.light as unknown as Record<string, unknown>;
    if (typeof light.kind !== 'string' || !(LIGHT_KINDS as readonly string[]).includes(light.kind)) {
      return 'light.kind 非法';
    }
    if (typeof light.color !== 'string') return 'light.color 非法';
    if (typeof light.intensity !== 'number' || !Number.isFinite(light.intensity)) {
      return 'light.intensity 非法（不允许 NaN/Infinity）';
    }
    if (light.distance !== undefined && (typeof light.distance !== 'number' || !Number.isFinite(light.distance))) {
      return 'light.distance 非法（不允许 NaN/Infinity）';
    }
    if (light.angle !== undefined && (typeof light.angle !== 'number' || !Number.isFinite(light.angle))) {
      return 'light.angle 非法（不允许 NaN/Infinity）';
    }
  }
  if (o.camera !== undefined) {
    const camera = o.camera as unknown as Record<string, unknown>;
    // 产品范围决定（R10）：orthographic 投影暂不支持（现实现恒建透视相机，
    // 行为本身已错误）——显式拒绝并说明后续方向，而非落入通用非法分支
    if (camera.projection === 'orthographic') {
      return 'camera.projection 非法（orthographic 未支持，仅支持 perspective）';
    }
    if (
      typeof camera.projection !== 'string' ||
      !(CAMERA_PROJECTIONS as readonly string[]).includes(camera.projection)
    ) {
      return 'camera.projection 非法';
    }
    for (const field of ['focalLength', 'fov', 'sensorWidth', 'sensorHeight', 'near', 'far']) {
      const value = camera[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `camera.${field} 非法（不允许 NaN/Infinity）`;
      }
    }
    // 投影参数数值域（R8-12）：fov 限 (0,180)°（≥180 时 tan(fov/2) 发散）、
    // 焦距/传感器/near 为正、far > near —— 破坏投影值让 three.js 投影矩阵失效
    if ((camera.fov as number) <= 0 || (camera.fov as number) >= 180) {
      return 'camera.fov 非法（需 0 < fov < 180）';
    }
    for (const field of ['focalLength', 'sensorWidth', 'sensorHeight', 'near']) {
      if ((camera[field] as number) <= 0) return `camera.${field} 非法（需为正）`;
    }
    if ((camera.far as number) <= (camera.near as number)) return 'camera.far 非法（需大于 near）';
    // aspect 联合为 number|null（null 跟随项目画幅）；非 null 必须为正有限数：
    // NaN/±Infinity 让投影矩阵与画幅计算产出 NaN（R9-M3 #5，NaN/∞ 过旧的
    // typeof 与 <= 0 两条分离条件），0/负画幅在画幅计算与投影构造中除零/翻转（R8-12）
    if (
      camera.aspect !== null &&
      (typeof camera.aspect !== 'number' || !Number.isFinite(camera.aspect) || camera.aspect <= 0)
    ) {
      return 'camera.aspect 非法（需为正有限数）';
    }
  }
  if (o.assetId !== undefined && typeof o.assetId !== 'string') return 'assetId 非法';
  return null;
}

/** 项目完整 schema 校验（不含图结构关系；结构不变量由 SceneEditor.validateProject 负责） */
export function validateProjectSchema(project: unknown): string | null {
  if (!project || typeof project !== 'object') return '项目不是对象';
  const jsonProblem = assertJsonPlainDeep(project, '项目');
  if (jsonProblem) return jsonProblem;
  const p = project as Partial<Project>;
  if (!isString(p.uri) || !isString(p.name)) return 'uri/name 非法';
  if (p.schemaVersion !== 4) return 'schemaVersion 非法';
  if (!isString(p.createdAt)) return 'createdAt 非法';
  if (typeof p.revision !== 'number' || !Number.isFinite(p.revision) || p.revision < 0) {
    return 'revision 非法';
  }
  const settings = p.settings as { fps?: unknown; aspect?: unknown } | undefined;
  if (!settings || typeof settings !== 'object') return 'settings 缺失';
  if (typeof settings.fps !== 'number' || !Number.isFinite(settings.fps) || settings.fps <= 0) {
    return 'settings.fps 非法';
  }
  if (!isFinitePair(settings.aspect) || settings.aspect[0] <= 0 || settings.aspect[1] <= 0) {
    return 'settings.aspect 非法（需为正）';
  }
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) return 'scenes 缺失';
  const sceneIds = new Set<string>();
  for (const scene of p.scenes) {
    if (!scene || typeof scene !== 'object') return '场景条目非法';
    const s = scene as { id?: unknown; name?: unknown; rootObjectIds?: unknown; activeCameraId?: unknown };
    if (!isString(s.id) || sceneIds.has(s.id)) return '场景 id 非法或重复';
    sceneIds.add(s.id);
    if (!isString(s.name)) return '场景 name 非法';
    if (
      !Array.isArray(s.rootObjectIds) ||
      !s.rootObjectIds.every((id) => typeof id === 'string')
    ) {
      return '场景 rootObjectIds 非法';
    }
    if (s.activeCameraId !== null && !isString(s.activeCameraId)) return '场景 activeCameraId 非法';
  }
  // 仅校验类型；成员归属（存在于 scenes）由 SceneEditor 的结构校验（活动场景不存在）负责
  if (!isString(p.activeSceneId)) return 'activeSceneId 非法';
  if (!Array.isArray(p.objects)) return 'objects 缺失';
  for (const object of p.objects) {
    const problem = validateSceneObjectData(object);
    if (problem) return `对象数据不合法（${problem}）`;
  }
  if (!Array.isArray(p.tracks)) return 'tracks 缺失或非数组';
  const trackIds = new Set<string>();
  for (const track of p.tracks) {
    if (!track || typeof track !== 'object') return '轨道条目非法';
    const t = track as Partial<TrackData>;
    if (!isString(t.id) || t.id.length === 0 || trackIds.has(t.id)) return '轨道 id 非法或重复';
    trackIds.add(t.id);
    if (!isString(t.name)) return '轨道 name 非法';
    if (!isString(t.objectId) || t.objectId.length === 0) return '轨道 objectId 非法';
    if (!isString(t.targetPath) || !(TRACK_TARGET_PATHS as readonly string[]).includes(t.targetPath)) {
      return '轨道 targetPath 非法';
    }
    if (t.disabled !== undefined && typeof t.disabled !== 'boolean') return '轨道 disabled 非法';
    const scalarPath = (SCALAR_TRACK_PATHS as readonly string[]).includes(t.targetPath);
    if (!Array.isArray(t.keyframes)) return '轨道 keyframes 非法';
    let lastTime = -Infinity;
    for (const keyframe of t.keyframes) {
      if (!keyframe || typeof keyframe !== 'object') return '轨道关键帧条目非法';
      const k = keyframe as { time?: unknown; value?: unknown; interpolation?: unknown };
      if (typeof k.time !== 'number' || !Number.isFinite(k.time) || k.time < 0) {
        return '轨道关键帧 time 非法（需为非负有限数）';
      }
      // 关键帧按 time 严格升序（重复时刻的插值语义未定义，拒绝猜测）
      if (k.time <= lastTime) return '轨道关键帧 time 未按升序排列';
      lastTime = k.time;
      // 值与通道类型匹配：标量通道（focalLength）为有限数值，Vec3 通道为三元向量
      if (scalarPath) {
        if (typeof k.value !== 'number' || !Number.isFinite(k.value)) {
          return '轨道关键帧 value 非法（标量通道需为有限数值）';
        }
      } else if (!isFiniteVec3(k.value)) {
        return '轨道关键帧 value 非法（不允许 NaN/Infinity）';
      }
      if (
        k.interpolation !== undefined &&
        (typeof k.interpolation !== 'string' ||
          !(TRACK_INTERPOLATIONS as readonly string[]).includes(k.interpolation))
      ) {
        return '轨道关键帧 interpolation 非法';
      }
    }
  }
  if (!Array.isArray(p.shots)) return 'shots 缺失或非数组';
  const shotIds = new Set<string>();
  for (const shot of p.shots) {
    if (!shot || typeof shot !== 'object') return '分镜条目非法';
    const s = shot as { id?: unknown; name?: unknown; cameraObjectId?: unknown; startTime?: unknown; endTime?: unknown };
    if (!isString(s.id) || s.id.length === 0 || shotIds.has(s.id)) return '分镜 id 非法或重复';
    shotIds.add(s.id);
    if (!isString(s.name)) return '分镜 name 非法';
    if (s.cameraObjectId !== null && !isString(s.cameraObjectId)) return '分镜 cameraObjectId 非法';
    if (typeof s.startTime !== 'number' || !Number.isFinite(s.startTime) || s.startTime < 0) {
      return '分镜 startTime 非法（需为非负有限数）';
    }
    if (typeof s.endTime !== 'number' || !Number.isFinite(s.endTime) || s.endTime <= s.startTime) {
      return '分镜 endTime 非法（需大于 startTime）';
    }
  }
  if (!Array.isArray(p.assets)) return 'assets 缺失';
  const assetIds = new Set<string>();
  for (const asset of p.assets) {
    if (!asset || typeof asset !== 'object') return '资源条目非法';
    const a = asset as Partial<AssetData>;
    if (!isString(a.id) || assetIds.has(a.id)) return '资源 id 非法或重复';
    assetIds.add(a.id);
    if (a.kind !== 'gltf') return '资源 kind 非法';
    if (!isString(a.name) || !isString(a.mime)) return '资源名称/MIME 非法';
    // 有载荷（主载荷或分件）的资产必须携带格式明确的哈希（SHA-256 64 位十六进制），
    // 内容完整性依赖它做无条件校验；无载荷（URL 来源）资产允许空哈希（去重键缺省）
    const hasPayload =
      a.payload !== undefined || (Array.isArray(a.parts) && a.parts.length > 0);
    if (hasPayload) {
      if (typeof a.hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(a.hash)) {
        return '资源 hash 非法（载荷存在时必须为 64 位十六进制 SHA-256）';
      }
    } else if (!isString(a.hash)) {
      return '资源 hash 非法';
    }
    if (typeof a.size !== 'number' || !Number.isFinite(a.size) || a.size < 0) return '资源 size 非法';
    if (a.source !== 'file' && a.source !== 'url') return '资源 source 非法';
    if (!isString(a.storageRef) || !isString(a.createdAt)) return '资源 storageRef/createdAt 非法';
    if (a.format !== undefined && a.format !== 'gltf' && a.format !== 'glb') return '资源 format 非法';
    if (a.payload !== undefined && !isString(a.payload)) return '资源 payload 非法';
    if (a.parts !== undefined) {
      if (!Array.isArray(a.parts)) return '资源 parts 非法';
      for (const part of a.parts) {
        if (!part || typeof part !== 'object') return '资源 part 非法';
        const partData = part as { path?: unknown; mime?: unknown; payload?: unknown };
        if (!isString(partData.path) || !isString(partData.mime) || !isString(partData.payload)) {
          return '资源 part 字段非法';
        }
      }
    }
  }
  // 交叉引用（R6）：model 对象的 assetId 必须指向项目内已注册资源
  for (const object of p.objects) {
    if (object.type === 'model' && !assetIds.has(object.assetId as string)) {
      return `模型对象引用不存在的资源（${(object.assetId as string | undefined) ?? '缺失'}）`;
    }
  }
  // 交叉引用（TML-88）：轨道 objectId 必须指向项目内已注册对象
  const objectIds = new Set<string>(p.objects.map((object) => object.id));
  for (const track of p.tracks) {
    if (!objectIds.has(track.objectId)) {
      return `轨道引用不存在的对象（${track.objectId}）`;
    }
  }
  // 交叉引用（TML-52）：分镜 cameraObjectId 必须指向项目内已注册的相机对象
  for (const shot of p.shots) {
    if (shot.cameraObjectId === null) continue;
    const camera = objectIds.has(shot.cameraObjectId)
      ? p.objects.find((object) => object.id === shot.cameraObjectId)
      : undefined;
    if (!camera || camera.type !== 'camera') {
      return `分镜「${shot.name}」引用不存在的机位（${shot.cameraObjectId}）`;
    }
  }
  return null;
}

/**
 * 完整图结构校验（第六轮 #2：从 SceneEditor 私有校验抽取为共享纯函数，
 * 加载边界与工程包导入在状态变更前复用）：父引用存在 → 父子循环 →
 * 根列表一致性（parentId === null ⇔ 恰好出现在一个场景根列表）→
 * 活动场景存在 → 机位归属（activeCameraId 指向本场景可达的相机）。
 * 调用方必须先通过 validateProjectSchema（本函数信任其基本类型保证）。
 * 返回首个问题描述；null 表示结构合法。
 */
export function validateProjectStructure(project: Project): string | null {
  if (!project || typeof project !== 'object') return '项目不是对象';
  if (!Array.isArray(project.objects)) return 'objects 缺失';
  if (!Array.isArray(project.scenes)) return 'scenes 缺失';
  const byId = new Map<string, SceneObjectData>();
  for (const object of project.objects) {
    if (byId.has(object.id)) return `对象数据不合法：${object.id}`;
    byId.set(object.id, object);
  }
  for (const object of project.objects) {
    if (object.parentId !== null && !byId.has(object.parentId)) {
      return `对象缺少父级：${object.id}`;
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
      if (s === 'in-progress') return `父子关系存在循环：${cursor.id}`;
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
      if (!root || root.parentId !== null) return `场景根列表引用非法：${rootId}`;
      rootCount.set(rootId, (rootCount.get(rootId) ?? 0) + 1);
    }
  }
  for (const object of project.objects) {
    if (object.parentId === null && !rootCount.has(object.id)) {
      return `孤立根对象：${object.id}`;
    }
  }
  for (const [rootId, count] of rootCount) {
    if (count > 1) return `根对象重复挂载：${rootId}`;
  }
  const scene = project.scenes.find((s) => s.id === project.activeSceneId);
  if (!scene) return '活动场景不存在';
  // 所有场景的 activeCameraId 都必须指向本场景可达的相机（非活动场景同样校验）。
  // 根一致性 ⇒ 无环单父森林中每对象沿父链上溯唯一根、场景子树不相交 → 单次
  // 构建归属根索引（O(N) 摊还路径压缩）+ 场景根集合，机位校验收敛 O(1)。
  if (project.scenes.some((s) => s.activeCameraId !== null)) {
    const rootOf = new Map<string, string>();
    const resolvedRoot = new Map<string, string>();
    for (const object of project.objects) {
      if (object.parentId === null) {
        rootOf.set(object.id, object.id);
        continue;
      }
      const path: string[] = [];
      let cursor: SceneObjectData | undefined = object;
      let rootId: string | null = null;
      while (cursor && cursor.parentId !== null) {
        const cached = resolvedRoot.get(cursor.id);
        if (cached !== undefined) {
          rootId = cached;
          break;
        }
        path.push(cursor.id);
        cursor = byId.get(cursor.parentId);
      }
      if (rootId === null && cursor) rootId = cursor.id;
      for (const id of path) resolvedRoot.set(id, rootId!);
      rootOf.set(object.id, rootId!);
    }
    const sceneRoots = new Map<string, Set<string>>();
    for (const s of project.scenes) sceneRoots.set(s.id, new Set(s.rootObjectIds));
    for (const s of project.scenes) {
      if (s.activeCameraId === null) continue;
      const camera = byId.get(s.activeCameraId);
      if (!camera || camera.type !== 'camera') {
        return `场景「${s.name}」的机位不存在或不是相机`;
      }
      if (!sceneRoots.get(s.id)!.has(rootOf.get(s.activeCameraId)!)) {
        return `场景「${s.name}」的机位不属于该场景`;
      }
    }
  }
  return null;
}
