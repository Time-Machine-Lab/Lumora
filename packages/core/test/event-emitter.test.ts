import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from '../src/events/typed-event-emitter';
import { createSampleProject } from '../src/scene/sample-project';
import type { EventMap } from '../src/events/event-map';

type Bus = TypedEventEmitter<EventMap>;

const projectA = createSampleProject('lumora://a', 'A');
const projectB = createSampleProject('lumora://b', 'B');

describe('TypedEventEmitter', () => {
  it('on/emit 传递载荷，返回的 Disposable 可移除订阅', () => {
    const bus: Bus = new TypedEventEmitter();
    const handler = vi.fn();
    const sub = bus.on('project:opened', handler);
    bus.emit('project:opened', { uri: 'lumora://a', name: 'A', project: projectA });
    expect(handler).toHaveBeenCalledTimes(1);
    sub.dispose();
    bus.emit('project:opened', { uri: 'lumora://b', name: 'B', project: projectB });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('once 只触发一次', () => {
    const bus: Bus = new TypedEventEmitter();
    const handler = vi.fn();
    bus.once('project:closed', handler);
    bus.emit('project:closed', { uri: 'a' });
    bus.emit('project:closed', { uri: 'b' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('处理器抛错不传播，其它处理器继续执行，错误交给 onError', () => {
    const onError = vi.fn();
    const bus: Bus = new TypedEventEmitter({ onError });
    const ok = vi.fn();
    bus.on('project:opened', () => {
      throw new Error('boom');
    });
    bus.on('project:opened', ok);
    const payload = { uri: 'x', name: 'x', project: projectA };
    expect(() => bus.emit('project:opened', payload)).not.toThrow();
    expect(ok).toHaveBeenCalledWith(payload);
    expect(onError).toHaveBeenCalledWith('project:opened', expect.any(Error));
  });

  it('onAny 监听全部事件', () => {
    const bus: Bus = new TypedEventEmitter();
    const handler = vi.fn();
    bus.onAny(handler);
    bus.emit('project:closed', { uri: 'a' });
    bus.emit('command:executed', { id: 'x', ok: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('project:closed', { uri: 'a' });
  });

  it('支持索引签名自定义事件', () => {
    const bus: Bus = new TypedEventEmitter();
    const handler = vi.fn();
    bus.on('mock:ping' as never, handler as never);
    bus.emit('mock:ping' as never, { at: 1 } as never);
    expect(handler).toHaveBeenCalledWith({ at: 1 });
  });

  it('dispose 清空全部订阅', () => {
    const bus: Bus = new TypedEventEmitter();
    bus.on('project:closed', vi.fn());
    bus.onAny(vi.fn());
    expect(bus.handlerCount).toBe(2);
    bus.dispose();
    expect(bus.handlerCount).toBe(0);
    expect(() => bus.emit('project:closed', { uri: 'a' })).not.toThrow();
  });
});
