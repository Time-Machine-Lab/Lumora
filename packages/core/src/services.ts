import type { Asset, AiChatRequest, ExportResult } from './contributions/types';
import type { Project } from './project';

export interface AssetService {
  load(uri: string): Promise<Asset>;
}

export interface AiService {
  chat(providerId: string, request: AiChatRequest): AsyncIterable<string>;
}

export interface ExporterService {
  run(exporterId: string, project: Project): Promise<ExportResult>;
}

/** 宿主提供给插件与 UI 的统一服务门面 */
export interface PluginServices {
  assets: AssetService;
  ai: AiService;
  exporters: ExporterService;
}

interface ServiceRegistry {
  getAssetLoaders(): Array<{ id: string; name: string; extensions: string[]; load(uri: string): unknown }>;
  getAiProviders(): Array<{ id: string; name: string; models: string[]; chat(request: AiChatRequest): AsyncIterable<string> }>;
  getExporters(): Array<{ id: string; name: string; formats: string[]; export(project: Project): unknown }>;
}

export function createPluginServices(
  registry: ServiceRegistry,
  _getProject: () => Project | null,
): PluginServices {
  return {
    assets: {
      async load(uri) {
        const ext = extensionOf(uri);
        const loaders = registry.getAssetLoaders().filter((loader) =>
          ext !== null ? loader.extensions.includes(ext) : true,
        );
        const loader = loaders[0];
        if (!loader) {
          const available = registry.getAssetLoaders().flatMap((l) => l.extensions).join(', ') || '无';
          throw new Error(`没有可加载 "${uri}" 的资源加载器（扩展名 ${ext ?? '未知'}，可用: ${available}）`);
        }
        return (await loader.load(uri)) as Asset;
      },
    },
    ai: {
      async *chat(providerId, request) {
        const provider = registry.getAiProviders().find((p) => p.id === providerId);
        if (!provider) throw new Error(`未知 AI 提供方: ${providerId}`);
        if (!provider.models.includes(request.model)) {
          throw new Error(`模型 "${request.model}" 不受支持，可用: ${provider.models.join(', ')}`);
        }
        yield* provider.chat(request);
      },
    },
    exporters: {
      async run(exporterId, project) {
        const exporter = registry.getExporters().find((e) => e.id === exporterId);
        if (!exporter) throw new Error(`未知导出器: ${exporterId}`);
        return (await exporter.export(project)) as ExportResult;
      },
    },
  };
}

/** 提取 URI 扩展名（含前导点），无扩展名返回 null */
export function extensionOf(uri: string): string | null {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const match = /\.([a-z0-9]+(?:[.-][a-z0-9]+)*)$/i.exec(withoutQuery);
  return match ? match[0].toLowerCase() : null;
}
