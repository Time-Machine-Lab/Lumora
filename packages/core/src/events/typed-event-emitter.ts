import type { Disposable } from '../disposable';
import { disposable } from '../disposable';

export type EventHandler<P> = (payload: P) => void;

export interface TypedEventEmitterOptions {
  /** 处理器抛错时的统一出口，默认 console.error；错误不会向 emit 调用方传播 */
  onError?: (event: string, error: unknown) => void;
}

/**
 * 类型化事件总线。事件名到载荷的映射由 EventMap 声明，
 * 也允许插件通过索引签名发射自定义事件。
 */
export class TypedEventEmitter<E extends Record<string, unknown>> implements Disposable {
  private readonly handlers = new Map<string, Set<EventHandler<unknown>>>();
  private readonly anyHandlers = new Set<(event: string, payload: unknown) => void>();
  private readonly onError: (event: string, error: unknown) => void;
  private disposedFlag = false;
  /** 各事件名的分发生成代（第十轮 #1）：监听器回调内同步触发同一事件的嵌套
   *  emit 时，外层正在分发的 payload 已陈旧（新 payload 已先送达部分监听器），
   *  剩余监听器不得再收到旧值 —— 嵌套发生后外层分发立即终止（生成代不复原）。
   *  不同事件名的嵌套互不影响；串行 emit 各自持有新代，不受先前分发影响。 */
  private readonly emitGenerations = new Map<string, number>();

  constructor(options: TypedEventEmitterOptions = {}) {
    this.onError =
      options.onError ??
      ((event, error) => {
        console.error(`[lumora:events] 事件 "${event}" 的处理器抛错:`, error);
      });
  }

  on<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): Disposable {
    this.assertOpen();
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);
    return disposable(() => this.off(event, handler));
  }

  once<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): Disposable {
    const wrapped = (payload: E[K]) => {
      this.off(event, wrapped);
      handler(payload);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): void {
    this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  onAny(handler: (event: string, payload: unknown) => void): Disposable {
    this.assertOpen();
    this.anyHandlers.add(handler);
    return disposable(() => {
      this.anyHandlers.delete(handler);
    });
  }

  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    if (this.disposedFlag) return;
    const generation = (this.emitGenerations.get(event) ?? 0) + 1;
    this.emitGenerations.set(event, generation);
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of [...set]) {
        // 每个 handler 前检查终态与生成代：dispose 重入立即停止剩余监听器；
        // 同事件名的嵌套 emit（监听器内同步触发）使外层分发立即终止 ——
        // 陈旧 payload 不得在更新 payload 之后送达其余监听器
        if (this.disposedFlag || this.emitGenerations.get(event) !== generation) break;
        try {
          handler(payload);
        } catch (error) {
          this.onError(event, error);
        }
      }
    }
    for (const handler of [...this.anyHandlers]) {
      if (this.disposedFlag || this.emitGenerations.get(event) !== generation) break;
      try {
        handler(event, payload);
      } catch (error) {
        this.onError(event, error);
      }
    }
  }

  get handlerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count + this.anyHandlers.size;
  }

  /** 清空处理器但保持总线可用（区别于 dispose 的永久销毁） */
  clear(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }

  dispose(): void {
    this.disposedFlag = true;
    this.handlers.clear();
    this.anyHandlers.clear();
  }

  private assertOpen(): void {
    if (this.disposedFlag) throw new Error('事件总线已关闭');
  }
}
