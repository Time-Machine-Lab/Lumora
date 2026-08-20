import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getActiveScene } from '@lumora/core';
import type { Project, SceneObjectData, TransformData } from '@lumora/core';

/** 模型内容未加载时的占位框 */
export const PLACEHOLDER_NAME = 'model-placeholder';
const CONTENT_NAME = '__glb-content__';

const PRIMITIVE_GEOMETRIES: Record<string, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.6, 24, 24),
  cone: () => new THREE.ConeGeometry(0.5, 1, 24),
  torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 32),
  plane: () => new THREE.PlaneGeometry(1, 1),
};

/** 是否位于 GLB 内容子树内（内容网格由 AssetCache 按引用计数持有，不在场景树中处置） */
function isInsideContent(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name === CONTENT_NAME) return true;
    current = current.parent;
  }
  return false;
}

/**
 * 递归释放几何/材质/纹理（撤销删除或重建节点时避免 GPU 泄漏）。
 * GLB 内容子树跳过：同一资源可被多个模型实例共享（clone 共享几何/材质），
 * 资源归 AssetCache 所有，最后一个引用释放时才 dispose（共享资源不会被
 * 先删除的实例误杀）。
 */
export function disposeNode(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && !isInsideContent(child)) {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.dispose();
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            (value as THREE.Texture).dispose();
          }
        }
      }
    }
  });
}

export function applyTransform(object: THREE.Object3D, transform: TransformData): void {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  object.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2], 'XYZ');
  object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
}

/** 由对象数据构建 THREE 节点；userData.objectId 用于选择/同步 */
export function buildObject(data: SceneObjectData, aspect: number): THREE.Object3D {
  let node: THREE.Object3D;
  switch (data.type) {
    case 'group':
      node = new THREE.Group();
      break;
    case 'primitive': {
      node = new THREE.Mesh(
        PRIMITIVE_GEOMETRIES[data.geometry?.kind ?? 'box']!(),
        new THREE.MeshStandardMaterial({ color: data.material?.color ?? '#d0b3ff' }),
      );
      break;
    }
    case 'light': {
      const light = data.light!;
      node =
        light.kind === 'directional'
          ? new THREE.DirectionalLight(light.color, light.intensity)
          : light.kind === 'point'
            ? new THREE.PointLight(light.color, light.intensity, light.distance ?? 0)
            : new THREE.SpotLight(light.color, light.intensity, light.distance ?? 0, light.angle ?? Math.PI / 4);
      break;
    }
    case 'camera': {
      const camera = data.camera!;
      node = new THREE.PerspectiveCamera(camera.fov, camera.aspect ?? aspect, camera.near, camera.far);
      break;
    }
    case 'model': {
      const group = new THREE.Group();
      const placeholder = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.6, 0.6),
        new THREE.MeshBasicMaterial({ color: '#7a6bff', wireframe: true, transparent: true, opacity: 0.7 }),
      );
      placeholder.name = PLACEHOLDER_NAME;
      group.add(placeholder);
      node = group;
      break;
    }
  }
  node.name = data.name;
  node.userData.objectId = data.id;
  node.userData.type = data.type;
  node.userData.geometryKind = data.geometry?.kind;
  node.userData.color = data.material?.color ?? data.light?.color;
  node.userData.intensity = data.light?.intensity;
  node.userData.distance = data.light?.distance;
  node.userData.angle = data.light?.angle;
  applyTransform(node, data.transform);
  node.visible = data.visible;
  return node;
}

/** 用已解析的 GLB 内容替换模型占位框（克隆副本，支持同一资源多处引用） */
export function attachModelContent(node: THREE.Object3D, gltf: GLTF): void {
  if (node.getObjectByName(CONTENT_NAME)) return;
  const placeholder = node.getObjectByName(PLACEHOLDER_NAME);
  if (placeholder) {
    placeholder.removeFromParent();
    disposeNode(placeholder);
  }
  const clone = gltf.scene.clone(true);
  clone.name = CONTENT_NAME;
  node.add(clone);
}

/** 活动场景可达对象集（场景根 + 全部后代）；多场景隔离的同步边界 */
export function getReachableObjectIds(project: Project): Set<string> {
  const scene = getActiveScene(project);
  const reachable = new Set<string>();
  if (!scene) return reachable;
  const walk = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const child of project.objects.filter((o) => o.parentId === id)) walk(child.id);
  };
  for (const rootId of scene.rootObjectIds) walk(rootId);
  return reachable;
}

/** 从项目数据构建活动场景根节点 */
export function buildScene(project: Project, aspect: number): THREE.Group {
  const root = new THREE.Group();
  root.name = '__scene__';
  const scene = getActiveScene(project);
  if (!scene) return root;
  const byId = new Map(project.objects.map((o) => [o.id, o]));
  const attach = (object: SceneObjectData, parent: THREE.Object3D): void => {
    const node = buildObject(object, aspect);
    parent.add(node);
    for (const child of project.objects.filter((o) => o.parentId === object.id)) {
      attach(child, node);
    }
  };
  for (const rootId of scene.rootObjectIds) {
    const object = byId.get(rootId);
    if (object) attach(object, root);
  }
  return root;
}

export function findNode(root: THREE.Object3D, objectId: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((node) => {
    if (!found && node.userData.objectId === objectId) found = node;
  });
  return found;
}

function applyObjectData(node: THREE.Object3D, data: SceneObjectData, aspect: number): void {
  node.name = data.name;
  node.visible = data.visible;
  applyTransform(node, data.transform);
  if (node instanceof THREE.Mesh) {
    const kind = data.geometry?.kind;
    if (kind && node.userData.geometryKind !== kind) {
      const previous = node.geometry;
      node.geometry = PRIMITIVE_GEOMETRIES[kind]!();
      previous.dispose();
      node.userData.geometryKind = kind;
    }
    const color = data.material?.color ?? '#d0b3ff';
    if (node.userData.color !== color) {
      if (Array.isArray(node.material)) {
        node.material = new THREE.MeshStandardMaterial({ color });
      } else {
        node.material.color.set(color);
      }
      node.userData.color = color;
    }
  }
  if (node instanceof THREE.Light) {
    const light = data.light;
    if (light) {
      if (node.userData.color !== light.color) {
        node.color.set(light.color);
        node.userData.color = light.color;
      }
      if (node.userData.intensity !== light.intensity) {
        node.intensity = light.intensity;
        node.userData.intensity = light.intensity;
      }
      if (node instanceof THREE.PointLight && node.userData.distance !== light.distance) {
        node.distance = light.distance ?? 0;
        node.userData.distance = light.distance;
      }
      if (node instanceof THREE.SpotLight && node.userData.angle !== light.angle) {
        node.angle = light.angle ?? Math.PI / 4;
        node.userData.angle = light.angle;
      }
    }
  }
  if (node instanceof THREE.PerspectiveCamera && data.camera) {
    const camera = data.camera;
    node.fov = camera.fov;
    node.aspect = camera.aspect ?? aspect;
    node.near = camera.near;
    node.far = camera.far;
    node.updateProjectionMatrix();
  }
}

/**
 * 增量同步：对比前后项目，把对象变更应用到已构建的场景树。
 * 新建节点按数组顺序创建（父先于子），重挂靠父对象一并处理。
 */
export function syncScene(root: THREE.Group, previous: Project, next: Project, aspect: number): void {
  const idToNode = new Map<string, THREE.Object3D>();
  root.traverse((node) => {
    if (node.userData.objectId) idToNode.set(node.userData.objectId as string, node);
  });
  const prevById = new Map(previous.objects.map((o) => [o.id, o]));
  // 只同步活动场景可达对象：其他场景的编辑/新建/删除不进入当前视口（多场景隔离）
  const nextReachable = getReachableObjectIds(next);

  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    const node = idToNode.get(object.id);
    if (!node) {
      const parentNode = object.parentId ? idToNode.get(object.parentId) : null;
      if (object.parentId && !parentNode) continue;
      const created = buildObject(object, aspect);
      idToNode.set(object.id, created);
      (parentNode ?? root).add(created);
      continue;
    }
    const prev = prevById.get(object.id);
    if (prev) {
      if (prev.parentId !== object.parentId) {
        // 数据为局部变换，重挂靠直接用 add 保持局部变换不变
        const parentNode = object.parentId ? idToNode.get(object.parentId) : null;
        if (parentNode) parentNode.add(node);
        else if (!object.parentId) root.add(node);
      }
      if (JSON.stringify(prev) !== JSON.stringify(object)) {
        applyObjectData(node, object, aspect);
      }
    }
  }
  for (const [id, node] of idToNode) {
    if (!nextReachable.has(id)) {
      node.parent?.remove(node);
      disposeNode(node);
    }
  }
}
