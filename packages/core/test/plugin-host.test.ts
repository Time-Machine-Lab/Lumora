import { describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../src/host/plugin-host';
import type { PluginContext, PluginDescriptor, PluginDefinition, PluginModule } from '../src/host/types';
import { createSampleProject } from '../src/project';
import type { Manifest } from '../src/manifest/validate';

const VALID_MANIFEST: Manifest = {
  schemaVersion: '1',
  id: 'com.example.plugin',
  name: '示例插件',
  version: '0.1.0',
  entry: './dist/index.js',
  engine: { lumora: '^0.1.0' },
  contributes: ['panel', 'command', 'toolbar'],
};

function definitionOf(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    activate: (context) => {
      return context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.panel', title: '示例面板', component: () => null },
        ],
        commands: [
          {
            kind: 'command',
            command: { id: 'example.hello', title: '打招呼', execute: () => ({ ok: true }) },
          },
        ],
        toolbars: [
          { kind: 'toolbar', id: 'com.example.plugin.tb', label: '打招呼', commandId: 'example.hello' },
        ],
        assetLoaders: [
          { kind: 'assetLoader', id: 'com.example.plugin.loader', name: '示例加载器', extensions: ['.demo'], load: () => ({ uri: 'x', data: {} }) },
        ],
        aiProviders: [
          { kind: 'aiProvider', id: 'com.example.plugin.ai', name: '示例 AI', models: ['m1'], chat: async function* () {} },
        ],
        exporters: [
          { kind: 'exporter', id: 'com.example.plugin.export', name: '示例导出', formats: ['json'], export: () => ({ fileName: 'a.json', mime: 'application/json', data: '{}' }) },
        ],
      });
    },
    ...overrides,
  };
}

function descriptor(manifest: Record<string, unknown> = VALID_MANIFEST, entry?: () => Promise<PluginModule>): PluginDescriptor {
  return { manifest: manifest as PluginDescriptor['manifest'], entry };
}

describe('PluginHost', () => {
  it('注册并激活插件：六类贡献项全部就位，状态序列正确', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    const states: string[] = [];
    host.events.on('plugin:state-changed', (e) => states.push(`${e.pluginId}:${e.state}`));

    const info = await host.register(descriptor(VALID_MANIFEST, async () => ({ default: definitionOf() })));

    expect(info.state).toBe('active');
    expect(states).toEqual([
      'com.example.plugin:registered',
      'com.example.plugin:loading',
      'com.example.plugin:activating',
      'com.example.plugin:active',
    ]);
    expect(host.contributions.getPanels()).toHaveLength(1);
    expect(host.contributions.getToolbars()).toHaveLength(1);
    expect(host.contributions.getAssetLoaders()).toHaveLength(1);
    expect(host.contributions.getAiProviders()).toHaveLength(1);
    expect(host.contributions.getExporters()).toHaveLength(1);
    expect(host.commands.has('example.hello')).toBe(true);
  });

  it('Manifest 非法时进入 failed 且不加载入口模块', async () => {
    const host = new PluginHost();
    const entry = vi.fn(async () => ({ default: definitionOf() }));
    const bad = { ...VALID_MANIFEST, schemaVersion: '2' };
    const info = await host.register(descriptor(bad, entry));

    expect(info.state).toBe('failed');
    expect(info.reason).toContain('Manifest 非法');
    expect(entry).not.toHaveBeenCalled();
    expect(host.contributions.count()).toBe(0);
  });

  it('引擎不兼容时进入 failed 且不加载入口模块，原因明确', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    const entry = vi.fn(async () => ({ default: definitionOf() }));
    const info = await host.register(
      descriptor({ ...VALID_MANIFEST, engine: { lumora: '^99.0.0' } }, entry),
    );

    expect(info.state).toBe('failed');
    expect(info.reason).toContain('不满足插件引擎要求');
    expect(entry).not.toHaveBeenCalled();
  });

  it('激活抛错时插件进入 failed，其它插件与宿主核心不受影响', async () => {
    const host = new PluginHost();
    const failing = await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: definitionOf({
          activate: () => {
            throw new Error('激活爆炸');
          },
        }),
      })),
    );
    expect(failing.state).toBe('failed');
    expect(failing.reason).toContain('激活失败');

    const other = await host.register(
      descriptor({ ...VALID_MANIFEST, id: 'com.example.other' }, async () => ({
        default: definitionOf(),
      })),
    );
    expect(other.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
  });

  it('停用后贡献项、命令、事件订阅全部移除，deactivate 钩子被调用', async () => {
    const host = new PluginHost();
    const deactivate = vi.fn();
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: definitionOf({
          activate: (context) => {
            context.events.on('project:opened', () => {});
            context.events.onAny(() => {});
            context.contribute({
              panels: [{ kind: 'panel', id: 'com.example.plugin.panel2', title: '面板2', component: () => null }],
            });
            return { dispose: () => {} };
          },
          deactivate,
        }),
      })),
    );
    expect(info.state).toBe('active');
    expect(host.events.handlerCount).toBeGreaterThan(0);

    await host.deactivate('com.example.plugin');
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('inactive');
    expect(host.contributions.count()).toBe(0);
    expect(host.commands.has('example.hello')).toBe(false);
    expect(host.events.handlerCount).toBe(0);
  });

  it('disable/enable 可循环：禁用后贡献项消失，启用后恢复', async () => {
    const host = new PluginHost();
    const activate = vi.fn(definitionOf().activate);
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    expect(host.commands.has('example.hello')).toBe(true);

    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.commands.has('example.hello')).toBe(false);
    expect(host.contributions.count()).toBe(0);

    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('enabled: false 的插件注册后不激活', async () => {
    const host = new PluginHost();
    const info = await host.register(
      descriptor({ ...VALID_MANIFEST, enabled: false }, async () => ({ default: definitionOf() })),
    );
    expect(info.state).toBe('disabled');
    expect(host.commands.has('example.hello')).toBe(false);
  });

  it('重复 id 注册抛错', async () => {
    const host = new PluginHost();
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: definitionOf() })));
    await expect(host.register(descriptor(VALID_MANIFEST))).rejects.toThrow('插件 id 重复');
  });

  it('入口模块未导出定义时 failed', async () => {
    const host = new PluginHost();
    const info = await host.register(descriptor(VALID_MANIFEST, async () => ({})));
    expect(info.state).toBe('failed');
    expect(info.reason).toContain('未导出插件定义');
  });

  it('入口加载抛错时 failed', async () => {
    const host = new PluginHost();
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => {
        throw new Error('网络错误');
      }),
    );
    expect(info.state).toBe('failed');
    expect(info.reason).toContain('入口模块加载失败');
  });

  it('具名导出 activate/deactivate 的入口模块同样可用', async () => {
    const host = new PluginHost();
    const deactivate = vi.fn();
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        activate: (context: PluginContext) => context.contribute({}),
        deactivate,
      })),
    );
    expect(info.state).toBe('active');
    await host.deactivate('com.example.plugin');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('dispose 停用全部插件并释放总线', async () => {
    const host = new PluginHost();
    const deactivate = vi.fn();
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: definitionOf({ deactivate }) })));
    host.events.on('project:closed', () => {});
    expect(host.events.handlerCount).toBeGreaterThan(0);

    await host.dispose();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(host.listPlugins()).toHaveLength(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('服务门面：资源加载、AI 流式、导出按 id 分发', async () => {
    const host = new PluginHost();
    host.setProject(createSampleProject('lumora://sample', '示例'));
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: definitionOf() })));

    const asset = await host.services.assets.load('demo://a.demo');
    expect(asset.data).toEqual({});

    await expect(host.services.assets.load('demo://a.unknown')).rejects.toThrow('没有可加载');
    const aiStream = host.services.ai.chat('no.such.ai', { model: 'm1', messages: [] });
    await expect((async () => {
      const chunks: string[] = [];
      for await (const chunk of aiStream) chunks.push(chunk);
    })()).rejects.toThrow('未知 AI 提供方');

    const exported = await host.services.exporters.run('com.example.plugin.export', createSampleProject());
    expect(exported.fileName).toBe('a.json');
  });

  it('插件 id 冲突贡献项导致激活失败，且不留下半注册贡献项', async () => {
    const host = new PluginHost();
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: definitionOf() })));
    const info = await host.register(
      descriptor({ ...VALID_MANIFEST, id: 'com.example.twin' }, async () => ({
        default: {
          activate: (context: PluginContext) =>
            context.contribute({
              panels: [{ kind: 'panel', id: 'com.example.plugin.panel', title: '撞 id', component: () => null }],
            }),
        },
      })),
    );
    expect(info.state).toBe('failed');
    expect(info.reason).toContain('id 重复');
    expect(host.contributions.getPanels()).toHaveLength(1);
  });

  it('激活失败回滚本次激活产生的全部资源；failed 插件可停用并可重新启用重试', async () => {
    const host = new PluginHost();
    const boom = new Error('激活中途爆炸');
    let attempt = 0;
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: definitionOf({
          activate: (context: PluginContext) => {
            attempt += 1;
            context.events.on('project:opened', () => {});
            if (attempt === 1) {
              context.contribute({
                panels: [
                  { kind: 'panel', id: 'com.example.plugin.bad-panel', title: '坏面板', component: () => null },
                ],
              });
              throw boom;
            }
            return context.contribute({
              panels: [
                { kind: 'panel', id: 'com.example.plugin.retry-panel', title: '重试面板', component: () => null },
              ],
            });
          },
        }),
      })),
    );
    expect(info.state).toBe('failed');
    expect(info.reason).toContain('激活失败');
    // 回滚：失败激活产生的面板与订阅全部移除，不留下半激活状态
    expect(host.contributions.getPanels()).toHaveLength(0);
    expect(host.events.handlerCount).toBe(0);

    // failed 插件可停用（幂等清理），失败原因保留
    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('inactive');
    expect(host.getPlugin('com.example.plugin')?.reason).toContain('激活失败');
    await host.disable('com.example.plugin'); // 再次停用：幂等不抛错
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');

    // 激活失败类插件可重新启用重试
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.contributions.getPanels()).toHaveLength(1);
  });

  it('贡献项批量注册原子：bundle 内重复 id 整体失败，不留下任何半注册贡献项', async () => {
    const host = new PluginHost();
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: {
          activate: (context: PluginContext) =>
            context.contribute({
              panels: [
                { kind: 'panel', id: 'com.example.plugin.dup-a', title: '面板A', component: () => null },
                { kind: 'panel', id: 'com.example.plugin.dup-a', title: '面板B', component: () => null },
              ],
              toolbars: [
                { kind: 'toolbar', id: 'com.example.plugin.tb', label: '工具栏', commandId: 'no.cmd' },
              ],
            }),
        },
      })),
    );
    expect(info.state).toBe('failed');
    expect(info.reason).toContain('在 bundle 内重复');
    // 非法 bundle 中即便含合法项也不得部分生效
    expect(host.contributions.count()).toBe(0);
    expect(host.commands.count()).toBe(0);
  });

  it('贡献项批量注册原子：命令 id 在 bundle 内重复时整体失败', async () => {
    const host = new PluginHost();
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: {
          activate: (context: PluginContext) =>
            context.contribute({
              commands: [
                { kind: 'command', command: { id: 'dup.cmd', title: '命令A', execute: () => ({ ok: true }) } },
                { kind: 'command', command: { id: 'dup.cmd', title: '命令B', execute: () => ({ ok: true }) } },
              ],
            }),
        },
      })),
    );
    expect(info.state).toBe('failed');
    expect(info.reason).toContain('在 bundle 内重复');
    expect(host.commands.count()).toBe(0);
  });

  it('命令上下文注入惰性服务与所属插件 id', async () => {
    const host = new PluginHost();
    host.setProject(createSampleProject('lumora://ctx', '上下文项目'));
    let seenPluginId: string | undefined;
    let loadedAsset: unknown;
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: {
          activate: (context: PluginContext) =>
            context.contribute({
              commands: [
                {
                  kind: 'command',
                  command: {
                    id: 'ctx.cmd',
                    title: '上下文命令',
                    execute: async (_args, commandContext) => {
                      seenPluginId = commandContext.pluginId;
                      loadedAsset = await commandContext.services.assets.load('demo://a.demo');
                      return { ok: true };
                    },
                  },
                },
              ],
              assetLoaders: [
                {
                  kind: 'assetLoader',
                  id: 'com.example.plugin.loader',
                  name: '示例加载器',
                  extensions: ['.demo'],
                  load: () => ({ uri: 'demo://a.demo', data: { from: 'plugin' } }),
                },
              ],
            }),
        },
      })),
    );
    await host.commands.execute('ctx.cmd');
    expect(seenPluginId).toBe('com.example.plugin');
    expect(loadedAsset).toEqual({ uri: 'demo://a.demo', data: { from: 'plugin' } });
  });

  it('激活期间停用：晚到的激活结果被废弃并整体回滚，状态不被覆盖', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const activate = vi.fn(async (context: PluginContext) => {
      context.events.on('project:opened', () => {});
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.late-panel', title: '晚到面板', component: () => null },
        ],
      });
      await gate;
      return { dispose: () => {} };
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    // 等激活进入挂起状态，此时停用插件
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));
    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    // disable 返回前 pending 资源必须已清零（不等晚到的激活结果）
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);

    // 放行晚到的激活结果：不得把插件带回 active，资源必须释放
    releaseActivate();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('激活期间销毁宿主：晚到资源释放且不抛错', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const activate = vi.fn(async (context: PluginContext) => {
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.late-panel', title: '晚到面板', component: () => null },
        ],
      });
      await gate;
      return { dispose: () => {} };
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));
    await host.dispose();
    releaseActivate();
    await registering; // 不抛错
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('非法 Manifest 输入（null / 非数组 contributes / 非对象）不击穿隔离', async () => {
    const host = new PluginHost();
    const registerRaw = (manifest: unknown) => host.register({ manifest: manifest as Manifest });

    const nullInfo = await registerRaw(null);
    expect(nullInfo.state).toBe('failed');
    expect(nullInfo.reason).toContain('Manifest 非法');
    expect(nullInfo.contributes).toEqual([]);

    const nonArrayInfo = await registerRaw({
      schemaVersion: '1',
      id: 'com.example.nonarray',
      name: '非数组贡献项插件',
      version: '0.1.0',
      contributes: 'panel',
    });
    expect(nonArrayInfo.state).toBe('failed');
    expect(nonArrayInfo.id).toBe('com.example.nonarray');
    expect(nonArrayInfo.contributes).toEqual([]);

    const nonObjectInfo = await registerRaw({
      schemaVersion: 1,
      id: 'com.example.nonobject',
      name: '非对象字段插件',
      version: 3,
    });
    expect(nonObjectInfo.state).toBe('failed');
    expect(nonObjectInfo.reason).toContain('Manifest 非法');

    // 列表与统计不受影响，宿主核心可用
    expect(host.listPlugins().map((p) => p.state)).toEqual(['failed', 'failed', 'failed']);
    expect(host.contributions.count()).toBe(0);
    await host.register(descriptor({ ...VALID_MANIFEST, id: 'com.example.afterbad' }, async () => ({
      default: definitionOf(),
    })));
    expect(host.getPlugin('com.example.afterbad')?.state).toBe('active');
  });

  it('enabled:false 插件可启用：首次 enable 才加载入口，且入口只加载一次', async () => {
    const host = new PluginHost();
    const entry = vi.fn(async () => ({ default: definitionOf() }));
    const info = await host.register(descriptor({ ...VALID_MANIFEST, enabled: false }, entry));
    expect(info.state).toBe('disabled');
    expect(entry).not.toHaveBeenCalled();

    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(1);

    // 禁用再启用：定义已缓存，入口仍只加载一次
    await host.disable('com.example.plugin');
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(entry).toHaveBeenCalledTimes(1);
  });

  it('加载期间 disable：晚到的加载结果只缓存定义，不改写停用状态；之后可重新启用', async () => {
    const host = new PluginHost();
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const entry = vi.fn(async () => {
      await gate;
      return { default: definitionOf() };
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('loading'));
    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');

    // 放行晚到的加载结果：不得把插件带回 loading/active，也不得注册任何贡献项
    releaseLoad();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.commands.count()).toBe(0);
    expect(host.contributions.count()).toBe(0);

    // 之后可正常重新启用（定义已缓存，入口只加载一次）
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(1);
  });

  it('加载期间 disable：晚到的加载失败不改写停用状态；重新启用重新加载并可见失败原因', async () => {
    const host = new PluginHost();
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const entry = vi.fn(async () => {
      await gate;
      throw new Error('加载爆炸');
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('loading'));
    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');

    // 晚到的 reject 不得把插件改写为 failed
    releaseLoad();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.listPlugins()).toHaveLength(1);

    // 重新启用：重新加载，失败正常进入 failed 并给出原因
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('failed');
    expect(host.getPlugin('com.example.plugin')?.reason).toContain('加载爆炸');
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('并发 disable 只执行一次 deactivate 钩子', async () => {
    const host = new PluginHost();
    const deactivate = vi.fn(async () => {});
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: { activate: (context) => context.contribute({}), deactivate },
      })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    await Promise.all([host.disable('com.example.plugin'), host.disable('com.example.plugin')]);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
  });

  it('激活挂起期间并发 disable 合并为一次停用，晚到的激活结果被废弃', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const activate = vi.fn(async (context: PluginContext) => {
      await gate;
      return context.contribute({});
    });
    const registering = host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));

    await Promise.all([host.disable('com.example.plugin'), host.disable('com.example.plugin')]);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);

    releaseActivate();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
  });

  it('激活成功后经旧 context 动态贡献随停用一起清理；停用后旧 context 彻底失效', async () => {
    const host = new PluginHost();
    let savedContext: PluginContext | undefined;
    const activate = vi.fn(async (context: PluginContext) => {
      savedContext = context;
      return context.contribute({});
    });
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    // 激活成功后经旧 context 动态贡献（合法路径）：并入 owned，停用时一并清理
    savedContext!.contribute({
      panels: [
        { kind: 'panel', id: 'com.example.plugin.dynamic-panel', title: '动态面板', component: () => null },
      ],
    });
    expect(host.contributions.count()).toBe(1);
    await host.disable('com.example.plugin');
    expect(host.contributions.count()).toBe(0);

    // 停用后的旧 context 无法再贡献或订阅（不落到宿主总线）
    expect(() =>
      savedContext!.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.after-panel', title: '晚到面板', component: () => null },
        ],
      }),
    ).toThrow('已停用或宿主已销毁');
    savedContext!.events.on('project:opened', () => {});
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('激活抛错后的旧 context 无法再注入贡献项与订阅（failed 插件不留残留）', async () => {
    const host = new PluginHost();
    let savedContext: PluginContext | undefined;
    const activate = vi.fn(async (context: PluginContext) => {
      savedContext = context;
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.broken-panel', title: '失败面板', component: () => null },
        ],
      });
      throw new Error('激活爆炸');
    });
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('failed');
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);

    // 激活失败的旧 context 不得再注入贡献项或订阅
    expect(() =>
      savedContext!.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.broken-panel', title: '晚到面板', component: () => null },
        ],
      }),
    ).toThrow();
    savedContext!.events.on('project:opened', () => {});
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('多个缺 id 的非法 Manifest 逐个隔离：各自成记录、互不覆盖，真实 id 重复仍抛错', async () => {
    const host = new PluginHost();
    const registerRaw = (manifest: unknown) => host.register({ manifest: manifest as Manifest });

    const first = await registerRaw(null);
    const second = await registerRaw(null);
    expect(first.state).toBe('failed');
    expect(second.state).toBe('failed');
    expect(first.id).toBe('<unknown>');
    expect(second.id).toBe('<unknown>');
    // 两个非法记录都保留，各自展示失败原因，列表不互相覆盖
    const plugins = host.listPlugins();
    expect(plugins).toHaveLength(2);
    expect(plugins.every((p) => p.state === 'failed')).toBe(true);
    expect(plugins.every((p) => p.reason?.includes('Manifest 非法'))).toBe(true);

    // 真实 id 重复仍抛错
    await host.register(
      descriptor({ ...VALID_MANIFEST, id: 'com.example.taken' }, async () => ({ default: definitionOf() })),
    );
    await expect(
      host.register(descriptor({ ...VALID_MANIFEST, id: 'com.example.taken' })),
    ).rejects.toThrow('插件 id 重复: com.example.taken');
  });
});
