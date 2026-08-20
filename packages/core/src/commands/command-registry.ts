import { disposable, type Disposable } from '../disposable';
import type { EventMap } from '../events/event-map';
import { TypedEventEmitter } from '../events/typed-event-emitter';
import type { Project } from '../scene/types';
import type { PluginServices } from '../services';

/** 命令上下文的事件订阅面：只暴露订阅能力，不暴露 emit/dispose，插件无法操纵宿主总线 */
export interface CommandEventFacade {
  on<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable;
  once<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): Disposable;
  off<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void): void;
  onAny(handler: (event: string, payload: unknown) => void): Disposable;
}

export interface CommandContext {
  pluginId?: string;
  events: CommandEventFacade;
  commands: PluginCommands;
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
  /** 插件回调（如 when）抛错时上报，错误隔离不影响注册表与宿主 */
  onError?: (error: unknown) => void;
  /**
   * 为命令所属插件（ownerId = 插件 instanceId）提供 owner/代际绑定的命令与事件门面；
   * 返回 undefined 时回退到注册表默认上下文。宿主借此让停用后的旧上下文彻底失效。
   */
  contextFor?(ownerId: string): CommandContext | undefined;
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

// 底层注册表只经模块级 WeakMap 可达：TS private 在 JS 产物中可枚举，
// 而 WeakMap 键在运行时不可枚举、不可遍历，插件无法发现或绕过宿主注册表
const registryByFacade = new WeakMap<PluginCommands, CommandRegistry>();

/**
 * 插件可见的命令能力面：只读 + 执行，禁止绕过生命周期直接注册命令。
 * 插件添加命令必须经 context.contribute({ commands }) 提交 —— 由宿主代管，
 * 随停用/激活失败自动回收；直接注册会得到明确拒绝（旧 context 同样无法绕过）。
 */
export class PluginCommands {
  constructor(registry: CommandRegistry, private readonly isAlive: () => boolean) {
    registryByFacade.set(this, registry);
  }

  private registry(): CommandRegistry {
    if (!this.isAlive()) throw new Error('插件上下文已失效：命令能力面不可用');
    const registry = registryByFacade.get(this);
    if (!registry) throw new Error('插件上下文已失效：命令能力面不可用');
    return registry;
  }

  // async：门面失效抛错以拒绝 Promise 形式表达（与注册表 execute 的异步契约一致），
  // 插件端 await 与 catch 均按异步处理
  async execute(id: string, args?: unknown): Promise<CommandResult> {
    return this.registry().execute(id, args);
  }

  isAvailable(command: Command): boolean {
    return this.registry().isAvailable(command);
  }

  has(id: string): boolean {
    return this.registry().has(id);
  }

  get(id: string): Command | undefined {
    return this.registry().get(id);
  }

  list(): Command[] {
    return this.registry().list();
  }

  count(): number {
    return this.registry().count();
  }

  ownerOf(id: string): string | undefined {
    return this.registry().ownerOf(id);
  }

  /** 类型上不存在该成员；为 JS 消费方提供明确拒绝而非静默绕过生命周期 */
  register(): never {
    throw new Error('插件不得直接注册命令：请通过 context.contribute({ commands }) 提交，由宿主代管并随停用回收');
  }
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
  private readonly onError?: (error: unknown) => void;
  private readonly contextFor?: (ownerId: string) => CommandContext | undefined;
  private readonly fallbackEvents = new TypedEventEmitter<EventMap>();
  private disposedFlag = false;

  constructor(options: CommandRegistryOptions = {}) {
    this.events = options.events;
    this.getServices = options.getServices ?? (() => options.services ?? EMPTY_SERVICES);
    this.getProject = options.getProject ?? (() => null);
    this.onError = options.onError;
    this.contextFor = options.contextFor;
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
   * when 抛错时上报并视为不可用，异常命令不影响其它命令与宿主。
   */
  isAvailable(command: Command): boolean {
    const entry = this.entries.get(command.id);
    if (!entry) return false;
    try {
      return entry.command.when?.(this.createContext(entry.pluginId)) ?? true;
    } catch (error) {
      this.onError?.(error);
      return false;
    }
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
    // 宿主按 owner 提供代际绑定的命令/事件门面（停用后旧 context 失效）；
    // 无宿主（独立使用注册表）或查无门面时回退到注册表默认上下文
    const owned = pluginId ? this.contextFor?.(pluginId) : undefined;
    if (owned) return owned;
    return {
      pluginId,
      events: this.events ?? this.fallbackEvents,
      commands: new PluginCommands(this, () => true),
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
