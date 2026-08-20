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
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          this.onError(event, error);
        }
      }
    }
    for (const handler of [...this.anyHandlers]) {
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
