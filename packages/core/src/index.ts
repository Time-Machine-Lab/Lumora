// 资源管理
export { DisposableSet, disposable, isDisposable, noopDisposable, onceDisposable } from './disposable';
export type { Disposable, DisposeFn } from './disposable';

// 事件总线
export { TypedEventEmitter } from './events/typed-event-emitter';
export type { EventHandler, TypedEventEmitterOptions } from './events/typed-event-emitter';
export type { EventMap } from './events/event-map';

// 项目
export { createSampleProject } from './project';
export type { Project, SceneObjectData, SceneObjectKind } from './project';

// Manifest v1
export { manifestSchema, validateManifest } from './manifest/validate';
export type { Manifest, ManifestValidationResult } from './manifest/validate';
export { checkEngineCompatibility } from './manifest/engine';
export type { EngineCheckResult } from './manifest/engine';

// 命令
export { CommandRegistry } from './commands/command-registry';
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
