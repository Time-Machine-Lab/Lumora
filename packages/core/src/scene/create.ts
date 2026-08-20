import { focalLengthToFovDeg, FULL_FRAME_SENSOR } from './camera-math';
import type {
  CameraData,
  LightData,
  LightKind,
  MaterialData,
  PrimitiveKind,
  SceneObjectData,
  SceneObjectType,
  TransformData,
  Vec3,
} from './types';

/** 对象/资源/场景工厂（MVP-2 内置对象类型）。 */

export function genId(prefix = 'obj'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${random}`;
}

export function defaultTransform(position: Vec3 = [0, 0, 0]): TransformData {
  return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
}

export function defaultName(type: SceneObjectType): string {
  switch (type) {
    case 'group':
      return '组';
    case 'model':
      return '模型';
    case 'primitive':
      return '几何体';
    case 'light':
      return '灯光';
    case 'camera':
      return '摄像机';
  }
}

export function createPrimitiveObject(kind: PrimitiveKind, name?: string): SceneObjectData {
  return {
    id: genId(kind),
    type: 'primitive',
    name: name ?? defaultName('primitive'),
    parentId: null,
    transform: defaultTransform(),
    visible: true,
    locked: false,
    geometry: { kind },
    material: { color: '#d0b3ff' },
  };
}

export function createLightObject(kind: LightKind, name?: string): SceneObjectData {
  const light: LightData =
    kind === 'directional'
      ? { kind, color: '#ffffff', intensity: 1.2 }
      : kind === 'point'
        ? { kind, color: '#ffffff', intensity: 8, distance: 12 }
        : { kind, color: '#ffffff', intensity: 20, distance: 15, angle: (25 * Math.PI) / 180 };
  const position: Vec3 =
    kind === 'directional' ? [3, 6, 3] : kind === 'point' ? [1.5, 2.5, 1.5] : [2, 4, 3];
  return {
    id: genId(`light-${kind}`),
    type: 'light',
    name: name ?? (kind === 'directional' ? '平行光' : kind === 'point' ? '点光源' : '聚光灯'),
    parentId: null,
    transform: defaultTransform(position),
    visible: true,
    locked: false,
    light,
  };
}

export function createCameraObject(name?: string, focalLengthMm = 50): SceneObjectData {
  const camera: CameraData = {
    projection: 'perspective',
    focalLength: focalLengthMm,
    fov: focalLengthToFovDeg(focalLengthMm),
    sensorWidth: FULL_FRAME_SENSOR.width,
    sensorHeight: FULL_FRAME_SENSOR.height,
    near: 0.1,
    far: 200,
    aspect: null,
  };
  return {
    id: genId('camera'),
    type: 'camera',
    name: name ?? '摄像机',
    parentId: null,
    transform: defaultTransform([0, 1.6, 6]),
    visible: true,
    locked: false,
    camera,
  };
}

export function createGroupObject(name?: string): SceneObjectData {
  return {
    id: genId('group'),
    type: 'group',
    name: name ?? '组',
    parentId: null,
    transform: defaultTransform(),
    visible: true,
    locked: false,
  };
}

export function createModelObject(assetId: string, name?: string): SceneObjectData {
  return {
    id: genId('model'),
    type: 'model',
    name: name ?? defaultName('model'),
    parentId: null,
    transform: defaultTransform(),
    visible: true,
    locked: false,
    assetId,
  };
}

export function createMaterial(color: string): MaterialData {
  return { color };
}

export function createScene(name = '场景'): import('./types').SceneData {
  return { id: genId('scene'), name, rootObjectIds: [], activeCameraId: null };
}
