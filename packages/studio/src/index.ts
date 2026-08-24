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
export { ProjectStore } from './persistence/project-store';
export { OpfsProjectStore } from './persistence/project-store-opfs';
export { estimateStorage } from './persistence/project-storage';
export type {
  DuplicateOutcome,
  ProjectStorage,
  ProjectSummary,
  RenameOutcome,
  SaveOutcome,
  StorageBackend,
  StoredProject,
} from './persistence/project-storage';
export { ProjectAutosaver, AUTOSAVE_DEBOUNCE_MS } from './persistence/autosave';
export type { AutosaverOptions, AutosaveState } from './persistence/autosave';
export { ProjectPersistence } from './persistence/project-persistence';
export type { ExportResult, ImportResult, PersistenceEventMap, RenameResult } from './persistence/project-persistence';

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
