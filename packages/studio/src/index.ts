export { LumoraStudio } from './components/LumoraStudio';
export type { LumoraStudioHandle, LumoraStudioProps } from './components/LumoraStudio';
export { EditorViewport } from './components/editor/EditorViewport';
export { ObjectTree } from './components/editor/ObjectTree';
export { PropertiesPanel } from './components/editor/PropertiesPanel';
export { ContentCache } from './components/editor/content-cache';
export type { CacheLease, CachePartFile, CacheFormat } from './components/editor/content-cache';
export { importModelFile } from './components/editor/model-import';
export { buildScene, syncScene } from './components/editor/scene-builder';
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
