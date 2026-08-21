import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getActiveScene, getReachableIds } from '@lumora/core';
import type { Project, SceneObjectData, TransformData } from '@lumora/core';

/** 模型内容未加载时的占位框 */
export const PLACEHOLDER_NAME = 'model-placeholder';
const CONTENT_NAME = '__glb-content__';

/**
 * 内部所有权标记（R8-5）：占位框/内容子树归属一律查 userData Symbol——
 * 名称是用户可编辑的（导入文件名、对象重命名），同名即判定所有权会让
 * 用户 GLB 或对象名伪造标记：'model-placeholder' 模型组被当占位框移除、
 * '__glb-content__' 组被当已有内容导致永不挂载、同名普通对象释放被跳过。
 * Symbol 不可能被用户数据携带（clone(true) 的 userData JSON 拷贝也不含 Symbol）。
 */
const PLACEHOLDER_MARK = Symbol('lumora.model-placeholder');
const CONTENT_MARK = Symbol('lumora.model-content');

/** userData 的 Symbol 索引（THREE 类型为 Record<string, any>：字符串索引签名不容纳 symbol，需加宽） */
function readMark(userData: Record<string, unknown>, mark: symbol): unknown {
  return (userData as Record<string | symbol, unknown>)[mark];
}

function writeMark(userData: Record<string, unknown>, mark: symbol): void {
  (userData as Record<string | symbol, unknown>)[mark] = true;
}

const PRIMITIVE_GEOMETRIES: Record<string, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.6, 24, 24),
  cone: () => new THREE.ConeGeometry(0.5, 1, 24),
  torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 32),
  plane: () => new THREE.PlaneGeometry(1, 1),
};

/** 是否位于 GLB 内容子树内（内容网格由 ContentCache 按 lease 引用持有，不在场景树中处置） */
function isInsideContent(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (readMark(current.userData, CONTENT_MARK)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * 递归释放几何/材质/纹理（撤销删除或重建节点时避免 GPU 泄漏）。
 * GLB 内容子树跳过：同一资源可被多个模型实例共享（clone 共享几何/材质），
 * 资源归 ContentCache 所有，最后一个 lease 释放时才 dispose（共享资源不会被
 * 先删除的实例误杀）。
 * 迭代栈替代 THREE 递归 traverse：深层链不爆栈（R8-7）。
 */
export function disposeNode(object: THREE.Object3D): void {
  const stack: THREE.Object3D[] = [object];
  while (stack.length > 0) {
    const child = stack.pop()!;
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
    for (let i = child.children.length - 1; i >= 0; i--) stack.push(child.children[i]!);
  }
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
      writeMark(placeholder.userData, PLACEHOLDER_MARK);
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
  node.userData.assetId = data.assetId;
  applyTransform(node, data.transform);
  node.visible = data.visible;
  return node;
}

/** 用已解析的 GLB 内容替换模型占位框（克隆副本，支持同一资源多处引用） */
export function attachModelContent(node: THREE.Object3D, gltf: GLTF): void {
  // 占位框/内容都是模型组的直接子节点：只查直接子节点与 Symbol 标记，
  // 用户 GLB 内或对象名里的同名节点（'model-placeholder'/'__glb-content__'）
  // 不可能被误判为内部结构（R8-5）
  if (node.children.some((c) => readMark(c.userData, CONTENT_MARK))) return;
  const placeholder = node.children.find((c) => readMark(c.userData, PLACEHOLDER_MARK));
  if (placeholder) {
    node.remove(placeholder);
    disposeNode(placeholder);
  }
  const clone = gltf.scene.clone(true);
  clone.name = CONTENT_NAME;
  // clone(true) 对 userData 做 JSON 拷贝（Symbol 键被丢弃），须在克隆后补标
  writeMark(clone.userData, CONTENT_MARK);
  node.add(clone);
}

/** 活动场景可达对象集（场景根 + 全部后代）；多场景隔离的同步边界（复用 core 迭代实现，R8-7） */
export function getReachableObjectIds(project: Project): Set<string> {
  const scene = getActiveScene(project);
  if (!scene) return new Set();
  return getReachableIds(project, scene.id);
}

/** 从项目数据构建活动场景根节点；迭代栈 + 已见集（R8-7：深层链不爆栈，循环不无限扩张） */
export function buildScene(project: Project, aspect: number): THREE.Group {
  const root = new THREE.Group();
  root.name = '__scene__';
  const scene = getActiveScene(project);
  if (!scene) return root;
  const byId = new Map(project.objects.map((o) => [o.id, o]));
  const childrenOf = new Map<string | null, string[]>();
  for (const object of project.objects) {
    const list = childrenOf.get(object.parentId);
    if (list) list.push(object.id);
    else childrenOf.set(object.parentId, [object.id]);
  }
  // 根与子节点均逆序入栈，弹栈后保持原插入顺序（与旧递归实现一致）
  const stack: { object: SceneObjectData; parent: THREE.Object3D }[] = [];
  for (let i = scene.rootObjectIds.length - 1; i >= 0; i--) {
    const object = byId.get(scene.rootObjectIds[i]!);
    if (object) stack.push({ object, parent: root });
  }
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { object, parent } = stack.pop()!;
    if (seen.has(object.id)) continue;
    seen.add(object.id);
    const node = buildObject(object, aspect);
    parent.add(node);
    const children = childrenOf.get(object.id);
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) {
        const child = byId.get(children[i]!);
        if (child) stack.push({ object: child, parent: node });
      }
    }
  }
  return root;
}

export function findNode(root: THREE.Object3D, objectId: string): THREE.Object3D | null {
  // 迭代先序搜索（R8-7）：与 THREE traverse 同序（自身在前、子节点按序），深树不爆栈
  const stack: THREE.Object3D[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.userData.objectId === objectId) return node;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return null;
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
 * 增量同步：对比前后项目，把对象变更应用到已构建的场景树（R8-4）：
 * - 先建全部缺失/身份分叉节点、再统一挂载：恢复数组为 child-first 时
 *   子节点先建，父节点虽尚不存在也不再被永久跳过（旧实现 continue）；
 * - type/assetId 变化视为身份分叉，整节点重建，不残留旧类型/旧资源内容；
 * - 挂载时父节点必已在表中；数据异常（父节点彻底不存在）时挂到根自愈。
 */
export function syncScene(root: THREE.Group, previous: Project, next: Project, aspect: number): void {
  const idToNode = new Map<string, THREE.Object3D>();
  // 迭代遍历替代 root.traverse（THREE 递归）：深树不爆栈（R8-7）
  const traverseStack: THREE.Object3D[] = [root];
  while (traverseStack.length > 0) {
    const node = traverseStack.pop()!;
    if (node.userData.objectId) idToNode.set(node.userData.objectId as string, node);
    for (let i = node.children.length - 1; i >= 0; i--) traverseStack.push(node.children[i]!);
  }
  const prevById = new Map(previous.objects.map((o) => [o.id, o]));
  // 只同步活动场景可达对象：其他场景的编辑/新建/删除不进入当前视口（多场景隔离）
  const nextReachable = getReachableObjectIds(next);

  // 第一遍：创建全部缺失节点；身份分叉（type/assetId 变化）的旧节点整节点释放重建
  const created: { node: THREE.Object3D; parentId: string | null }[] = [];
  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    const node = idToNode.get(object.id);
    if (
      node &&
      (node.userData.type !== object.type ||
        (object.type === 'model' && node.userData.assetId !== object.assetId))
    ) {
      node.parent?.remove(node);
      disposeNode(node);
      idToNode.delete(object.id);
    }
    if (!idToNode.has(object.id)) {
      const createdNode = buildObject(object, aspect);
      idToNode.set(object.id, createdNode);
      created.push({ node: createdNode, parentId: object.parentId ?? null });
    }
  }

  // 第二遍：统一挂载 —— 父节点要么早已存在、要么本遍已创建，全部可解析
  for (const { node, parentId } of created) {
    const parentNode = parentId ? idToNode.get(parentId) : null;
    (parentNode ?? root).add(node);
  }

  // 第三遍：既有节点的重挂靠与数据更新
  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    const node = idToNode.get(object.id);
    if (!node) continue;
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
