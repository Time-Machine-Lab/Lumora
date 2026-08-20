import { describe, expect, it, vi } from 'vitest';
import { createSampleProject } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import type { PluginDefinition } from '@lumora/core';

const MANIFEST = {
  schemaVersion: '1' as const,
  id: 'com.test.runtime',
  name: '运行时测试插件',
  version: '0.1.0',
  entry: './dist/index.js',
};

describe('createStudioRuntime', () => {
  it('openProject 写入项目并发出 project:opened 事件', () => {
    const runtime = createStudioRuntime();
    const opened = vi.fn();
    runtime.events.on('project:opened', opened);
    const project = createSampleProject('lumora://test', '测试项目');
    runtime.openProject(project);
    expect(runtime.getProject()?.uri).toBe('lumora://test');
    expect(opened).toHaveBeenCalledWith({
      uri: 'lumora://test',
      name: '测试项目',
      project,
    });
  });

  it('closeProject 清空项目并发出 project:closed 事件', () => {
    const runtime = createStudioRuntime();
    const closed = vi.fn();
    runtime.events.on('project:closed', closed);
    runtime.openProject(createSampleProject());
    runtime.closeProject();
    expect(runtime.getProject()).toBeNull();
    expect(closed).toHaveBeenCalledWith({ uri: 'lumora://sample-project' });
  });

  it('dispose 停用插件并清空事件订阅（卸载释放资源）', async () => {
    const runtime = createStudioRuntime();
    const deactivate = vi.fn();
    const definition: PluginDefinition = {
      activate: (context) => {
        context.events.on('project:opened', () => {});
        return context.contribute({
          commands: [
            { kind: 'command', command: { id: 'runtime.cmd', title: '命令', execute: () => ({ ok: true }) } },
          ],
        });
      },
      deactivate,
    };
    await runtime.host.register({ manifest: MANIFEST, entry: async () => ({ default: definition }) });
    expect(runtime.host.commands.has('runtime.cmd')).toBe(true);
    expect(runtime.events.handlerCount).toBeGreaterThan(0);

    await runtime.dispose();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(runtime.host.commands.has('runtime.cmd')).toBe(false);
    expect(runtime.events.handlerCount).toBe(0);
  });

  it('dispose 幂等', async () => {
    const runtime = createStudioRuntime();
    await runtime.dispose();
    await runtime.dispose();
    expect(runtime.events.handlerCount).toBe(0);
  });
});
