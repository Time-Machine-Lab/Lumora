import { disposable, type Disposable } from '../disposable';
import type { EventMap } from '../events/event-map';
import { TypedEventEmitter } from '../events/typed-event-emitter';
import type { Project } from '../project';
import type { PluginServices } from '../services';

export interface CommandContext {
  pluginId?: string;
  events: TypedEventEmitter<EventMap>;
  commands: CommandRegistry;
  services: PluginServices;
  getProject(): Project | null;
}

export interface CommandResult {
  ok: boolean;
  error?: unknown;
  value?: unknown;
}

export interface Command {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  execute(args: unknown, context: CommandContext): CommandResult | Promise<CommandResult> | void | Promise<void>;
  /** 返回 false 表示当前不可用（如缺少项目） */
  when?(context: CommandContext): boolean;
}

export interface CommandRegistryOptions {
  events?: TypedEventEmitter<EventMap>;
  services?: PluginServices;
  /** 惰性服务提供者：宿主构造完成后再解析服务，避免注册表过早冻结空上下文 */
  getServices?: () => PluginServices;
  getProject?: () => Project | null;
}

const EMPTY_SERVICES: PluginServices = {
  assets: {
    load: async () => {
      throw new Error('当前运行环境未配置插件服务');
    },
  },
  ai: {
    chat(): AsyncIterable<string> {
      const error = new Error('当前运行环境未配置插件服务');
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw error;
          },
        }),
      };
    },
  },
  exporters: {
    run: async () => {
      throw new Error('当前运行环境未配置插件服务');
    },
  },
};

interface CommandEntry {
  command: Command;
  pluginId?: string;
}

function toCommandResult(value: unknown): CommandResult {
  if (value !== null && typeof value === 'object' && 'ok' in value) {
    return value as CommandResult;
  }
  return { ok: true };
}

/**
 * 命令注册表。命令 id 全局唯一，重复注册抛错；
 * execute 捕获处理器抛错并以 CommandResult 返回，不影响宿主。
 */
export class CommandRegistry {
  private readonly entries = new Map<string, CommandEntry>();
  private readonly events?: TypedEventEmitter<EventMap>;
  private readonly getServices: () => PluginServices;
  private readonly getProject: () => Project | null;
  private readonly fallbackEvents = new TypedEventEmitter<EventMap>();
  private disposedFlag = false;

  constructor(options: CommandRegistryOptions = {}) {
    this.events = options.events;
    this.getServices = options.getServices ?? (() => options.services ?? EMPTY_SERVICES);
    this.getProject = options.getProject ?? (() => null);
  }

  /** 注册命令；pluginId 为所属插件 id，注入到执行时的命令上下文 */
  register(command: Command, pluginId?: string): Disposable {
    if (this.disposedFlag) throw new Error('命令注册表已销毁');
    if (this.entries.has(command.id)) {
      throw new Error(`命令 id 重复: ${command.id}`);
    }
    this.entries.set(command.id, { command, pluginId });
    this.events?.emit('command:changed', { id: command.id, added: true });
    return disposable(() => {
      if (this.entries.delete(command.id)) {
        this.events?.emit('command:changed', { id: command.id, added: false });
      }
    });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): Command | undefined {
    return this.entries.get(id)?.command;
  }

  /** 返回命令所属插件 id（未注册时为 undefined） */
  ownerOf(id: string): string | undefined {
    return this.entries.get(id)?.pluginId;
  }

  /**
   * 以命令所属插件的上下文评估可用性（when）。与 execute 使用同一上下文构造，
   * 保证插件依赖 context.pluginId / services 的 when 判断与执行时一致。
   */
  isAvailable(command: Command): boolean {
    const entry = this.entries.get(command.id);
    if (!entry) return false;
    return entry.command.when?.(this.createContext(entry.pluginId)) ?? true;
  }

  list(): Command[] {
    return [...this.entries.values()].map((entry) => entry.command);
  }

  count(): number {
    return this.entries.size;
  }

  async execute(id: string, args?: unknown): Promise<CommandResult> {
    const entry = this.entries.get(id);
    if (!entry) {
      const result: CommandResult = { ok: false, error: new Error(`未知命令: ${id}`) };
      this.emitExecuted(id, result);
      return result;
    }
    try {
      const value = await entry.command.execute(args, this.createContext(entry.pluginId));
      const result = toCommandResult(value);
      this.emitExecuted(id, result);
      return result;
    } catch (error) {
      const result: CommandResult = { ok: false, error };
      this.emitExecuted(id, result);
      return result;
    }
  }

  private createContext(pluginId?: string): CommandContext {
    return {
      pluginId,
      events: this.events ?? this.fallbackEvents,
      commands: this,
      services: this.getServices(),
      getProject: this.getProject,
    };
  }

  private emitExecuted(id: string, result: CommandResult): void {
    this.events?.emit('command:executed', { id, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  dispose(): void {
    this.disposedFlag = true;
    this.entries.clear();
  }
}
