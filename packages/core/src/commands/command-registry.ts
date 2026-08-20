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
  private readonly commands = new Map<string, Command>();
  private readonly events?: TypedEventEmitter<EventMap>;
  private readonly services: PluginServices;
  private readonly getProject: () => Project | null;
  private readonly fallbackEvents = new TypedEventEmitter<EventMap>();
  private disposedFlag = false;

  constructor(options: CommandRegistryOptions = {}) {
    this.events = options.events;
    this.services = options.services ?? EMPTY_SERVICES;
    this.getProject = options.getProject ?? (() => null);
  }

  register(command: Command): Disposable {
    if (this.disposedFlag) throw new Error('命令注册表已销毁');
    if (this.commands.has(command.id)) {
      throw new Error(`命令 id 重复: ${command.id}`);
    }
    this.commands.set(command.id, command);
    this.events?.emit('command:changed', { id: command.id, added: true });
    return disposable(() => {
      if (this.commands.delete(command.id)) {
        this.events?.emit('command:changed', { id: command.id, added: false });
      }
    });
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  list(): Command[] {
    return [...this.commands.values()];
  }

  count(): number {
    return this.commands.size;
  }

  async execute(id: string, args?: unknown): Promise<CommandResult> {
    const command = this.commands.get(id);
    if (!command) {
      const result: CommandResult = { ok: false, error: new Error(`未知命令: ${id}`) };
      this.emitExecuted(id, result);
      return result;
    }
    try {
      const value = await command.execute(args, this.createContext());
      const result = toCommandResult(value);
      this.emitExecuted(id, result);
      return result;
    } catch (error) {
      const result: CommandResult = { ok: false, error };
      this.emitExecuted(id, result);
      return result;
    }
  }

  private createContext(): CommandContext {
    return {
      events: this.events ?? this.fallbackEvents,
      commands: this,
      services: this.services,
      getProject: this.getProject,
    };
  }

  private emitExecuted(id: string, result: CommandResult): void {
    this.events?.emit('command:executed', { id, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  dispose(): void {
    this.disposedFlag = true;
    this.commands.clear();
  }
}
