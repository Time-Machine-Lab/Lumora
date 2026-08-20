export type DisposeFn = () => void | Promise<void>;

export interface Disposable {
  dispose(): void | Promise<void>;
}

export function disposable(fn: DisposeFn): Disposable {
  return { dispose: fn };
}

export const noopDisposable: Disposable = { dispose: () => {} };

export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}

/** 幂等包装：重复调用 dispose 只执行一次 */
export function onceDisposable(fn: DisposeFn): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      return fn();
    },
  };
}

function normalize(item: Disposable | DisposeFn): Disposable {
  return typeof item === 'function' ? disposable(item) : item;
}

/**
 * 可组合的资源集合。插件激活期产生的所有贡献项、命令、订阅都应归入集合，
 * 停用/卸载时统一释放；单个条目抛错不影响其余条目执行。
 */
export class DisposableSet implements Disposable {
  static from(items: Iterable<Disposable | DisposeFn | null | undefined>): DisposableSet {
    const set = new DisposableSet();
    for (const item of items) {
      if (item != null) set.add(item);
    }
    return set;
  }

  private readonly items = new Set<Disposable>();
  private disposedFlag = false;

  get size(): number {
    return this.items.size;
  }

  get isDisposed(): boolean {
    return this.disposedFlag;
  }

  get disposables(): readonly Disposable[] {
    return [...this.items];
  }

  add(item: Disposable | DisposeFn): this {
    if (this.disposedFlag) {
      void normalize(item).dispose();
      return this;
    }
    this.items.add(normalize(item));
    return this;
  }

  delete(item: Disposable | DisposeFn): boolean {
    return this.items.delete(normalize(item));
  }

  async dispose(): Promise<void> {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    const items = [...this.items];
    this.items.clear();
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        await item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} 个资源释放失败`);
  }
}
