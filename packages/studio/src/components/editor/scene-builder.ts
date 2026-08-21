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
/** 对象所有权品牌（R10-M2）：buildObject 双写（brand + 保留 userData.objectId
 * 兼容既有断言）；所有权解析一律只读品牌——原始 objectId 可被用户 GLB extras
 * 或手工数据伪造，Symbol 不可能被用户数据携带（clone(true) 的 JSON 拷贝不含） */
const OBJECT_ID_MARK = Symbol('lumora.object-id');

/** userData 的 Symbol 索引（THREE 类型为 Record<string, any>：字符串索引签名不容纳 symbol，需加宽） */
function readMark(userData: Record<string, unknown>, mark: symbol): unknown {
  return (userData as Record<string | symbol, unknown>)[mark];
}

function writeMark(userData: Record<string, unknown>, mark: symbol): void {
  (userData as Record<string | symbol, unknown>)[mark] = true;
}

/** 内容子树判定（R10-M2 受控读口）：模块私有标记不导出，遍历经此读口判定 */
export function isContentNode(node: THREE.Object3D): boolean {
  return !!readMark(node.userData, CONTENT_MARK);
}

/** 对象所有权判定（R10-M2 受控读口）：拾取/同步的所有权解析一律经品牌判定 */
export function isOwnedNode(node: THREE.Object3D): boolean {
  return !!readMark(node.userData, OBJECT_ID_MARK);
}

/**
 * 内容边界上方最近品牌节点（R11-2/R12-2 拾取边界统一）：内容子树整体透明——
 * 完整走父链，遇任意 CONTENT_MARK 清空其下全部候选（内容根自身与内容后代
 * 即使反射伪造品牌也不解析），走到根后再决议，循环内不返回——嵌套内容
 * 边界下伪造品牌在触达外层边界（会清空候选）前若即返会被接受（R12-2
 * 攻击链：outerContent > 伪造B > innerContent > hit 曾返回 'B'）。
 * 语义：最近有效品牌定格（候选只在「最近」处冻结一次）+ 任意内容边界清空
 * + 根处决议 ⇒ 最终候选 = 最外层内容边界上方最近品牌；objectId 非字符串
 * 的品牌（反射伪造）不冻结、不采纳。
 */
export function resolveOwnedIdAboveContent(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  let candidate: string | null = null;
  while (current) {
    if (isContentNode(current)) {
      candidate = null; // 任意内容边界：清空其下全部候选
    } else if (isOwnedNode(current) && candidate === null) {
      const objectId = current.userData.objectId;
      if (typeof objectId === 'string') candidate = objectId; // 最近有效品牌定格
    }
    current = current.parent;
  }
  return candidate;
}

const PRIMITIVE_GEOMETRIES: Record<string, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.6, 24, 24),
  cone: () => new THREE.ConeGeometry(0.5, 1, 24),
  torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 32),
  plane: () => new THREE.PlaneGeometry(1, 1),
};

/**
 * 释放几何/材质/纹理（撤销删除或重建节点时避免 GPU 泄漏）。
 * GLB 内容子树跳过：同一资源可被多个模型实例共享（clone 共享几何/材质），
 * 资源归 ContentCache 所有，最后一个 lease 释放时才 dispose（共享资源不会被
 * 先删除的实例误杀）。
 * 迭代栈替代 THREE 递归 traverse：深层链不爆栈（R8-7）；insideContent 状态
 * 随栈帧线程化（子节点继承父的标记或自身带 CONTENT_MARK），O(1) 内容归属判断，
 * 替代逐节点的 parent 链扫描（R9-M2）。
 */
export function disposeNode(object: THREE.Object3D, insideContent = false): void {
  const stack: { node: THREE.Object3D; insideContent: boolean }[] = [{ node: object, insideContent }];
  while (stack.length > 0) {
    const { node, insideContent: inherited } = stack.pop()!;
    const inside = inherited || !!readMark(node.userData, CONTENT_MARK);
    if (node instanceof THREE.Mesh && !inside) {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        material.dispose();
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            (value as THREE.Texture).dispose();
          }
        }
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, insideContent: inside });
    }
  }
}

/**
 * 节点身份键（R9-M2）：type 之外，light.kind / camera.projection / assetId
 * 变化同样构成身份分叉——旧类型/旧资源节点必须整棵重建，不得复用
 */
function nodeIdentityKey(data: SceneObjectData): string {
  switch (data.type) {
    case 'group':
      return 'group';
    case 'primitive':
      return 'primitive';
    case 'light':
      return `light:${data.light?.kind ?? ''}`;
    case 'camera':
      return `camera:${data.camera?.projection ?? ''}`;
    case 'model':
      return `model:${data.assetId ?? ''}`;
  }
}

export function applyTransform(object: THREE.Object3D, transform: TransformData): void {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  object.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2], 'XYZ');
  object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
}

/** 由对象数据构建 THREE 节点；userData.objectId 保留兼容读，所有权解析经品牌（R10-M2） */
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
  writeMark(node.userData, OBJECT_ID_MARK);
  node.userData.type = data.type;
  node.userData.identityKey = nodeIdentityKey(data);
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

/** 由对象数据迭代构建整棵子树（身份分叉重建用，R9-M2）：共享 childrenOf 索引、
 *  深链不爆栈；子树内节点按 next 数据重建，无需再走 applyObjectData。
 *  根与全部后代都登记进 idToNode（R10-M2）：pass-2 不再把已重建后代误判为
 *  缺失而重复创建 */
function buildSubtree(
  object: SceneObjectData,
  childrenOf: Map<string | null, string[]>,
  byId: Map<string, SceneObjectData>,
  aspect: number,
  idToNode: Map<string, THREE.Object3D>,
): THREE.Object3D {
  const root = buildObject(object, aspect);
  idToNode.set(object.id, root);
  const stack: { object: SceneObjectData; parent: THREE.Object3D }[] = [];
  const children = childrenOf.get(object.id);
  if (children) {
    for (let i = children.length - 1; i >= 0; i--) {
      const child = byId.get(children[i]!);
      if (child) stack.push({ object: child, parent: root });
    }
  }
  while (stack.length > 0) {
    const { object: childObject, parent } = stack.pop()!;
    const node = buildObject(childObject, aspect);
    idToNode.set(childObject.id, node);
    parent.add(node);
    const grandChildren = childrenOf.get(childObject.id);
    if (grandChildren) {
      for (let i = grandChildren.length - 1; i >= 0; i--) {
        const grand = byId.get(grandChildren[i]!);
        if (grand) stack.push({ object: grand, parent: node });
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
    // 内容子树整体跳过（R10-M2 双保险）：不读其 objectId、不下钻——即使伪造品牌
    if (isContentNode(node)) continue;
    if (isOwnedNode(node) && node.userData.objectId === objectId) return node;
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
 * 增量同步：对比前后项目，把对象变更应用到已构建的场景树（R8-4 / R9-M2）：
 * - 第一遍：身份分叉（identityKey 变化 = type/light.kind/camera.projection/
 *   assetId）自顶向下整体重建子树——只处理 topmost 分叉，子分叉随父重建，
 *   不重复处置；重建的模型 id 收集进 rebuiltModelIds 供内容重新挂载；
 * - 第二/三遍：先建全部缺失节点再统一挂载（恢复数组 child-first 不永久跳过）；
 * - 第四遍：既有节点数据更新（不含挂靠）；
 * - 第五遍：无条件 coordination——每个可达节点的实际父必须等于数据父
 *   （覆盖分叉重建后未变化子节点的重挂与普通重挂靠）；
 * - 第六遍：不可达节点收尾——从 root 视角遍历，首个不可达节点即该子树
 *   topmost，单次 disposeNode 整棵释放并跳过子树（消除逐节点重复处置）。
 * 所有权解析一律只读 OBJECT_ID_MARK 品牌（R10-M2）：原始 objectId 可伪造；
 * 遍历遇 CONTENT_MARK 整体跳过内容子树（glTF extras objectId 不可信，内容
 * 网格不得被登记/移除/处置）。
 */
export function syncScene(
  root: THREE.Group,
  previous: Project,
  next: Project,
  aspect: number,
): { rebuiltModelIds: string[] } {
  const idToNode = new Map<string, THREE.Object3D>();
  // 迭代遍历替代 root.traverse（THREE 递归）：深树不爆栈（R8-7）
  const traverseStack: THREE.Object3D[] = [root];
  while (traverseStack.length > 0) {
    const node = traverseStack.pop()!;
    if (isContentNode(node)) continue;
    if (isOwnedNode(node)) idToNode.set(node.userData.objectId as string, node);
    for (let i = node.children.length - 1; i >= 0; i--) traverseStack.push(node.children[i]!);
  }
  const prevById = new Map(previous.objects.map((o) => [o.id, o]));
  // 只同步活动场景可达对象：其他场景的编辑/新建/删除不进入当前视口（多场景隔离）
  const nextReachable = getReachableObjectIds(next);
  const byId = new Map(next.objects.map((o) => [o.id, o]));
  const childrenOf = new Map<string | null, string[]>();
  for (const object of next.objects) {
    const list = childrenOf.get(object.parentId);
    if (list) list.push(object.id);
    else childrenOf.set(object.parentId, [object.id]);
  }
  const rebuiltModelIds: string[] = [];

  // 第一遍：身份分叉 → topmost 整体重建子树
  const created: { node: THREE.Object3D; parentId: string | null }[] = [];
  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    const node = idToNode.get(object.id);
    if (!node) continue;
    if (node.userData.identityKey === nodeIdentityKey(object)) continue;
    // topmost 判定：THREE 侧祖先若也身份分叉 → 由祖先重建覆盖，本节点跳过
    let covered = false;
    let ancestor = node.parent;
    while (ancestor && ancestor !== root) {
      // 内容节点透明（R10-M2）：不可能参与身份分叉，跳过其数据继续上溯
      if (isContentNode(ancestor)) {
        ancestor = ancestor.parent;
        continue;
      }
      const ancestorId = isOwnedNode(ancestor) ? (ancestor.userData.objectId as string) : undefined;
      if (ancestorId) {
        const ancestorObject = byId.get(ancestorId);
        if (
          ancestorObject &&
          nextReachable.has(ancestorId) &&
          ancestor.userData.identityKey !== nodeIdentityKey(ancestorObject)
        ) {
          covered = true;
          break;
        }
      }
      ancestor = ancestor.parent;
    }
    if (covered) continue;
    // 整棵子树重建：释放旧子树（内容子树跳过处置）、索引删除全部旧品牌节点、重建
    node.parent?.remove(node);
    disposeNode(node);
    const removal: THREE.Object3D[] = [node];
    while (removal.length > 0) {
      const child = removal.pop()!;
      if (isContentNode(child)) continue;
      if (isOwnedNode(child)) idToNode.delete(child.userData.objectId as string);
      for (let i = child.children.length - 1; i >= 0; i--) removal.push(child.children[i]!);
    }
    const rebuilt = buildSubtree(object, childrenOf, byId, aspect, idToNode);
    created.push({ node: rebuilt, parentId: object.parentId ?? null });
    if (object.type === 'model') rebuiltModelIds.push(object.id);
  }

  // 第二遍：创建全部缺失节点（父节点要么早已存在、要么本遍已创建，全部可解析）
  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    if (idToNode.has(object.id)) continue;
    const createdNode = buildObject(object, aspect);
    idToNode.set(object.id, createdNode);
    created.push({ node: createdNode, parentId: object.parentId ?? null });
  }

  // 第三遍：统一挂载
  for (const { node, parentId } of created) {
    const parentNode = parentId ? idToNode.get(parentId) : null;
    (parentNode ?? root).add(node);
  }

  // 第四遍：既有节点数据更新（挂靠统一由 coordination 收口）
  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    const node = idToNode.get(object.id);
    if (!node) continue;
    const prev = prevById.get(object.id);
    if (prev && JSON.stringify(prev) !== JSON.stringify(object)) {
      applyObjectData(node, object, aspect);
    }
  }

  // 第五遍：无条件 coordination —— 实际父必须等于数据父。分叉重建后子节点
  // 仍挂在已释放的旧父实例下（数据 parentId 未变，第四遍不会触发），
  // 旧父不在 idToNode → expected 解析为新父 → add 自动重挂
  for (const object of next.objects) {
    if (!nextReachable.has(object.id)) continue;
    const node = idToNode.get(object.id);
    if (!node) continue;
    const expectedParent = object.parentId ? idToNode.get(object.parentId) ?? root : root;
    if (node.parent !== expectedParent) {
      expectedParent.add(node);
    }
  }

  // 第六遍：不可达节点收尾 —— 从 root 遍历，首个不可达节点即 topmost：
  // 单次 disposeNode 整棵释放并跳过其子树（无重复处置）；无 objectId 的内部
  // 节点（内容子树/占位符）随父保留，不下处置
  const removalStack: THREE.Object3D[] = [root];
  while (removalStack.length > 0) {
    const node = removalStack.pop()!;
    // 内容子树整体跳过（R10-M2）：内容网格即使带 extras objectId 也不被当
    // 不可达对象移除/处置（资源归 ContentCache 所有）
    if (isContentNode(node)) continue;
    const objectId = isOwnedNode(node) ? (node.userData.objectId as string) : undefined;
    if (objectId && nextReachable.has(objectId)) {
      for (let i = node.children.length - 1; i >= 0; i--) removalStack.push(node.children[i]!);
      continue;
    }
    if (objectId) {
      node.parent?.remove(node);
      disposeNode(node);
      continue;
    }
    for (let i = node.children.length - 1; i >= 0; i--) removalStack.push(node.children[i]!);
  }

  return { rebuiltModelIds };
}
