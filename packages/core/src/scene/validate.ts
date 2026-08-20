import { SCENE_OBJECT_TYPES } from './types';
import type { AssetData, Project, SceneObjectData, TransformData, Vec3 } from './types';

/** 完整 schema + 有限数值校验：候选状态在提交/打开前必须通过（M1，TML-57 第五轮）。 */

export const PRIMITIVE_KINDS = ['box', 'sphere', 'cone', 'torus', 'plane'] as const;
export const LIGHT_KINDS = ['directional', 'point', 'spot'] as const;
export const CAMERA_PROJECTIONS = ['perspective', 'orthographic'] as const;

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
    if (camera.aspect !== null && !isFinitePair(camera.aspect)) return 'camera.aspect 非法';
  }
  if (o.assetId !== undefined && typeof o.assetId !== 'string') return 'assetId 非法';
  return null;
}

/** 项目完整 schema 校验（不含图结构关系；结构不变量由 SceneEditor.validateProject 负责） */
export function validateProjectSchema(project: unknown): string | null {
  if (!project || typeof project !== 'object') return '项目不是对象';
  const p = project as Partial<Project>;
  if (!isString(p.uri) || !isString(p.name)) return 'uri/name 非法';
  if (p.schemaVersion !== 2) return 'schemaVersion 非法';
  if (!isString(p.createdAt)) return 'createdAt 非法';
  if (typeof p.revision !== 'number' || !Number.isFinite(p.revision) || p.revision < 0) {
    return 'revision 非法';
  }
  const settings = p.settings as { fps?: unknown; aspect?: unknown } | undefined;
  if (!settings || typeof settings !== 'object') return 'settings 缺失';
  if (typeof settings.fps !== 'number' || !Number.isFinite(settings.fps) || settings.fps <= 0) {
    return 'settings.fps 非法';
  }
  if (!isFinitePair(settings.aspect)) return 'settings.aspect 非法';
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
  if (!Array.isArray(p.assets)) return 'assets 缺失';
  const assetIds = new Set<string>();
  for (const asset of p.assets) {
    if (!asset || typeof asset !== 'object') return '资源条目非法';
    const a = asset as Partial<AssetData>;
    if (!isString(a.id) || assetIds.has(a.id)) return '资源 id 非法或重复';
    assetIds.add(a.id);
    if (a.kind !== 'gltf') return '资源 kind 非法';
    if (!isString(a.name) || !isString(a.mime) || !isString(a.hash)) return '资源名称/MIME/hash 非法';
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
  return null;
}
