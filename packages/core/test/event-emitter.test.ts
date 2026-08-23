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

  it('同事件名嵌套 emit 使外层分发终止：陈旧 payload 不送达剩余监听器（第十轮 #1）', () => {
    const bus: Bus = new TypedEventEmitter();
    let nested = false;
    // listener1 在收到外层载荷时同步嵌套发布同事件（模拟状态监听器回调内编辑）
    const listener1 = vi.fn((_payload: { uri: string }) => {
      if (!nested) {
        nested = true;
        bus.emit('project:closed', { uri: 'inner' });
      }
    });
    bus.on('project:closed', listener1);
    const listener2 = vi.fn();
    bus.on('project:closed', listener2);
    bus.emit('project:closed', { uri: 'outer' });
    // listener2 只收到嵌套分发的新值，绝不收到外层旧值（倒序送达）
    expect(listener1).toHaveBeenCalledTimes(2);
    expect(listener1).toHaveBeenNthCalledWith(1, { uri: 'outer' });
    expect(listener1).toHaveBeenNthCalledWith(2, { uri: 'inner' });
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledWith({ uri: 'inner' });
  });

  it('同事件名嵌套后 onAny 同样终止外层分发', () => {
    const bus: Bus = new TypedEventEmitter();
    const anyReceived: string[] = [];
    let nested = false;
    bus.on('project:closed', () => {
      if (!nested) {
        nested = true;
        bus.emit('project:closed', { uri: 'inner' });
      }
    });
    bus.onAny((event, payload) => {
      anyReceived.push(`${event}:${(payload as { uri: string }).uri}`);
    });
    bus.emit('project:closed', { uri: 'outer' });
    expect(anyReceived).toEqual(['project:closed:inner']);
  });

  it('不同事件名的嵌套 emit 不影响外层分发', () => {
    const bus: Bus = new TypedEventEmitter();
    const closed: string[] = [];
    bus.on('project:closed', (payload) => {
      closed.push(payload.uri);
      // 嵌套其他事件：同事件分发不被终止（生成代按事件名隔离）
      bus.emit('command:executed', { id: 'x', ok: true });
    });
    bus.on('project:closed', (payload) => closed.push(payload.uri));
    bus.emit('project:closed', { uri: 'a' });
    expect(closed).toEqual(['a', 'a']);
  });

  it('串行 emit（非嵌套）各自完整分发，生成代不串扰', () => {
    const bus: Bus = new TypedEventEmitter();
    const uris: string[] = [];
    bus.on('project:closed', (payload) => uris.push(payload.uri));
    bus.emit('project:closed', { uri: 'a' });
    bus.emit('project:closed', { uri: 'b' });
    expect(uris).toEqual(['a', 'b']);
  });
});
