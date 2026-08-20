export { LumoraStudio } from './components/LumoraStudio';
export type { LumoraStudioHandle, LumoraStudioProps } from './components/LumoraStudio';
export { SceneView } from './components/SceneView';
export { PanelErrorBoundary } from './components/panels/PanelErrorBoundary';
export { createStudioRuntime } from './runtime/studio-runtime';
export type { StudioRuntime, StudioRuntimeOptions } from './runtime/studio-runtime';

// 便捷再导出：宿主与插件常见类型
export { createSampleProject, PluginHost, TypedEventEmitter } from '@lumora/core';
export type {
  ContributionBundle,
  EventMap,
  Manifest,
  PanelComponent,
  PanelContextProps,
  PluginDescriptor,
  PluginInfo,
  Project,
  SceneObjectData,
} from '@lumora/core';
