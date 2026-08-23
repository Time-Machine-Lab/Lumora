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

  it('发生型事件（project:closed）同事件名嵌套 emit 互不截断：每个 payload 完整送达全部监听器（第十二轮严重 #3）', () => {
    const bus: Bus = new TypedEventEmitter();
    let nested = false;
    // listener1 在收到外层载荷时同步嵌套发布同事件（发生型事件不传 latestWins）
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
    // 发生型事件不做代际失效：嵌套分发互不截断 —— 两个 payload 都完整送达全部
    // 监听器（修复前外层分发被嵌套终止，listener2 收不到 outer）。送达顺序由
    // 嵌套语义决定：listener1 在收到 outer 时同步触发 inner 分发，内层先完整
    // 送达，外层剩余监听器随后收到 outer
    expect(listener1).toHaveBeenCalledTimes(2);
    expect(listener1).toHaveBeenNthCalledWith(1, { uri: 'outer' });
    expect(listener1).toHaveBeenNthCalledWith(2, { uri: 'inner' });
    expect(listener2).toHaveBeenCalledTimes(2);
    expect(listener2).toHaveBeenNthCalledWith(1, { uri: 'inner' });
    expect(listener2).toHaveBeenNthCalledWith(2, { uri: 'outer' });
  });

  it('发生型事件（project:closed）嵌套后 onAny 同样收到全部 payload', () => {
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
    // 嵌套语义：外层 handler 触发 inner 分发（内层 anyHandlers 先执行），
    // 外层 anyHandlers 随后执行 —— 两个 payload 都送达 onAny
    expect(anyReceived).toEqual(['project:closed:inner', 'project:closed:outer']);
  });

  it('latest-wins 事件（显式 opt-in）同事件名嵌套 emit 终止外层分发：陈旧 payload 不送达剩余监听器（第十轮 #1 + 第十二轮严重 #3）', () => {
    // save-state 是 latest-wins 状态事件：监听器回调内同步提交编辑会嵌套触发新的
    // save-state，外层陈旧状态不得在更新状态之后送达其余监听器
    type StateBus = TypedEventEmitter<{ 'save-state': { state: string }; [event: string]: unknown }>;
    const bus: StateBus = new TypedEventEmitter();
    let nested = false;
    const listener1 = vi.fn((_payload: { state: string }) => {
      if (!nested) {
        nested = true;
        bus.emit('save-state', { state: 'saving' }, { latestWins: true });
      }
    });
    bus.on('save-state', listener1);
    const listener2 = vi.fn();
    bus.on('save-state', listener2);
    bus.emit('save-state', { state: 'clean' }, { latestWins: true });
    // listener2 只收到嵌套分发的新值，绝不收到外层旧值（倒序送达）
    expect(listener1).toHaveBeenCalledTimes(2);
    expect(listener1).toHaveBeenNthCalledWith(1, { state: 'clean' });
    expect(listener1).toHaveBeenNthCalledWith(2, { state: 'saving' });
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledWith({ state: 'saving' });
  });

  it('latest-wins 事件嵌套后 onAny 同样终止外层分发', () => {
    type StateBus = TypedEventEmitter<{ 'save-state': { state: string }; [event: string]: unknown }>;
    const bus: StateBus = new TypedEventEmitter();
    const anyReceived: string[] = [];
    let nested = false;
    bus.on('save-state', () => {
      if (!nested) {
        nested = true;
        bus.emit('save-state', { state: 'saving' }, { latestWins: true });
      }
    });
    bus.onAny((event, payload) => {
      anyReceived.push(`${event}:${(payload as { state: string }).state}`);
    });
    bus.emit('save-state', { state: 'clean' }, { latestWins: true });
    expect(anyReceived).toEqual(['save-state:saving']);
  });

  it('latest-wins 与发生型事件相互嵌套互不影响：代际按事件名与 opt-in 隔离', () => {
    type StateBus = TypedEventEmitter<{ 'save-state': { state: string }; [event: string]: unknown }>;
    const bus: StateBus = new TypedEventEmitter();
    const closed: string[] = [];
    bus.on('project:closed', (payload) => {
      closed.push((payload as { uri: string }).uri);
      // 发生型事件回调内嵌套 latest-wins：save-state 分发不被终止
      bus.emit('save-state', { state: 'saving' }, { latestWins: true });
    });
    bus.on('project:closed', (payload) => closed.push((payload as { uri: string }).uri));
    bus.emit('project:closed', { uri: 'a' });
    expect(closed).toEqual(['a', 'a']);
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
