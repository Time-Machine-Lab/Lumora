/** 场景数据模型（Project v2）：对象为扁平列表 + 场景根引用，构成可序列化层级。 */

export type Vec3 = [number, number, number];

export interface TransformData {
  /** 平移（世界/父级局部坐标） */
  position: Vec3;
  /** 欧拉角（弧度，XYZ 顺序） */
  rotation: Vec3;
  /** 缩放 */
  scale: Vec3;
}

export type PrimitiveKind = 'box' | 'sphere' | 'cone' | 'torus' | 'plane';

export type SceneObjectType = 'group' | 'model' | 'primitive' | 'light' | 'camera';
/** 场景对象类型别名（插件 SDK 导出名） */
export type SceneObjectKind = SceneObjectType;
/** 场景对象类型全集：运行时成员校验（isSceneObject 与 EditorState 共用） */
export const SCENE_OBJECT_TYPES = ['group', 'model', 'primitive', 'light', 'camera'] as const;

export interface GeometryData {
  kind: PrimitiveKind;
}

export interface MaterialData {
  color: string;
}

export type LightKind = 'directional' | 'point' | 'spot';

export interface LightData {
  kind: LightKind;
  color: string;
  intensity: number;
  /** point/spot 光照衰减距离 */
  distance?: number;
  /** spot 光锥半角（弧度） */
  angle?: number;
}

export interface CameraData {
  /** 产品范围决定（R10）：orthographic 暂不支持，schema 明确拒绝 */
  projection: 'perspective';
  /** 焦距（mm），与 fov 联动 */
  focalLength: number;
  /** 垂直视场角（度） */
  fov: number;
  /** 传感器尺寸（mm），默认全画幅 36×24 */
  sensorWidth: number;
  sensorHeight: number;
  near: number;
  far: number;
  /** null 表示跟随项目画幅 */
  aspect: number | null;
}

export interface SceneObjectData {
  /** 稳定 ID，不随重命名变化 */
  id: string;
  type: SceneObjectType;
  name: string;
  parentId: string | null;
  transform: TransformData;
  visible: boolean;
  /** 锁定对象不可变换、不可删除、不可变更层级 */
  locked: boolean;
  geometry?: GeometryData;
  material?: MaterialData;
  light?: LightData;
  camera?: CameraData;
  /** 模型对象引用的资源 ID */
  assetId?: string;
}

export interface SceneData {
  id: string;
  name: string;
  rootObjectIds: string[];
  activeCameraId: string | null;
}

export interface ProjectSettings {
  fps: number;
  /** 画幅宽高比，如 [16, 9] */
  aspect: [number, number];
}

/** 多文件 .gltf 的外部依赖（.bin/纹理）：路径按 gltf JSON 相对 URI，载荷 base64 */
export interface AssetPartData {
  path: string;
  mime: string;
  payload: string;
}

export interface AssetData {
  id: string;
  kind: 'gltf';
  name: string;
  /** 内容格式（重开项目时据此重建缓存，不依赖运行期 MIME）；旧数据缺省时按名称/MIME 决议 */
  format?: 'gltf' | 'glb';
  mime: string;
  /** 内容哈希（SHA-256 hex），用于去重 */
  hash: string;
  size: number;
  source: 'file' | 'url';
  /** 资产存储引用（内存中为 object URL；持久化由后续任务接入） */
  storageRef: string;
  /** 模型字节的 base64 载荷：随项目 JSON 持久化，重开项目/重做后据此重建内容缓存 */
  payload?: string;
  /** 多文件 .gltf 的外部依赖字节；主载荷为 gltf JSON 本身 */
  parts?: AssetPartData[];
  createdAt: string;
}

export interface Project {
  uri: string;
  name: string;
  schemaVersion: 2;
  createdAt: string;
  /** 每次提交可撤销变更 +1，用于自动保存判断 */
  revision: number;
  settings: ProjectSettings;
  activeSceneId: string;
  scenes: SceneData[];
  /** 扁平对象列表；层级经 parentId 表达，场景经 rootObjectIds 归属 */
  objects: SceneObjectData[];
  assets: AssetData[];
  /**
   * 插件私有设置（按插件 instanceId 键控）：随项目本地持久化，
   * 但导出 `.lumora` 工程包时默认排除（见 project/package.ts）。
   * 值必须是 JSON 纯结构（整树会被 deepFreeze）。
   */
  pluginData?: Record<string, unknown>;
}

export function isSceneObject(obj: unknown): obj is SceneObjectData {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Partial<SceneObjectData>;
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    (SCENE_OBJECT_TYPES as readonly string[]).includes(o.type) &&
    typeof o.name === 'string' &&
    (o.parentId === null || typeof o.parentId === 'string') &&
    !!o.transform &&
    typeof o.visible === 'boolean' &&
    typeof o.locked === 'boolean'
  );
}
