import { describe, expect, it, vi } from 'vitest';
import { DisposableSet, disposable, onceDisposable } from '../src/disposable';

describe('disposable', () => {
  it('disposable() 包装函数并只调用一次底层逻辑（幂等由调用方保证）', () => {
    const fn = vi.fn();
    const d = disposable(fn);
    expect(d.dispose()).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DisposableSet 顺序释放全部条目，即使其中某个抛错', async () => {
    const order: string[] = [];
    const set = new DisposableSet();
    set.add(() => {
      order.push('a');
    });
    set.add(disposable(() => {
      order.push('b');
    }));
    set.add(() => {
      order.push('c');
      throw new Error('c 失败');
    });
    set.add(() => {
      order.push('d');
    });
    await expect(set.dispose()).rejects.toThrow('c 失败');
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(set.size).toBe(0);
  });

  it('DisposableSet 重复 dispose 为空操作', async () => {
    const fn = vi.fn();
    const set = DisposableSet.from([fn]);
    await set.dispose();
    await set.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dispose 后 add 的条目立即释放', async () => {
    const late = vi.fn();
    const set = new DisposableSet();
    await set.dispose();
    set.add(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('onceDisposable 幂等', async () => {
    const fn = vi.fn();
    const d = onceDisposable(fn);
    await d.dispose();
    await d.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
