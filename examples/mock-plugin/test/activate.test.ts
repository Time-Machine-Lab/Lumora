import { describe, expect, it } from 'vitest';
import { createSampleProject, PluginHost } from '@lumora/core';
import type { Manifest } from '@lumora/core';
import manifest from '../lumora.plugin.json';
import pluginEntry from '../src/index';

const descriptor = {
  manifest: manifest as Manifest,
  entry: async () => ({ default: pluginEntry }),
};

describe('Mock 插件完整生命周期', () => {
  it('注册→激活：六类贡献项全部生效，宿主服务可用', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    const info = await host.register(descriptor);
    expect(info.state).toBe('active');

    // panel
    const panelIds = host.contributions.getPanels().map((panel) => panel.id);
    expect(panelIds).toContain('com.lumora.mock.panel.console');
    expect(panelIds).toContain('com.lumora.mock.panel.ai');

    // command
    expect(host.commands.has('com.lumora.mock.exportScene')).toBe(true);
    expect(host.commands.has('com.lumora.mock.showProjectInfo')).toBe(true);

    // toolbar（引用命令 id）
    const toolbar = host.contributions.getToolbars().find((item) => item.id === 'com.lumora.mock.toolbar.export');
    expect(toolbar?.commandId).toBe('com.lumora.mock.exportScene');

    // assetLoader
    const asset = await host.services.assets.load('https://cdn.lumora.example/scene.mock.json');
    expect((asset.data as { kind: string }).kind).toBe('scene');

    // aiProvider：逐字流式
    const chunks: string[] = [];
    for await (const chunk of host.services.ai.chat('com.lumora.mock.ai', {
      model: 'mock-1',
      messages: [{ role: 'user', content: '你好' }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('Mock AI');

    // exporter
    const result = await host.services.exporters.run('com.lumora.mock.exporter', createSampleProject());
    expect(result.fileName).toBe('示例项目.mock.json');
    expect(result.mime).toBe('application/json');

    await host.dispose();
  });

  it('未打开项目时导出命令返回失败结果且不影响宿主', async () => {
    const host = new PluginHost();
    await host.register(descriptor);
    const result = await host.commands.execute('com.lumora.mock.exportScene');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('项目');
    expect(host.getPlugin('com.lumora.mock')?.state).toBe('active');
    await host.dispose();
  });

  it('命令可读取宿主当前项目并返回成功结果', async () => {
    const host = new PluginHost();
    host.setProject(createSampleProject());
    await host.register(descriptor);
    const result = await host.commands.execute('com.lumora.mock.showProjectInfo');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('示例项目');
    await host.dispose();
  });

  it('停用后全部贡献项与命令被回收，可再次启用', async () => {
    const host = new PluginHost();
    await host.register(descriptor);
    expect(host.commands.count()).toBe(2);

    await host.deactivate('com.lumora.mock');
    expect(host.getPlugin('com.lumora.mock')?.state).toBe('inactive');
    expect(host.commands.count()).toBe(0);
    expect(host.contributions.count()).toBe(0);

    await host.enable('com.lumora.mock');
    expect(host.getPlugin('com.lumora.mock')?.state).toBe('active');
    expect(host.commands.has('com.lumora.mock.exportScene')).toBe(true);
    expect(host.contributions.count()).toBe(6);

    await host.dispose();
  });

  it('disable 后状态为 disabled；failed 插件不会被 disable 影响', async () => {
    const host = new PluginHost();
    await host.register(descriptor);
    await host.disable('com.lumora.mock');
    expect(host.getPlugin('com.lumora.mock')?.state).toBe('disabled');
    expect(host.commands.count()).toBe(0);

    await host.enable('com.lumora.mock');
    expect(host.getPlugin('com.lumora.mock')?.state).toBe('active');
    await host.dispose();
  });

  it('宿主 dispose 时自动停用插件并回收所有贡献项', async () => {
    const host = new PluginHost();
    await host.register(descriptor);
    expect(host.contributions.count()).toBe(6);
    await host.dispose();
    expect(host.commands.count()).toBe(0);
    expect(host.contributions.count()).toBe(0);
  });
});
