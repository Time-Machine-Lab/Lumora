import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../src/commands/command-registry';
import type { Command } from '../src/commands/command-registry';
import { TypedEventEmitter } from '../src/events/typed-event-emitter';
import type { EventMap } from '../src/events/event-map';
import { createSampleProject } from '../src/scene/sample-project';

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'test.cmd',
    title: '测试命令',
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

describe('CommandRegistry', () => {
  it('注册、查询、列出命令', () => {
    const registry = new CommandRegistry();
    const sub = registry.register(makeCommand());
    expect(registry.has('test.cmd')).toBe(true);
    expect(registry.get('test.cmd')?.title).toBe('测试命令');
    expect(registry.list()).toHaveLength(1);
    sub.dispose();
    expect(registry.has('test.cmd')).toBe(false);
  });

  it('重复 id 注册抛错', () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand());
    expect(() => registry.register(makeCommand())).toThrow('重复');
  });

  it('execute 成功返回结果并发出 command:executed 事件', async () => {
    const events = new TypedEventEmitter<EventMap>();
    const executed = vi.fn();
    events.on('command:executed', executed);
    const registry = new CommandRegistry({ events });
    registry.register(
      makeCommand({
        execute: (args) => ({ ok: true, value: args }),
      }),
    );
    const result = await registry.execute('test.cmd', { n: 1 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ n: 1 });
    expect(executed).toHaveBeenCalledWith({ id: 'test.cmd', ok: true, error: undefined });
  });

  it('execute 捕获处理器抛错并以结果返回', async () => {
    const registry = new CommandRegistry();
    registry.register(
      makeCommand({
        execute: () => {
          throw new Error('命令失败');
        },
      }),
    );
    const result = await registry.execute('test.cmd');
    expect(result.ok).toBe(false);
    expect((result.error as Error).message).toBe('命令失败');
  });

  it('未知命令返回失败结果而不是抛错', async () => {
    const registry = new CommandRegistry();
    const result = await registry.execute('no.such.command');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('未知命令');
  });

  it('execute 向命令注入上下文（services / getProject）', async () => {
    const seen: unknown[] = [];
    const registry = new CommandRegistry({ getProject: () => createSampleProject('lumora://t', 'T') });
    registry.register(
      makeCommand({
        execute: (_args, context) => {
          seen.push(context.getProject()?.uri, context.commands.has('test.cmd'));
          return { ok: true };
        },
      }),
    );
    await registry.execute('test.cmd');
    expect(seen).toEqual(['lumora://t', true]);
  });
});
