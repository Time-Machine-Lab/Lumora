export { defineManifest, definePlugin } from './define-plugin';

// 生命周期与上下文
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
} from '@lumora/core';

// 事件
export type { EventMap } from '@lumora/core';

// Manifest v1
export type { Manifest, ManifestValidationResult } from '@lumora/core';

// 贡献项协议
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
} from '@lumora/core';

export {
  AI_REFERENCE_IMAGE_GENERATE_CAPABILITY,
  AI_STORYBOARD_GENERATE_CAPABILITY,
  AiProviderRequestError,
  STORYBOARD_CAMERA_MOVEMENTS,
  STORYBOARD_SHOT_SIZES,
} from '@lumora/core';
export type {
  AiCostEstimate,
  AiProviderErrorCode,
  AiProviderErrorData,
  AiReferenceImageCapability,
  AiReferenceImageRequest,
  AiReferenceImageResult,
  AiStoryboardCapability,
  CreativeBrief,
  GenerationTask,
  StoryboardCameraMovement,
  StoryboardDraft,
  StoryboardDraftPayload,
  StoryboardDraftShot,
  StoryboardGenerateRequest,
  StoryboardModelDescriptor,
  StoryboardModelCatalog,
  StoryboardProviderInfo,
  StoryboardShotSize,
} from '@lumora/core';

// 命令
export type { Command, CommandContext, CommandResult } from '@lumora/core';

// 资源与项目
export type { Disposable, DisposeFn } from '@lumora/core';
export { DisposableSet, disposable, isDisposable, noopDisposable, onceDisposable } from '@lumora/core';
export { createSampleProject } from '@lumora/core';
export type { Project, SceneObjectData, SceneObjectKind } from '@lumora/core';
