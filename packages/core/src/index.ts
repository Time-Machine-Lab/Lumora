// 资源管理
export { DisposableSet, disposable, isDisposable, noopDisposable, onceDisposable } from './disposable';
export type { Disposable, DisposeFn } from './disposable';

// 事件总线
export { TypedEventEmitter } from './events/typed-event-emitter';
export type { EventHandler, TypedEventEmitterOptions } from './events/typed-event-emitter';
export type { EventMap } from './events/event-map';

// 场景数据模型（Project v2）
export { createSampleProject } from './scene/sample-project';
export type {
  AssetData,
  CameraData,
  GeometryData,
  LightData,
  LightKind,
  MaterialData,
  PrimitiveKind,
  Project,
  ProjectSettings,
  SceneData,
  SceneObjectData,
  SceneObjectKind,
  SceneObjectType,
  TransformData,
  Vec3,
} from './scene/types';
export { isSceneObject } from './scene/types';
export {
  addAsset,
  collectUnreferencedAssets,
  findAssetByHash,
  findObject,
  getActiveScene,
  getAssetById,
  getChildIds,
  getChildren,
  getDescendantIds,
  getReachableIds,
  getScene,
  getSceneRoots,
  isFiniteNumber,
  isInActiveScene,
  isInSubtree,
  isValidTransform,
  isValidVec3,
  removeAssets,
  removeObjects,
  updateObject,
  updateObjectById,
} from './scene/scene-graph';
export {
  createCameraObject,
  createGroupObject,
  createLightObject,
  createMaterial,
  createModelObject,
  createPrimitiveObject,
  createScene,
  defaultName,
  defaultTransform,
  genId,
} from './scene/create';
export { fnv1aHex, hashBytes } from './scene/assets';
export { fovDegToFocalLength, focalLengthToFovDeg, fitRect, FULL_FRAME_SENSOR } from './scene/camera-math';

// 历史与场景编辑器
export { HistoryStack } from './history/history';
export type { HistoryEntry } from './history/history';
export { SceneEditor } from './editor/scene-editor';
export type {
  EditorEventMap,
  Result,
  TransformMode,
  TransformSpace,
  ViewMode,
  ViewState,
} from './editor/scene-editor';

// Manifest v1
export { manifestSchema, validateManifest } from './manifest/validate';
export type { Manifest, ManifestValidationResult } from './manifest/validate';
export { checkEngineCompatibility } from './manifest/engine';
export type { EngineCheckResult } from './manifest/engine';

// 命令
export { CommandRegistry, PluginCommands } from './commands/command-registry';
export type { Command, CommandContext, CommandResult, CommandRegistryOptions } from './commands/command-registry';

// 贡献项
export { CONTRIBUTION_KINDS } from './contributions/types';
export type {
  AiChatMessage,
  AiChatRequest,
  AiProviderContribution,
  Asset,
  AssetLoaderContribution,
  CommandContribution,
  ContributionBundle,
  ContributionKind,
  ExporterContribution,
  ExportResult,
  PanelComponent,
  PanelContextProps,
  PanelContribution,
  PanelPosition,
  ToolbarContribution,
} from './contributions/types';
export { ContributionRegistry } from './contributions/contribution-registry';
export type { ContributionRegistryOptions } from './contributions/contribution-registry';

// 服务
export { createPluginServices } from './services';
export type { AiService, AssetService, ExporterService, PluginServices } from './services';

// 插件宿主
export { PluginHost } from './host/plugin-host';
export type { PluginHostOptions } from './host/plugin-host';
export type {
  PluginActivateFn,
  PluginContext,
  PluginDeactivateFn,
  PluginDefinition,
  PluginDescriptor,
  PluginEventBus,
  PluginInfo,
  PluginModule,
  PluginState,
} from './host/types';
