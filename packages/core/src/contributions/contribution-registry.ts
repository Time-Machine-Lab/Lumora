import { DisposableSet, onceDisposable, type Disposable } from '../disposable';
import type { EventMap } from '../events/event-map';
import type { TypedEventEmitter } from '../events/typed-event-emitter';
import type { CommandRegistry } from '../commands/command-registry';
import type {
  AiProviderContribution,
  AssetLoaderContribution,
  ContributionBundle,
  ExporterContribution,
  PanelContribution,
  ToolbarContribution,
} from './types';

interface PanelEntry {
  pluginId: string;
  item: PanelContribution;
}

interface ToolbarEntry {
  pluginId: string;
  item: ToolbarContribution;
}

interface AssetLoaderEntry {
  pluginId: string;
  item: AssetLoaderContribution;
}

interface AiProviderEntry {
  pluginId: string;
  item: AiProviderContribution;
}

interface ExporterEntry {
  pluginId: string;
  item: ExporterContribution;
}

export interface ContributionRegistryOptions {
  events?: TypedEventEmitter<EventMap>;
  commands?: CommandRegistry;
}

/**
 * 六类贡献项注册表。contribute 采用两阶段（先校验后登记），
 * 任一贡献项非法时整体失败，不会留下半注册状态。
 */
export class ContributionRegistry {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly toolbars = new Map<string, ToolbarEntry>();
  private readonly assetLoaders = new Map<string, AssetLoaderEntry>();
  private readonly aiProviders = new Map<string, AiProviderEntry>();
  private readonly exporters = new Map<string, ExporterEntry>();
  private readonly events?: TypedEventEmitter<EventMap>;
  private readonly commands?: CommandRegistry;
  private disposedFlag = false;

  constructor(options: ContributionRegistryOptions = {}) {
    this.events = options.events;
    this.commands = options.commands;
  }

  /** 注册一批贡献项，返回一次性移除它们的 Disposable（幂等） */
  contribute(pluginId: string, bundle: ContributionBundle): Disposable {
    if (this.disposedFlag) throw new Error('贡献项注册表已销毁');
    const plan: Array<() => Disposable> = [];

    for (const item of bundle.panels ?? []) {
      this.assertUnique(this.panels, 'panel', item.id);
      plan.push(() => {
        this.panels.set(item.id, { pluginId, item });
        return onceDisposable(() => {
          this.panels.delete(item.id);
          this.emitChanged(pluginId);
        });
      });
    }

    for (const item of bundle.toolbars ?? []) {
      this.assertUnique(this.toolbars, 'toolbar', item.id);
      plan.push(() => {
        this.toolbars.set(item.id, { pluginId, item });
        return onceDisposable(() => {
          this.toolbars.delete(item.id);
          this.emitChanged(pluginId);
        });
      });
    }

    for (const item of bundle.assetLoaders ?? []) {
      this.assertUnique(this.assetLoaders, 'assetLoader', item.id);
      plan.push(() => {
        this.assetLoaders.set(item.id, { pluginId, item });
        return onceDisposable(() => {
          this.assetLoaders.delete(item.id);
          this.emitChanged(pluginId);
        });
      });
    }

    for (const item of bundle.aiProviders ?? []) {
      this.assertUnique(this.aiProviders, 'aiProvider', item.id);
      plan.push(() => {
        this.aiProviders.set(item.id, { pluginId, item });
        return onceDisposable(() => {
          this.aiProviders.delete(item.id);
          this.emitChanged(pluginId);
        });
      });
    }

    for (const item of bundle.exporters ?? []) {
      this.assertUnique(this.exporters, 'exporter', item.id);
      plan.push(() => {
        this.exporters.set(item.id, { pluginId, item });
        return onceDisposable(() => {
          this.exporters.delete(item.id);
          this.emitChanged(pluginId);
        });
      });
    }

    for (const item of bundle.commands ?? []) {
      if (!this.commands) {
        throw new Error('贡献项注册表未配置命令注册表，无法注册 command 贡献项');
      }
      if (this.commands.has(item.command.id)) {
        throw new Error(`贡献项 command 的 id 重复: ${item.command.id}`);
      }
      plan.push(() => this.commands!.register(item.command));
    }

    const disposables = plan.map((apply) => apply());
    this.events?.emit('plugin:contributed', { pluginId });
    this.emitChanged(pluginId);
    return DisposableSet.from(disposables);
  }

  private assertUnique<K>(map: Map<string, K>, kind: string, id: string): void {
    if (map.has(id)) throw new Error(`贡献项 ${kind} 的 id 重复: ${id}`);
  }

  private emitChanged(pluginId: string): void {
    this.events?.emit('contribution:changed', { pluginId });
  }

  getPanels(): Array<PanelContribution & { pluginId: string }> {
    return [...this.panels.values()].map(({ pluginId, item }) => ({ ...item, pluginId }));
  }

  getPanelsForPlugin(pluginId: string): Array<PanelContribution & { pluginId: string }> {
    return this.getPanels().filter((panel) => panel.pluginId === pluginId);
  }

  getToolbars(): Array<ToolbarContribution & { pluginId: string }> {
    return [...this.toolbars.values()]
      .map(({ pluginId, item }) => ({ ...item, pluginId }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  getAssetLoaders(): Array<AssetLoaderContribution & { pluginId: string }> {
    return [...this.assetLoaders.values()].map(({ pluginId, item }) => ({ ...item, pluginId }));
  }

  getAiProviders(): Array<AiProviderContribution & { pluginId: string }> {
    return [...this.aiProviders.values()].map(({ pluginId, item }) => ({ ...item, pluginId }));
  }

  getExporters(): Array<ExporterContribution & { pluginId: string }> {
    return [...this.exporters.values()].map(({ pluginId, item }) => ({ ...item, pluginId }));
  }

  count(): number {
    return this.panels.size + this.toolbars.size + this.assetLoaders.size + this.aiProviders.size + this.exporters.size;
  }

  dispose(): void {
    this.disposedFlag = true;
    this.panels.clear();
    this.toolbars.clear();
    this.assetLoaders.clear();
    this.aiProviders.clear();
    this.exporters.clear();
  }
}
