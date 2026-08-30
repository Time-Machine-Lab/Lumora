import { describe, expect, it, vi } from 'vitest';
import { LiveTransformStore } from '../src/components/editor/live-transform-store';

describe('LiveTransformStore', () => {
  it('publishes changed live node positions and suppresses identical frame snapshots', () => {
    const store = new LiveTransformStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.publish('camera-a', [1, 2, 3]);
    const first = store.getSnapshot();
    expect(first).toEqual({ objectId: 'camera-a', position: [1, 2, 3] });
    expect(listener).toHaveBeenCalledTimes(1);

    store.publish('camera-a', [1, 2, 3]);
    expect(store.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    store.publish('camera-a', [1, 2, 4]);
    expect(store.getSnapshot()).toEqual({ objectId: 'camera-a', position: [1, 2, 4] });
    expect(listener).toHaveBeenCalledTimes(2);

    store.clear('camera-b');
    expect(listener).toHaveBeenCalledTimes(2);
    store.clear('camera-a');
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
  });
});
