import type { ComponentType } from 'react';
import type { CommandRegistry } from '../commands/command-registry';
import type { EventMap } from '../events/event-map';
import type { TypedEventEmitter } from '../events/typed-event-emitter';
import type { Project } from '../scene/types';
import type { PluginServices } from '../services';

export const CONTRIBUTION_KINDS = [
  'panel',
  'command',
  'toolbar',
  'assetLoader',
  'aiProvider',
  'exporter',
] as const;

export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

// ---------- panel ----------

export type PanelPosition = 'left' | 'right' | 'bottom';

/** 面板组件接收的上下文 props */
export interface PanelContextProps {
  pluginId: string;
  project: Project | null;
  events: TypedEventEmitter<EventMap>;
  commands: CommandRegistry;
  services: PluginServices;
  hostVersion: string;
}

export type PanelComponent = ComponentType<PanelContextProps>;

export interface PanelContribution {
  kind: 'panel';
  id: string;
  title: string;
  icon?: string;
  position?: PanelPosition;
  component: PanelComponent;
}

// ---------- toolbar ----------

export interface ToolbarContribution {
  kind: 'toolbar';
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  commandId: string;
  /** 升序排列，越小越靠左 */
  order?: number;
}

// ---------- command ----------

export interface CommandContribution {
  kind: 'command';
  command: import('../commands/command-registry').Command;
}

// ---------- assetLoader ----------

export interface Asset {
  uri: string;
  mime?: string;
  data: unknown;
}

export interface AssetLoaderContribution {
  kind: 'assetLoader';
  id: string;
  name: string;
  /** 支持的文件扩展名，含前导点，如 ".mock.json" */
  extensions: string[];
  load(uri: string): Promise<Asset> | Asset;
}

// ---------- aiProvider ----------

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AiChatRequest {
  model: string;
  messages: AiChatMessage[];
  signal?: AbortSignal;
}

export interface AiProviderContribution {
  kind: 'aiProvider';
  id: string;
  name: string;
  models: string[];
  /** 流式返回文本块 */
  chat(request: AiChatRequest): AsyncIterable<string>;
}

// ---------- exporter ----------

export interface ExportResult {
  fileName: string;
  mime: string;
  data: string;
}

export interface ExporterContribution {
  kind: 'exporter';
  id: string;
  name: string;
  formats: string[];
  export(project: Project): Promise<ExportResult> | ExportResult;
}

// ---------- bundle ----------

/** 插件在 activate 中一次性提交的贡献项集合 */
export interface ContributionBundle {
  panels?: PanelContribution[];
  commands?: CommandContribution[];
  toolbars?: ToolbarContribution[];
  assetLoaders?: AssetLoaderContribution[];
  aiProviders?: AiProviderContribution[];
  exporters?: ExporterContribution[];
}
