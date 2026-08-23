import { describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../src/host/plugin-host';
import type {
  PluginContext,
  PluginDescriptor,
  PluginDefinition,
  PluginInfo,
  PluginModule,
  PluginState,
} from '../src/host/types';
import type { Command, CommandContext } from '../src/commands/command-registry';
import { createSampleProject } from '../src/scene/sample-project';
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

  it('宿主持有的 manifest 深冻结：插件清空 privateSettings 被拒绝，已声明凭据的剥离依据不丢失（第十二轮严重 #4）', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    const attempts: string[] = [];
    const definition = definitionOf({
      activate: (context) => {
        // context.manifest 直接引用宿主持有的 manifest（非副本）：任何改写尝试
        // 都被深冻结拒绝 —— 插件不得抹掉自己已声明的凭据剥离依据
        const held = context.manifest as unknown as Record<string, unknown> & { privateSettings?: string[] };
        try {
          held.privateSettings = [];
          attempts.push('assign-succeeded');
        } catch {
          attempts.push('assign-rejected');
        }
        const declared = held.privateSettings;
        try {
          declared!.push('extra');
          attempts.push('push-succeeded');
        } catch {
          attempts.push('push-rejected');
        }
        return context.contribute({ panels: [] });
      },
    });
    await host.register(
      descriptor({ ...VALID_MANIFEST, privateSettings: ['apiKey', 'accessToken'] }, async () => ({ default: definition })),
    );
    expect(attempts).toEqual(['assign-rejected', 'push-rejected']);
    // 宿主仍完整持有声明：导出收集的剥离依据未被插件抹掉
    expect(host.getPluginManifest('com.example.plugin')!.privateSettings).toEqual(['apiKey', 'accessToken']);
  });

  it('getPluginManifest 返回防御性只读副本：调用方修改副本不影响宿主与后续查询（第十二轮严重 #4）', async () => {
    const host = new PluginHost({ hostVersion: '0.1.0' });
    await host.register(
      descriptor({ ...VALID_MANIFEST, privateSettings: ['apiKey'] }, async () => ({ default: definitionOf() })),
    );
    const copy = host.getPluginManifest('com.example.plugin')!;
    expect(copy).toBeDefined();
    copy.privateSettings = [];
    copy.name = '被篡改';
    copy.contributes = [];
    // 副本修改不侧漏：宿主状态不受影响
    const again = host.getPluginManifest('com.example.plugin')!;
    expect(again.privateSettings).toEqual(['apiKey']);
    expect(again.name).toBe('示例插件');
    expect(again.contributes).toEqual(VALID_MANIFEST.contributes);
    // 未知插件返回 undefined
    expect(host.getPluginManifest('com.nonexistent')).toBeUndefined();
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

  it('激活期间停用：disable 等待激活 settle 覆盖晚到副作用，资源整体清理且状态不被覆盖', async () => {
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
    // 停用等待同一生命周期操作：激活尚未 settle，disable 不得提前返回
    const disabling = host.disable('com.example.plugin');
    let disabledResolved = false;
    disabling.then(() => {
      disabledResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disabledResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    // 放行晚到的激活结果：disable 在 settle 后完成，暂存资源全部清理
    releaseActivate();
    await disabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);

    // 晚到激活结果被废弃：不复活、不重复清理
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('激活期间销毁宿主：dispose 等待同一生命周期操作，晚到资源释放且不抛错', async () => {
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
    const disposing = host.dispose();
    let disposed = false;
    disposing.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false); // dispose 等待激活 settle（覆盖晚到副作用）

    releaseActivate();
    await disposing;
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

  it('加载期间 disable：晚到的有效导出被整体丢弃（不缓存定义）；重新启用重新加载', async () => {
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

    // 放行晚到的加载结果：不得改写停用状态、不得注册贡献项、不得缓存定义
    releaseLoad();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.commands.count()).toBe(0);
    expect(host.contributions.count()).toBe(0);

    // 重新启用：晚到结果未缓存，重新加载入口（×2）后激活
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('加载期间 disable：晚到的“无有效导出”结果不得把停用插件改写为 failed（register 竞态）', async () => {
    const host = new PluginHost();
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const entry = vi.fn(async () => {
      await gate;
      return {} as PluginModule;
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('loading'));
    await host.disable('com.example.plugin');

    // 放行晚到的“无有效导出”结果：不得把 disabled 改写为 failed
    releaseLoad();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();

    // 重新启用：重新加载后仍无有效导出 → failed 且原因明确
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('failed');
    expect(host.getPlugin('com.example.plugin')?.reason).toContain('未导出插件定义');
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('enable 加载期间 disable：晚到的有效导出被丢弃，重新启用重新加载（enable 竞态）', async () => {
    const host = new PluginHost();
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const entry = vi.fn(async () => {
      await gate;
      return { default: definitionOf() };
    });
    await host.register(descriptor({ ...VALID_MANIFEST, enabled: false }, entry));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(entry).not.toHaveBeenCalled();

    const enabling = host.enable('com.example.plugin');
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('loading'));
    await host.disable('com.example.plugin');
    releaseLoad();
    await enabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.commands.count()).toBe(0);

    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('in-flight 停用共享完成 Promise：deactivate 挂起时 disable 等待同一清理并合并终态', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await gate;
    });
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: {
          activate: (context) =>
            context.contribute({
              commands: [
                { kind: 'command', command: { id: 'example.hello', title: '打招呼', execute: () => ({ ok: true }) } },
              ],
            }),
          deactivate,
        },
      })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    const deactivating = host.deactivate('com.example.plugin');
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating'));

    // 停用挂起期间发起 disable：不得提前返回，必须等待同一清理完成
    let disableResolved = false;
    const disabling = host.disable('com.example.plugin').then(() => {
      disableResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disableResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');
    expect(host.commands.count()).toBe(1);

    releaseDeactivate();
    await disabling;
    await deactivating;
    expect(disableResolved).toBe(true);
    // 目标终态合并：并发的 disable 期望终态 disabled 生效
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.commands.count()).toBe(0);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('in-flight 停用共享完成 Promise：dispose 等待既有停用清理完成后再释放', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await gate;
    });
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: { activate: (context) => context.contribute({}), deactivate },
      })),
    );

    const deactivating = host.deactivate('com.example.plugin');
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating'));
    let disposed = false;
    const disposing = host.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false); // dispose 等待同一清理

    releaseDeactivate();
    await disposing;
    await deactivating;
    expect(host.listPlugins()).toHaveLength(0);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('激活挂起期间 disable：先等激活 settle 再执行一次可等待的 deactivate，晚到的激活结果被废弃', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    let releaseDeactivate!: () => void;
    const activateGate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const activate = vi.fn(async (context: PluginContext) => {
      await activateGate;
      return context.contribute({});
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));

    // 激活挂起期间 disable：生命周期操作先等待激活 settle（覆盖晚到副作用），
    // 因此 deactivate 钩子尚未执行，disable 也不得提前返回
    const disabling = host.disable('com.example.plugin');
    let disablingResolved = false;
    disabling.then(() => {
      disablingResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');
    expect(deactivate).not.toHaveBeenCalled();

    // 放行激活 settle：随后执行一次可等待的 deactivate，disable 等待其完成
    releaseActivate();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disablingResolved).toBe(false);
    expect(host.contributions.count()).toBe(0);

    releaseDeactivate();
    await disabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(deactivate).toHaveBeenCalledTimes(1);

    // 晚到的激活结果被废弃：不复活、不重复调用 deactivate
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('激活抛错回滚期间 disable：共享同一生命周期操作，停用终态不被晚到 failed 覆盖', async () => {
    const host = new PluginHost();
    let releaseRollback!: () => void;
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    const activate = vi.fn(async () => {
      throw new Error('激活爆炸');
    });
    const deactivate = vi.fn(async () => {
      await rollbackGate;
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );

    // 激活抛错 → 回滚开始（deactivate 钩子挂起），此时发起 disable：
    // disable 等待同一生命周期操作，不得在回滚完成前返回
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    const disabling = host.disable('com.example.plugin');
    let disablingResolved = false;
    disabling.then(() => {
      disablingResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    // 放行回滚：合并终态由 disable 决定（disabled），不得被回滚的 failed 覆盖
    releaseRollback();
    await disabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();

    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('激活抛错时已开始激活的插件执行一次可等待的 deactivate 后进入 failed', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: { activate: () => { throw new Error('激活爆炸'); }, deactivate },
      })),
    );
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    let resolved = false;
    registering.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false); // failed 终态等待可等待的 deactivate 完成
    releaseDeactivate();
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('failed');
    expect(host.getPlugin('com.example.plugin')?.reason).toContain('激活失败');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('插件命令面收窄：旧 context 直接注册命令被拒绝，动态命令经 contribute 由宿主代管并随停用回收', async () => {
    const host = new PluginHost();
    let savedContext: PluginContext | undefined;
    const activate = vi.fn(async (context: PluginContext) => {
      savedContext = context;
      return context.contribute({});
    });
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    // 动态命令的合法路径：activate 之后经 contribute 提交，宿主代管（记录插件归属）
    savedContext!.contribute({
      commands: [
        {
          kind: 'command',
          command: { id: 'example.dynamic', title: '动态命令', execute: () => ({ ok: true }) },
        },
      ],
    });
    expect(host.commands.has('example.dynamic')).toBe(true);
    expect(host.commands.ownerOf('example.dynamic')).toBe('com.example.plugin');

    // 直接向插件命令面注册被明确拒绝（绕过生命周期）
    expect(() =>
      (savedContext!.commands as unknown as { register: (...args: unknown[]) => unknown }).register(
        'com.example.plugin',
      ),
    ).toThrow('不得直接注册命令');

    await host.disable('com.example.plugin');
    expect(host.commands.has('example.dynamic')).toBe(false);
    expect(host.commands.count()).toBe(0);
  });

  it('when() 抛错被隔离并上报：异常命令视为不可用，正常命令与宿主不受影响', async () => {
    const onError = vi.fn();
    const host = new PluginHost({ onError });
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: {
          activate: (context) =>
            context.contribute({
              commands: [
                {
                  kind: 'command',
                  command: {
                    id: 'example.throwing',
                    title: '坏条件',
                    when: () => {
                      throw new Error('when 爆炸');
                    },
                    execute: () => ({ ok: true }),
                  },
                },
                { kind: 'command', command: { id: 'example.hello', title: '打招呼', execute: () => ({ ok: true }) } },
              ],
            }),
        },
      })),
    );
    expect(host.commands.isAvailable(host.commands.get('example.throwing')!)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(host.commands.isAvailable(host.commands.get('example.hello')!)).toBe(true);
    expect(host.commands.count()).toBe(2);
    const result = await host.commands.execute('example.hello');
    expect(result.ok).toBe(true);
  });

  it('instanceId 公开稳定唯一：非法插件可经 instanceId 寻址，展示 id 不可寻址，合法插件二者相同', async () => {
    const host = new PluginHost();
    const first = await host.register({ manifest: null as unknown as Manifest });
    const second = await host.register({ manifest: null as unknown as Manifest });
    expect(first.id).toBe('<unknown>');
    expect(second.id).toBe('<unknown>');
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(host.listPlugins().map((p) => p.instanceId)).toEqual([first.instanceId, second.instanceId]);

    // 展示 id 不可寻址；instanceId 可寻址（failed 插件停用进入 inactive 并保留原因）
    await expect(host.disable('<unknown>')).rejects.toThrow('未知插件');
    await host.disable(first.instanceId);
    expect(host.getPlugin(first.instanceId)?.state).toBe('inactive');
    expect(host.getPlugin(first.instanceId)?.reason).toContain('Manifest 非法');
    expect(host.getPlugin(second.instanceId)?.state).toBe('failed');

    // 合法 Manifest：instanceId 与 manifest id 相同，既有按 id 的调用不受影响
    const good = await host.register(descriptor(VALID_MANIFEST, async () => ({ default: definitionOf() })));
    expect(good.instanceId).toBe('com.example.plugin');
    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
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

    // 两个 disable 并入同一生命周期操作：都等待激活 settle，不提前返回
    const first = host.disable('com.example.plugin');
    const second = host.disable('com.example.plugin');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseActivate();
    await Promise.all([first, second]);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);

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

    // 停用后的旧 context 无法再贡献或订阅（订阅被明确拒绝，不落到宿主总线）
    expect(() =>
      savedContext!.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.after-panel', title: '晚到面板', component: () => null },
        ],
      }),
    ).toThrow('已停用或宿主已销毁');
    expect(() => savedContext!.events.on('project:opened', () => {})).toThrow('上下文已失效');
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

    // 激活失败的旧 context 不得再注入贡献项或订阅（订阅被明确拒绝）
    expect(() =>
      savedContext!.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.broken-panel', title: '晚到面板', component: () => null },
        ],
      }),
    ).toThrow();
    expect(() => savedContext!.events.on('project:opened', () => {})).toThrow('上下文已失效');
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

  it('过期 activation 只清理自身资源：晚到 reject 不破坏新一代激活、pending 或终态', async () => {
    const host = new PluginHost();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let mode: 'stale' | 'gen2' = 'stale';
    const activate = vi.fn(async (context: PluginContext) => {
      if (mode === 'stale') {
        await firstGate;
        throw new Error('旧激活晚到失败');
      }
      return context.contribute({
        commands: [
          { kind: 'command', command: { id: 'example.gen2', title: '第二代', execute: () => ({ ok: true }) } },
        ],
      });
    });
    const registering = host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));

    // #1 挂起时停用（等待 #1 settle），放行其晚到 reject
    const disabling = host.disable('com.example.plugin');
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await disabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');

    // 晚到 reject 只触发过期尝试自清：不得改写新一代终态或留下失败原因
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();

    // 新一代激活完整走通：不被旧 attempt 的清理破坏，贡献项随停用正常回收
    mode = 'gen2';
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(activate).toHaveBeenCalledTimes(2);
    expect(host.commands.has('example.gen2')).toBe(true);
    await host.disable('com.example.plugin');
    expect(host.commands.has('example.gen2')).toBe(false);
  });

  it('停用等待激活 settle：晚到的贡献/订阅被拒绝，disable 返回后无残留', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const activate = vi.fn(async (context: PluginContext) => {
      context.events.on('project:opened', () => {});
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.early-panel', title: '早期面板', component: () => null },
        ],
      });
      await gate;
      // 晚到的外部副作用：激活 settle 之后仍尝试注入贡献项与订阅
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.late-panel', title: '晚到面板', component: () => null },
        ],
      });
      context.events.on('project:opened', () => {});
      return { dispose: () => {} };
    });
    const registering = host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));

    // disable 等待激活 settle：覆盖晚到副作用窗口，不得提前返回
    const disabling = host.disable('com.example.plugin');
    let disablingResolved = false;
    disabling.then(() => {
      disablingResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseActivate();
    await disabling;
    await registering; // 不抛错：晚到 contribute 抛错被激活路由吞掉
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(host.events.handlerCount).toBe(0);
  });

  it('deactivating 状态事件内重入 disable：共享同一生命周期操作，deactivate 只执行一次', async () => {
    const host = new PluginHost();
    const deactivate = vi.fn(async () => {});
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: { activate: (context) => context.contribute({}), deactivate },
      })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'deactivating' && e.instanceId === 'com.example.plugin') {
        void host.disable('com.example.plugin').catch(() => {});
      }
    });
    await host.disable('com.example.plugin');
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
  });

  it('enable 等待在途生命周期：停用进行中发起 enable 不吞意图，完成后自动激活', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await gate;
    });
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: { activate: (context) => context.contribute({}), deactivate },
      })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    const disabling = host.disable('com.example.plugin');
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    // 停用挂起期间发起 enable：等待同一生命周期操作，不得提前返回或吞掉意图
    const enabling = host.enable('com.example.plugin');
    let enablingResolved = false;
    enabling.then(() => {
      enablingResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseDeactivate();
    await disabling;
    await enabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('loading 状态事件内重入 enable：加载操作先发布，入口只加载一次', async () => {
    const host = new PluginHost();
    const entry = vi.fn(async () => ({ default: definitionOf() }));
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'loading' && e.instanceId === 'com.example.plugin') {
        void host.enable('com.example.plugin').catch(() => {});
      }
    });
    // 重入 enable 与注册流共享同一真实加载完成 Promise，并启动同代激活；
    // register 加入同一完整激活流程，返回快照必须是 active（不得放宽为 activating）
    const info = await host.register(descriptor(VALID_MANIFEST, entry));
    expect(info.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(entry).toHaveBeenCalledTimes(1);
    expect(host.commands.has('example.hello')).toBe(true);
  });

  it('when/execute 收到的 CommandContext 代际绑定：停用后订阅与命令操作全部失效，注册表运行时私有', async () => {
    const host = new PluginHost();
    let savedContext: CommandContext | undefined;
    const leaky: Command = {
      id: 'example.leaky',
      title: '泄漏命令',
      when: (ctx) => {
        savedContext = ctx;
        return true;
      },
      execute: (_args, ctx) => {
        savedContext = ctx;
        return { ok: true };
      },
    };
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: {
          activate: (context) => context.contribute({ commands: [{ kind: 'command', command: leaky }] }),
        },
      })),
    );
    // when 与 execute 两条路径都注入 owner 门面
    expect(host.commands.isAvailable(host.commands.get('example.leaky')!)).toBe(true);
    await host.commands.execute('example.leaky');
    expect(savedContext).toBeDefined();
    expect(savedContext!.pluginId).toBe('com.example.plugin');
    expect(savedContext!.commands.has('example.leaky')).toBe(true);
    savedContext!.events.on('project:opened', () => {});
    expect(host.events.handlerCount).toBeGreaterThan(0);

    await host.disable('com.example.plugin');
    expect(host.commands.has('example.leaky')).toBe(false);
    // 旧 context 失效：命令执行被拒、订阅被拒、注册表 dispose 不可达（运行时私有）
    await expect(savedContext!.commands.execute('example.leaky')).rejects.toThrow('上下文已失效');
    expect(() => savedContext!.events.on('project:opened', () => {})).toThrow('上下文已失效');
    // 底层注册表运行时私有：不再作为门面自有可枚举成员存在（WeakMap 键不可枚举）
    expect(Object.keys(savedContext!.commands)).not.toContain('registry');
    expect(host.events.handlerCount).toBe(0);
    expect(host.commands.count()).toBe(0);
  });

  it('typed 状态事件公开稳定唯一 instanceId：多匿名记录可关联与寻址', async () => {
    const host = new PluginHost();
    const events: Array<{ instanceId: string; pluginId: string; state: PluginState }> = [];
    host.events.on('plugin:state-changed', (e) =>
      events.push({ instanceId: e.instanceId, pluginId: e.pluginId, state: e.state }),
    );
    const first = await host.register({ manifest: null as unknown as Manifest });
    const second = await host.register({ manifest: null as unknown as Manifest });
    // 事件按 instanceId 关联到各自记录（注册与失败各一次）
    expect(events.filter((e) => e.instanceId === first.instanceId && e.state === 'failed')).toHaveLength(1);
    expect(events.filter((e) => e.instanceId === second.instanceId && e.state === 'failed')).toHaveLength(1);
    // 展示 pluginId 恒为 '<unknown>'（仅作展示，不得用于寻址）
    expect(events.every((e) => e.pluginId === '<unknown>')).toBe(true);
    // 事件中的 instanceId 可直接寻址：disable 第一条不影响第二条
    await host.disable(first.instanceId);
    expect(host.getPlugin(first.instanceId)?.state).toBe('inactive');
    expect(host.getPlugin(second.instanceId)?.state).toBe('failed');
    expect(events[events.length - 1]?.instanceId).toBe(first.instanceId);
  });

  it('registered 状态事件内同步停用：注册链立即终止，loader 与 activate 均不执行', async () => {
    const host = new PluginHost();
    const entry = vi.fn(async () => ({ default: definitionOf() }));
    let disabling!: Promise<void>;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'registered' && e.instanceId === 'com.example.plugin') {
        disabling = host.disable(e.instanceId);
      }
    });
    const info = await host.register(descriptor(VALID_MANIFEST, entry));
    await disabling;
    // 停用已接管：不得继续加载/激活链，不得执行任何插件用户代码
    expect(entry).not.toHaveBeenCalled();
    expect(info.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
  });

  it('loading 状态事件内同步停用：入口 loader 不再执行，终态 disabled', async () => {
    const host = new PluginHost();
    const entry = vi.fn(async () => ({ default: definitionOf() }));
    let disabling!: Promise<void>;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'loading' && e.instanceId === 'com.example.plugin') {
        disabling = host.disable(e.instanceId);
      }
    });
    const info = await host.register(descriptor(VALID_MANIFEST, entry));
    await disabling;
    // 事件内停用后不得再调用入口 loader（插件用户代码）
    expect(entry).not.toHaveBeenCalled();
    expect(info.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
  });

  it('activating 状态事件内同步停用：activate 钩子不再执行，外部资源不被触碰', async () => {
    const host = new PluginHost();
    let external = true;
    const activate = vi.fn(async () => {
      external = false;
    });
    let disabling!: Promise<void>;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'activating' && e.instanceId === 'com.example.plugin') {
        disabling = host.disable(e.instanceId);
      }
    });
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    await disabling;
    // 事件内停用后不得再调用 activate 钩子：晚到的外部副作用被消除
    expect(activate).not.toHaveBeenCalled();
    expect(external).toBe(true);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
  });

  it('deactivating 状态事件内重入 disable：取得同一真实完成 Promise，清理闸门释放前不返回', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({
        default: { activate: (context) => context.contribute({}), deactivate },
      })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    let reentrant!: Promise<void>;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'deactivating' && e.instanceId === 'com.example.plugin') {
        reentrant = host.disable(e.instanceId);
      }
    });
    const disabling = host.disable('com.example.plugin');
    await vi.waitFor(() => expect(reentrant).toBeDefined());
    let reentrantResolved = false;
    reentrant.then(() => {
      reentrantResolved = true;
    });
    let outerResolved = false;
    disabling.then(() => {
      outerResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 事件内重入 disable 必须等待同一真实 completion（不是已完成占位 Promise）
    expect(reentrantResolved).toBe(false);
    expect(outerResolved).toBe(false);
    expect(deactivate).toHaveBeenCalledTimes(1);

    releaseDeactivate();
    await disabling;
    await reentrant;
    expect(deactivate).toHaveBeenCalledTimes(1); // 不启动第二次清理
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
  });

  it('loading 状态事件内重入 enable：等待身份不变的加载完成 Promise，入口只加载一次', async () => {
    const host = new PluginHost();
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const entry = vi.fn(async () => {
      await loadGate;
      return { default: definitionOf() };
    });
    let reentrant!: Promise<void>;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'loading' && e.instanceId === 'com.example.plugin') {
        reentrant = host.enable(e.instanceId);
      }
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(reentrant).toBeDefined());
    let reentrantDone = false;
    reentrant.then(() => {
      reentrantDone = true;
    });
    let registeredInfo: PluginInfo | undefined;
    let registeredDone = false;
    registering.then((info) => {
      registeredDone = true;
      registeredInfo = info;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 重入 enable 不得吞下已完成占位 Promise：加载闸门释放前不完成
    expect(reentrantDone).toBe(false);
    expect(registeredDone).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');

    releaseLoad();
    await registering;
    await reentrant;
    // register 加入重入 enable 启动的同代激活：返回快照为 active，不得放宽为 activating
    expect(registeredDone).toBe(true);
    expect(registeredInfo?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(entry).toHaveBeenCalledTimes(1);
    expect(host.commands.has('example.hello')).toBe(true);
  });

  it('disabled 终态事件内重入 enable：新一代激活失败进入独立生命周期，回滚并记录失败原因', async () => {
    const host = new PluginHost();
    const boom = new Error('第二次激活爆炸');
    let activationCount = 0;
    const activate = vi.fn((context: PluginContext) => {
      activationCount += 1;
      if (activationCount === 1) {
        return context.contribute({
          commands: [
            { kind: 'command', command: { id: 'example.first', title: '首次', execute: () => ({ ok: true }) } },
          ],
        });
      }
      // 第二次激活：贡献命令后同步抛错 —— 独立生命周期的回滚必须清除该命令
      context.contribute({
        commands: [
          { kind: 'command', command: { id: 'example.second', title: '残留', execute: () => ({ ok: true }) } },
        ],
      });
      throw boom;
    });
    await host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.first')).toBe(true);

    const reentrant: Promise<void>[] = [];
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'disabled' && e.instanceId === 'com.example.plugin') {
        reentrant.push(host.enable(e.instanceId));
      }
    });
    await host.disable('com.example.plugin');
    // 终态事件内重入 enable 的激活失败必须进入独立生命周期：状态 failed、原因落盘、贡献项清除
    await Promise.all(reentrant);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('failed');
    expect(host.getPlugin('com.example.plugin')?.reason).toContain('激活失败');
    expect(host.commands.has('example.first')).toBe(false);
    expect(host.commands.has('example.second')).toBe(false);
    expect(host.contributions.count()).toBe(0);
  });

  it('晚到 async Disposable 清理计入 disable completion：旧代清理完成后才返回，不污染新代', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    const activateGate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    let external = true;
    const activate = vi.fn(async () => {
      await activateGate;
      external = true;
      return {
        async dispose() {
          await disposeGate;
          external = false;
        },
      };
    });
    const registering = host.register(descriptor(VALID_MANIFEST, async () => ({ default: { activate } })));
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));
    // 激活挂起期间停用：生命周期等待本尝试的唯一完成点（钩子 settle + 晚到返回值清理）
    const disabling = host.disable('com.example.plugin');
    let disabled = false;
    disabling.then(() => {
      disabled = true;
    });

    // 钩子 settle 并返回 async Disposable：晚到清理挂起期间 disable 不得提前返回
    releaseActivate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disabled).toBe(false);
    expect(external).toBe(true);

    // 放行晚到返回值清理：disable 在旧代完整收尾后返回，外部资源已释放
    releaseDispose();
    await disabling;
    expect(external).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');

    // 旧代清理已完整结束：重新启用后不再被晚到的旧清理跨代污染
    await registering;
    await host.enable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(external).toBe(true);
  });

  it('激活失败回滚的贡献清理事件内 disable：终态 disabled，且调用等待完整清理', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    let changedCount = 0;
    let disabling: Promise<void> | undefined;
    let disablingResolved = false;
    host.events.on('contribution:changed', (e) => {
      if (e.pluginId !== 'com.example.plugin') return;
      changedCount += 1;
      // 第一次是 contribute 时；第二次是回滚移除贡献项时 —— 事件内调用 disable
      if (changedCount === 2) {
        disabling = host.disable('com.example.plugin');
        disabling.then(() => {
          disablingResolved = true;
        });
      }
    });
    const activate = vi.fn((context: PluginContext) => {
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.rollback-panel', title: '回滚面板', component: () => null },
        ],
      });
      throw new Error('激活爆炸');
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );
    // 激活抛错 → 失败生命周期先发布并认领 → 回滚清理（贡献移除 + deactivate 钩子）进行中
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    expect(changedCount).toBe(2);
    await vi.waitFor(() => expect(disabling).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 贡献清理事件内的 disable 合并进同一生命周期：完整清理（含 deactivate 钩子）前不返回
    expect(disablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseDeactivate();
    await disabling!;
    expect(disablingResolved).toBe(true);
    // disabled 对旧失败终态的优先级：终态为 disabled（非 failed），失败原因不落盘
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();
    expect(host.getPlugin('com.example.plugin')?.error).toBeUndefined();
    expect(host.contributions.count()).toBe(0);
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('activating 期间 register 加入同一激活完成：闸门释放前不完成，返回快照 active', async () => {
    const host = new PluginHost();
    let releaseActivate!: () => void;
    const activateGate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const activate = vi.fn(async (context: PluginContext) => {
      await activateGate;
      return context.contribute({
        commands: [
          { kind: 'command', command: { id: 'example.joined', title: '加入', execute: () => ({ ok: true }) } },
        ],
      });
    });
    let reentrant!: Promise<void>;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'loading' && e.instanceId === 'com.example.plugin') {
        reentrant = host.enable(e.instanceId);
      }
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));
    let info: PluginInfo | undefined;
    let registered = false;
    registering.then((result) => {
      registered = true;
      info = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 激活闸门释放前 register 不得完成（加入同一完整激活流程，而非提前返回 activating 快照）
    expect(registered).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('activating');

    releaseActivate();
    await registering;
    await reentrant;
    // 返回快照为 active，不得放宽为接受 activating；同代激活只有一次，register 不重复启动
    expect(registered).toBe(true);
    expect(info?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(activate).toHaveBeenCalledTimes(1);
    expect(host.commands.has('example.joined')).toBe(true);
  });

  it('跨代 loading ABA：旧 loader 挂起 → disable → 新 enable 加载 → 旧 loader 返回，旧注册流按取消路径结束', async () => {
    const host = new PluginHost();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const entry = vi
      .fn()
      .mockImplementationOnce(async () => {
        await oldGate;
        return { default: definitionOf() };
      })
      .mockImplementationOnce(async () => {
        await newGate;
        return { default: definitionOf() };
      });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));

    // 旧加载挂起期间停用（代际推进），随后新一代 enable 启动新加载
    await host.disable('com.example.plugin');
    const enabling = host.enable('com.example.plugin');
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(2));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');

    // 旧 loader 返回：旧注册流恢复 —— 只能按取消路径结束，不得依据新代 state
    // 启动激活或写入失败（旧实现会以“定义缺失”拒绝）
    releaseOld();
    const oldResult = await registering;
    expect(oldResult.state).not.toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();
    expect(host.getPlugin('com.example.plugin')?.error).toBeUndefined();
    expect(host.commands.has('example.hello')).toBe(false);

    // 新 loader 放行：新代正常激活，旧代晚到结果未污染新代
    releaseNew();
    await enabling;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('首个贡献同步触发 disable（activate 返回 void）：过期句柄随尝试完成释放，终态 disabled 且贡献为 0', async () => {
    const host = new PluginHost();
    let changedCount = 0;
    let disabling: Promise<void> | undefined;
    let disablingResolved = false;
    host.events.on('contribution:changed', (e) => {
      if (e.pluginId !== 'com.example.plugin') return;
      changedCount += 1;
      // 第一个事件在句柄返回前同步发出：事件内停用，句柄尚未归属任何集合
      if (changedCount === 1) {
        disabling = host.disable('com.example.plugin');
        disabling.then(() => {
          disablingResolved = true;
        });
      }
    });
    const activate = vi.fn((context: PluginContext) => {
      // 首次贡献同步触发事件内停用后返回 void（不做任何事）
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.first-panel', title: '首面板', component: () => null },
        ],
      });
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    await vi.waitFor(() => expect(disabling).toBeDefined());
    await registering;
    // 过期句柄已随尝试完成释放：停用完整收敛后贡献为零，不遗留停用后仍可见的资源
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(host.contributions.getPanels()).toHaveLength(0);
    expect(changedCount).toBeGreaterThanOrEqual(2);
    await disabling!;
    expect(disablingResolved).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('激活被取消且 deactivate 挂起：owner 的 register 加入同一生命周期收敛，不得提前返回', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    const activate = vi.fn(() => undefined);
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'activating' && e.instanceId === 'com.example.plugin') {
        // 不等待：生命周期等待激活尝试完成，事件内返回即摘除尝试
        void host.disable('com.example.plugin');
      }
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    let registered = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registered = true;
      info = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 取消的回滚（deactivate 钩子）挂起期间 register 不得完成
    expect(registered).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseDeactivate();
    await registering;
    expect(registered).toBe(true);
    expect(info?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('取消收敛期间重入激活同步失败且 deactivate 挂起：register 加入回滚收敛，不得提前返回', async () => {
    const host = new PluginHost();
    let releaseDeactivate1!: () => void;
    const deactivateGate1 = new Promise<void>((resolve) => {
      releaseDeactivate1 = resolve;
    });
    let releaseDeactivate2!: () => void;
    const deactivateGate2 = new Promise<void>((resolve) => {
      releaseDeactivate2 = resolve;
    });
    const deactivate = vi
      .fn()
      .mockImplementationOnce(async () => {
        await deactivateGate1;
      })
      .mockImplementationOnce(async () => {
        await deactivateGate2;
      });
    // 首次激活在 activating 事件内被取消（钩子不调用）；重入激活同步失败进入异步回滚
    const activate = vi.fn(() => {
      throw new Error('重入激活爆炸');
    });
    let activatingCount = 0;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'activating' && e.instanceId === 'com.example.plugin') {
        activatingCount += 1;
        // 仅首次激活取消（不等待：生命周期等待激活尝试完成，事件内返回即摘除尝试）；
        // disabled 事件内重入的新激活必须保留，使其同步失败进入异步回滚
        if (activatingCount === 1) void host.disable('com.example.plugin');
      }
    });
    // disabled 终态事件内重入 enable：新激活同步失败并进入异步回滚（deactivate 挂起）
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'disabled' && e.instanceId === 'com.example.plugin') {
        void host.enable('com.example.plugin');
      }
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    let registered = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registered = true;
      info = result;
    });
    // 放行第一次停用 → disabled 终态事件内重入 enable → 新激活同步失败 → 异步回滚
    releaseDeactivate1();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 重入激活的异步回滚挂起期间，register 不得提前返回（旧实现摘除尝试后
    // 立即返回 deactivating 快照，回滚未完成）
    expect(registered).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseDeactivate2();
    await registering;
    expect(registered).toBe(true);
    expect(info?.state).toBe('failed');
    expect(info?.reason).toContain('激活失败');
    expect(host.getPlugin('com.example.plugin')?.reason).toContain('激活失败');
    expect(activate).toHaveBeenCalledTimes(1);
    expect(deactivate).toHaveBeenCalledTimes(2);
  });

  it('disabled 终态事件内启动慢激活：外层 register 循环加入新激活，收敛到 active', async () => {
    const host = new PluginHost();
    let releaseSlowActivate!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlowActivate = resolve;
    });
    const activate = vi
      .fn()
      .mockImplementationOnce((context: PluginContext) => {
        // 首次激活：同步贡献，contribution:changed 事件内停用（activate 返回 void）
        context.contribute({
          panels: [
            { kind: 'panel', id: 'com.example.plugin.first-panel', title: '首面板', component: () => null },
          ],
        });
      })
      .mockImplementationOnce(async () => {
        // disabled 终态事件内重入 enable 启动的慢激活
        await slowGate;
      });
    let changedCount = 0;
    host.events.on('contribution:changed', (e) => {
      if (e.pluginId !== 'com.example.plugin') return;
      changedCount += 1;
      if (changedCount === 1) void host.disable('com.example.plugin');
    });
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'disabled' && e.instanceId === 'com.example.plugin') {
        // 不等待：新激活由 register 的收敛循环加入
        void host.enable('com.example.plugin');
      }
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    let registered = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registered = true;
      info = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 终态事件内启动的慢激活进行中：外层 register 已加入新激活流程，不得提前返回
    expect(registered).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('activating');
    // 中间停用已完整收敛：首个贡献的过期句柄未遗留
    expect(host.contributions.count()).toBe(0);

    releaseSlowActivate();
    await registering;
    expect(registered).toBe(true);
    expect(info?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('loading 事件内同步 disable + enable：旧注册流按取消路径结束，不激活、不写失败，新代正常激活', async () => {
    const host = new PluginHost();
    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    // 旧代 loader 调用会被代际复核拦截（旧注册流取消），只有新一代的加载实际发生
    const entry = vi.fn(async () => {
      await newGate;
      return { default: definitionOf() };
    });
    let loadingCount = 0;
    host.events.on('plugin:state-changed', (e) => {
      if (e.state !== 'loading' || e.instanceId !== 'com.example.plugin') return;
      loadingCount += 1;
      // 首次 loading 事件内同步停用 + 重新启用：推进代际并启动新一代加载
      if (loadingCount === 1) {
        void host.disable('com.example.plugin');
        void host.enable('com.example.plugin');
      }
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');

    // 旧注册流恢复：代际在事件前已捕获（不等同于新代身份），只能按取消路径结束，
    // 不得依据新代 state 启动激活或写入失败（旧实现以“定义缺失”拒绝）
    const oldResult = await registering;
    expect(oldResult.state).not.toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();
    expect(host.getPlugin('com.example.plugin')?.error).toBeUndefined();
    expect(host.commands.has('example.hello')).toBe(false);

    // 新代加载放行：新代正常激活，旧注册流未污染新代
    releaseNew();
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('active'));
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(1);
  });

  it('多项 bundle 首个贡献同步触发 disable：过期句柄归入尝试完成点，register/disable 返回前贡献为 0', async () => {
    const host = new PluginHost();
    // 64 项 bundle：逐项释放分散在多次 await 之间 —— fire-and-forget 的独立释放链
    // 慢于 register/disable 的收敛链，返回时必然留下残留
    const panelIds = Array.from({ length: 64 }, (_, i) => `com.example.plugin.panel-${i}`);
    let changedCount = 0;
    let disabling: Promise<void> | undefined;
    let disablingResolved = false;
    let countAtDisableReturn = -1;
    host.events.on('contribution:changed', (e) => {
      if (e.pluginId !== 'com.example.plugin') return;
      changedCount += 1;
      // 第一个事件在句柄返回前同步发出：事件内停用，句柄尚未归属任何集合
      if (changedCount === 1) {
        disabling = host.disable('com.example.plugin');
        // 在 disable() 解析的同一微任务轮次锁定其自身清理完成时点的贡献计数：
        // disable() 返回前必须已释放全部过期贡献（与 register 侧捕获互补）
        disabling.then(() => {
          disablingResolved = true;
          countAtDisableReturn = host.contributions.count();
        });
      }
    });
    const activate = vi.fn((context: PluginContext) => {
      // 首次贡献同步触发事件内停用后返回 void；64 项 bundle 使释放分散在多次
      // await 之间 —— fire-and-forget 会在 register/disable 返回时留下残留
      context.contribute({
        panels: panelIds.map((id) => ({
          kind: 'panel' as const,
          id,
          title: `面板-${id}`,
          component: () => null,
        })),
      });
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    // 在 register 解析的同一微任务轮次捕获贡献计数：任何宏任务边界（vi.waitFor、
    // setTimeout 等）都会让 fire-and-forget 的独立释放链追平时间、掩盖残留
    const countAtReturn = registering.then(() => host.contributions.count());
    const info = await registering;
    // 过期句柄的 disposal 已归入尝试 completion 并由生命周期显式等待：
    // register() 返回（完整收敛）前全部 64 项已释放，不得残留停用后仍可见的资源
    expect(await countAtReturn).toBe(0);
    expect(info.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(host.contributions.count()).toBe(0);
    expect(host.contributions.getPanels()).toHaveLength(0);
    expect(changedCount).toBeGreaterThanOrEqual(2);
    await disabling!;
    expect(disablingResolved).toBe(true);
    expect(countAtDisableReturn).toBe(0);
    expect(host.contributions.count()).toBe(0);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('disabled 终态事件内新代复用同一贡献 ID：旧代句柄已释放，不因 id 重复而失败', async () => {
    const host = new PluginHost();
    const sharedId = 'com.example.plugin.shared';
    const panelIds = Array.from({ length: 16 }, (_, i) => `com.example.plugin.panel-${i}`);
    const activate = vi
      .fn()
      .mockImplementationOnce((context: PluginContext) => {
        // 首次激活：多项 bundle 含复用目标 ID，同步触发事件内停用后返回 void
        context.contribute({
          panels: [...panelIds, sharedId].map((id) => ({
            kind: 'panel' as const,
            id,
            title: `面板-${id}`,
            component: () => null,
          })),
        });
      })
      .mockImplementationOnce((context: PluginContext) => {
        // disabled 终态事件内重入的新代：复用同一贡献 ID —— 旧代句柄必须已释放，
        // 否则 registry 校验以"贡献项 panel 的 id 重复"整体失败
        context.contribute({
          panels: [{ kind: 'panel', id: sharedId, title: '共享面板', component: () => null }],
        });
      });
    let changedCount = 0;
    host.events.on('contribution:changed', (e) => {
      if (e.pluginId !== 'com.example.plugin') return;
      changedCount += 1;
      if (changedCount === 1) void host.disable('com.example.plugin');
    });
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'disabled' && e.instanceId === 'com.example.plugin') {
        void host.enable('com.example.plugin');
      }
    });
    const info = await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate } })),
    );
    expect(info.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.reason).toBeUndefined();
    // 新代贡献保留，旧代全部句柄已随收敛释放
    expect(host.contributions.count()).toBe(1);
    expect(host.contributions.getPanels().map((p) => p.id)).toEqual([sharedId]);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('active 事件内同步 disable 且 deactivate 挂起：激活调用加入同一生命周期收敛，不提前返回', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    const activate = vi.fn(() => undefined);
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'active' && e.instanceId === 'com.example.plugin') {
        // 不等待：生命周期（deactivate 钩子挂起）在事件内启动
        void host.disable('com.example.plugin');
      }
    });
    const registering = host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    let registered = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registered = true;
      info = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // active 事件内启动的慢停用进行中：激活调用已加入同一生命周期，不得提前返回 deactivating 快照
    expect(registered).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseDeactivate();
    await registering;
    expect(registered).toBe(true);
    expect(info?.state).toBe('disabled');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('disabled 终态事件内启动新代慢 loader：外层 enable 加入当前代加载收敛，不提前返回 loading', async () => {
    const host = new PluginHost();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const entry = vi
      .fn()
      .mockImplementationOnce(async () => {
        await oldGate;
        return { default: definitionOf() };
      })
      .mockImplementationOnce(async () => {
        await newGate;
        return { default: definitionOf() };
      });
    // disabled 终态事件内重入 enable：旧加载结果已被代际复核丢弃（无定义缓存），
    // 重入调用启动新代慢 loader（统一收敛状态机须纳入当前代 loading）
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'disabled' && e.instanceId === 'com.example.plugin') {
        void host.enable('com.example.plugin');
      }
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    // 外层 enable 在旧加载在途时开始：共享同一加载操作
    const enabling = host.enable('com.example.plugin');
    let enablingResolved = false;
    enabling.then(() => {
      enablingResolved = true;
    });
    // 加载挂起期间停用：disabled 终态事件内重入 enable 启动新代慢 loader
    await host.disable('com.example.plugin');
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(2));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 新代慢 loader 挂起期间外层 enable 不得提前返回 loading 快照
    // （旧实现按捕获代际过期返回，resolve 时状态仍为 loading）
    expect(enablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');

    // 旧 loader 放行：结果被丢弃，但外层 enable 必须继续等待当前代新加载
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');

    releaseNew();
    await enabling;
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('新代 loader 先完成并进入挂起 activation：外层 enable 加入在途激活，旧 loader 后完成不提前返回', async () => {
    const host = new PluginHost();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activate = vi.fn((context: PluginContext) => {
      context.contribute({
        panels: [
          { kind: 'panel', id: 'com.example.plugin.panel', title: '示例面板', component: () => null },
        ],
        commands: [
          { kind: 'command', command: { id: 'example.hello', title: '打招呼', execute: () => ({ ok: true }) } },
        ],
      });
      // 贡献同步生效后挂起：activation 在途
      return activationGate;
    });
    const entry = vi
      .fn()
      .mockImplementationOnce(async () => {
        // 旧代 loader：挂起直至测试放行（旧 loader 最后完成）
        await oldGate;
        return { default: { activate, deactivate: () => {} } };
      })
      .mockImplementationOnce(async () => {
        // 新代 loader：立即完成，进入挂起的 activation（新 loader 先完成）
        return { default: { activate, deactivate: () => {} } };
      });
    // disabled 终态事件内重入 enable：启动新代 loader
    host.events.on('plugin:state-changed', (e) => {
      if (e.state === 'disabled' && e.instanceId === 'com.example.plugin') {
        void host.enable('com.example.plugin');
      }
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    // 外层 enable 在旧加载在途时开始：共享同一加载操作
    const enabling = host.enable('com.example.plugin');
    let enablingResolved = false;
    enabling.then(() => {
      enablingResolved = true;
    });
    // 加载挂起期间停用：disabled 终态事件内重入 enable 启动新代 loader
    await host.disable('com.example.plugin');
    // 新 loader 先完成并进入挂起的 activation（旧 loader 仍在途）
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('activating'));
    expect(activate).toHaveBeenCalledTimes(1);
    // 旧 loader 放行：外层 enable 不得因 record.loading 已清空（新代加载已完成）
    // 而以 activating 快照提前成功 —— 必须加入新代在途 activation 的同一完整流程
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enablingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('activating');
    // 放行新代 activation：外层 enable 收敛到稳定 active
    releaseActivation();
    await enabling;
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(host.commands.has('example.hello')).toBe(true);
    expect(entry).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('多记录销毁：前序慢停用卡住时后序激活失败，owner 与共享销毁完成点一并收敛', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivateA = vi.fn(() => deactivateGate);
    // A 先注册并激活：deactivate 挂起（销毁顺序清理时卡在 A）
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: definitionOf({ deactivate: deactivateA }) })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    // B 后注册且 activation 挂起（随后拒绝）
    let rejectActivation!: (error: Error) => void;
    const activationGate = new Promise<void>((_, reject) => {
      rejectActivation = reject;
    });
    const registeringB = host.register(
      descriptor(
        { ...VALID_MANIFEST, id: 'com.example.plugin.b' },
        async () => ({ default: { activate: () => activationGate } }),
      ),
    );
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin.b')?.state).toBe('activating'));
    let disposeResolved = false;
    let bResolved = false;
    const disposing = host.dispose();
    disposing.then(() => {
      disposeResolved = true;
    });
    registeringB.then(() => {
      bResolved = true;
    });
    // 销毁卡在 A 的慢停用；B 的 activate 钩子此时拒绝
    await vi.waitFor(() => expect(deactivateA).toHaveBeenCalledTimes(1));
    rejectActivation(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // B 的 register() 不得以 activating 快照提前成功（宿主销毁仍挂起）
    expect(bResolved).toBe(false);
    expect(disposeResolved).toBe(false);
    // 放行 A：B 的 register 与共享宿主销毁完成点一并收敛
    releaseDeactivate();
    await disposing;
    expect(disposeResolved).toBe(true);
    await registeringB;
    expect(bResolved).toBe(true);
    expect(host.getPlugin('com.example.plugin')?.state).toBeUndefined();
    expect(host.getPlugin('com.example.plugin.b')?.state).toBeUndefined();
    expect(host.contributions.count()).toBe(0);
  });

  it('慢 deactivate 期间直接 activate：等待收敛后重新驱动激活意图，最终 active', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    const activate = vi.fn(() => undefined);
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate, deactivate } })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');

    const deactivating = host.deactivate('com.example.plugin');
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating'));
    const activating = host.activate('com.example.plugin');
    let activatingResolved = false;
    activating.then(() => {
      activatingResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 慢 deactivate 进行中：直接 activate 不得 silent success（旧实现立即返回，意图丢失）
    expect(activatingResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('deactivating');

    releaseDeactivate();
    await activating;
    await deactivating;
    // 停用收敛后激活意图被重新驱动：新尝试完成，终态 active
    expect(activatingResolved).toBe(true);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(activate).toHaveBeenCalledTimes(2);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('慢停用期间二次 dispose：所有并发 dispose 等待同一真实清理，不独立提前 resolve', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivate = vi.fn(async () => {
      await deactivateGate;
    });
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: { activate: () => undefined, deactivate } })),
    );
    const d1 = host.dispose();
    const d2 = host.dispose();
    let d1Resolved = false;
    let d2Resolved = false;
    d1.then(() => {
      d1Resolved = true;
    });
    d2.then(() => {
      d2Resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 真实清理（deactivate 钩子）挂起期间，二次 dispose 与首轮等待同一完成点
    expect(d1Resolved).toBe(false);
    expect(d2Resolved).toBe(false);
    expect(deactivate).toHaveBeenCalledTimes(1);

    releaseDeactivate();
    await Promise.all([d1, d2]);
    expect(d1Resolved).toBe(true);
    expect(d2Resolved).toBe(true);
    expect(host.listPlugins()).toHaveLength(0);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('同步 dispose 后 enable：销毁开始即明确拒绝，不创建孤立激活尝试、不永久 pending', async () => {
    const host = new PluginHost();
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: definitionOf() })),
    );
    await host.disable('com.example.plugin');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');

    // 同步窗口：dispose 已登记销毁（记录尚未清空），enable 必须立即拒绝，
    // 不得走完激活流程留下无人收敛的孤立尝试（workflow 无人 resolve → 永久 pending）
    const d = host.dispose();
    const outcome = await Promise.race([
      host.enable('com.example.plugin').then(
        () => 'resolved',
        (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 200)),
    ]);
    expect(outcome).toBe('rejected:插件宿主已销毁');
    await d;
    expect(host.listPlugins()).toHaveLength(0);
  });

  it('代际失效的旧 enable 只观察当前代：E0 旧 loader 晚到，不依据残留 definition 重放激活', async () => {
    const host = new PluginHost();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const activate = vi.fn(() => undefined);
    const entry = vi
      .fn()
      .mockImplementationOnce(async () => {
        await oldGate;
        return { default: { activate, deactivate: () => undefined } };
      })
      .mockImplementationOnce(async () => ({ default: { activate, deactivate: () => undefined } }));
    let activatingEvents = 0;
    let reentered = false;
    host.events.on('plugin:state-changed', (e) => {
      if (e.instanceId !== 'com.example.plugin') return;
      if (e.state === 'activating') {
        activatingEvents += 1;
        // E1 的 activating 事件内 D2：新代缓存 definition 后再停用
        void host.disable('com.example.plugin');
      } else if (e.state === 'disabled' && !reentered) {
        reentered = true;
        // D1 的 disabled 终态事件内 E1：启动新代加载（缓存 definition 后进入 activating）
        void host.enable('com.example.plugin');
      }
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));
    // E0：加入在途旧加载
    const enabling = host.enable('com.example.plugin');
    // D1：停用（旧加载作废，disabled 终态事件内 E1 启动新代）
    await host.disable('com.example.plugin');
    // D2 的 disabled 终态：新代激活被取消且稳定为 disabled
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled'));
    expect(activatingEvents).toBe(1);
    expect(activate).not.toHaveBeenCalled();
    // E0 的旧 loader 晚到：代际已失效 —— 只观察当前代收敛后直接返回，
    // 绝不依据残留 definition 重放已被取消的旧激活意图
    releaseOld();
    await enabling;
    await registering;
    expect(host.getPlugin('com.example.plugin')?.state).toBe('disabled');
    expect(activatingEvents).toBe(1);
    expect(activate).not.toHaveBeenCalled();
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('多记录成功路径：B 的 active 事件内触发宿主销毁，register 与共享销毁完成点一并收敛', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivateA = vi.fn(() => deactivateGate);
    // A 先注册并激活：deactivate 挂起（销毁顺序清理时卡在 A）
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: definitionOf({ deactivate: deactivateA }) })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    // B 的 active 状态事件内触发宿主销毁
    let disposing!: Promise<void>;
    let disposeTriggered = false;
    let disposeResolved = false;
    host.events.on('plugin:state-changed', (e) => {
      if (e.instanceId !== 'com.example.plugin.b' || e.state !== 'active' || disposeTriggered) return;
      disposeTriggered = true;
      disposing = host.dispose();
      disposing.then(() => {
        disposeResolved = true;
      });
    });
    // B 使用无贡献定义：A 已占用 definitionOf 默认贡献 id，避免激活冲突
    const registeringB = host.register(
      descriptor({ ...VALID_MANIFEST, id: 'com.example.plugin.b' }, async () => ({ default: { activate: () => undefined } })),
    );
    let bResolved = false;
    registeringB.then(() => {
      bResolved = true;
    });
    await vi.waitFor(() => expect(disposeTriggered).toBe(true));
    await vi.waitFor(() => expect(deactivateA).toHaveBeenCalledTimes(1));
    // 宿主销毁仍卡在 A：B 的 register（成功路径）不得提前解析
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bResolved).toBe(false);
    expect(disposeResolved).toBe(false);
    // 放行 A：B 的 register 与共享宿主销毁完成点一并收敛
    releaseDeactivate();
    await disposing;
    expect(disposeResolved).toBe(true);
    const infoB = await registeringB;
    expect(bResolved).toBe(true);
    // 公共调用返回的终态快照：销毁下生命周期落定为 inactive，而非 deactivating 过渡态
    expect(infoB.state).toBe('inactive');
    expect(host.getPlugin('com.example.plugin')?.state).toBeUndefined();
    expect(host.getPlugin('com.example.plugin.b')?.state).toBeUndefined();
    expect(host.contributions.count()).toBe(0);
  });

  it('销毁窗口内晚到加载：loading owner 的 register 与共享宿主销毁完成点一并收敛', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivateA = vi.fn(() => deactivateGate);
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: definitionOf({ deactivate: deactivateA }) })),
    );
    // B：入口 loader 挂起（loading 在途）
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    const registeringB = host.register(
      descriptor({ ...VALID_MANIFEST, id: 'com.example.plugin.b' }, async () => {
        await loaderGate;
        return { default: definitionOf() };
      }),
    );
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin.b')?.state).toBe('loading'));
    let bResolved = false;
    let disposeResolved = false;
    registeringB.then(() => {
      bResolved = true;
    });
    const disposing = host.dispose();
    disposing.then(() => {
      disposeResolved = true;
    });
    await vi.waitFor(() => expect(deactivateA).toHaveBeenCalledTimes(1));
    // 放行 B 的 loader：晚到加载结果被销毁代际丢弃，但 owner 必须等宿主销毁完成
    releaseLoader();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bResolved).toBe(false);
    expect(disposeResolved).toBe(false);
    releaseDeactivate();
    await disposing;
    expect(disposeResolved).toBe(true);
    const infoB = await registeringB;
    expect(bResolved).toBe(true);
    // 销毁下生命周期落定终态：loading owner 返回 inactive 而非过渡态快照
    expect(infoB.state).toBe('inactive');
    expect(host.listPlugins()).toHaveLength(0);
  });

  it('销毁窗口内加入在途激活：activation joiner 的 enable 与共享宿主销毁完成点一并收敛', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivateA = vi.fn(() => deactivateGate);
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: definitionOf({ deactivate: deactivateA }) })),
    );
    // B：activation 挂起（闸门）
    let releaseActivate!: () => void;
    const activateGate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });
    const registeringB = host.register(
      descriptor(
        { ...VALID_MANIFEST, id: 'com.example.plugin.b' },
        async () => ({ default: { activate: () => activateGate } }),
      ),
    );
    let bResolved = false;
    registeringB.then(() => {
      bResolved = true;
    });
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin.b')?.state).toBe('activating'));
    // joiner：销毁窗口内加入 B 的在途激活
    const joining = host.enable('com.example.plugin.b');
    let joinedResolved = false;
    let disposeResolved = false;
    joining.then(() => {
      joinedResolved = true;
    });
    const disposing = host.dispose();
    disposing.then(() => {
      disposeResolved = true;
    });
    await vi.waitFor(() => expect(deactivateA).toHaveBeenCalledTimes(1));
    // 放行 B 的激活：成功路径发布 active，但宿主销毁仍卡在 A —— joiner 与
    // owner 均不得提前解析（owner 经成功路径的公共退出契约与共享销毁完成点收敛）
    releaseActivate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(joinedResolved).toBe(false);
    expect(bResolved).toBe(false);
    expect(disposeResolved).toBe(false);
    releaseDeactivate();
    await disposing;
    expect(disposeResolved).toBe(true);
    await joining;
    expect(joinedResolved).toBe(true);
    await registeringB;
    expect(bResolved).toBe(true);
    expect(host.listPlugins()).toHaveLength(0);
  });

  it('enabled:false 的 disabled 事件内启动慢 enable：register 收敛到 active，不返回 loading 快照', async () => {
    const host = new PluginHost();
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    const entry = vi.fn(async () => {
      await loaderGate;
      return { default: definitionOf() };
    });
    let reentered = false;
    host.events.on('plugin:state-changed', (e) => {
      if (e.instanceId !== 'com.example.plugin' || e.state !== 'disabled' || reentered) return;
      reentered = true;
      // disabled 终态事件内同步启动慢 enable：监听器在首个 await 前把记录推进到 loading
      void host.enable('com.example.plugin');
    });
    const registering = host.register(descriptor({ ...VALID_MANIFEST, enabled: false }, entry));
    let registeredResolved = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registeredResolved = true;
      info = result;
    });
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));
    // 慢 loader 在途：register（owner）必须加入同一加载/激活收敛，
    // 不得以 loading 过渡态快照提前成功
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registeredResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    releaseLoader();
    await registering;
    expect(registeredResolved).toBe(true);
    expect(info?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(entry).toHaveBeenCalledTimes(1);
  });

  it('非法 Manifest 的 failed 事件内触发跨记录慢 host dispose：register 经公共退出契约收敛', async () => {
    const host = new PluginHost();
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    const deactivateA = vi.fn(() => deactivateGate);
    // A：正常插件，deactivate 挂起（销毁顺序清理时卡在 A）
    await host.register(
      descriptor(VALID_MANIFEST, async () => ({ default: definitionOf({ deactivate: deactivateA }) })),
    );
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    // B：非法 Manifest —— failed 终态事件内触发宿主销毁
    let disposing!: Promise<void>;
    let disposeTriggered = false;
    let disposeResolved = false;
    host.events.on('plugin:state-changed', (e) => {
      if (e.instanceId !== 'com.example.invalid' || e.state !== 'failed' || disposeTriggered) return;
      disposeTriggered = true;
      disposing = host.dispose();
      disposing.then(() => {
        disposeResolved = true;
      });
    });
    const registering = host.register(
      descriptor({ ...VALID_MANIFEST, id: 'com.example.invalid', contributes: 'not-an-array' }),
    );
    let registeredResolved = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registeredResolved = true;
      info = result;
    });
    await vi.waitFor(() => expect(disposeTriggered).toBe(true));
    await vi.waitFor(() => expect(deactivateA).toHaveBeenCalledTimes(1));
    // 宿主销毁仍卡在 A：B 的 register（failed 终态出口）不得提前解析
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registeredResolved).toBe(false);
    expect(disposeResolved).toBe(false);
    releaseDeactivate();
    await disposing;
    expect(disposeResolved).toBe(true);
    await registering;
    expect(registeredResolved).toBe(true);
    // 销毁下生命周期落定终态：failed 记录返回 inactive（销毁合并目标），
    // 而非 deactivating 过渡态快照
    expect(info?.state).toBe('inactive');
    expect(host.listPlugins()).toHaveLength(0);
  });

  it('registered 事件内启动慢 enable：register 收敛到 active，不返回 loading 快照', async () => {
    const host = new PluginHost();
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    const entry = vi.fn(async () => {
      await loaderGate;
      return { default: definitionOf() };
    });
    let reentered = false;
    host.events.on('plugin:state-changed', (e) => {
      if (e.instanceId !== 'com.example.plugin' || e.state !== 'registered' || reentered) return;
      reentered = true;
      // registered 同步事件内启动慢 enable：监听器在首个 await 前把记录推进到 loading
      void host.enable('com.example.plugin');
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    let registeredResolved = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registeredResolved = true;
      info = result;
    });
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(1));
    // 慢 loader 在途：register（owner）必须加入同一加载/激活收敛，
    // 不得以 loading 过渡态快照提前成功
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registeredResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    releaseLoader();
    await registering;
    expect(registeredResolved).toBe(true);
    expect(info?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(entry).toHaveBeenCalledTimes(1);
  });

  it('首次 loader 抛错、failed 事件内立即 enable、第二次 gated 成功：重试驱动独立加载并收敛到 active', async () => {
    const host = new PluginHost();
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    let call = 0;
    const entry = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('首次加载失败');
      await loaderGate;
      return { default: definitionOf() };
    });
    let retried = false;
    let retry!: Promise<void>;
    let retryResolved = false;
    host.events.on('plugin:state-changed', (e) => {
      if (e.instanceId !== 'com.example.plugin' || e.state !== 'failed' || retried) return;
      retried = true;
      // failed 终态事件内同步重试：不得共享即将结束的旧失败加载（silent success），
      // 必须创建独立加载重新驱动 loader
      retry = host.enable('com.example.plugin');
      retry.then(() => {
        retryResolved = true;
      });
    });
    const registering = host.register(descriptor(VALID_MANIFEST, entry));
    let registeredResolved = false;
    let info: PluginInfo | undefined;
    registering.then((result) => {
      registeredResolved = true;
      info = result;
    });
    // 首次加载以拒绝（async 抛错）在微任务发布 failed；failed 事件内同步启动的
    // 重试必须创建独立加载 —— loader 被第二次调用（第二次 gated 加载在途）
    await vi.waitFor(() => expect(entry).toHaveBeenCalledTimes(2));
    expect(retried).toBe(true);
    await vi.waitFor(() => expect(host.getPlugin('com.example.plugin')?.state).toBe('loading'));
    // 闸门释放前：重试调用与 register（owner）均不得解析 —— 不得 silent success 后仍停在 failed
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registeredResolved).toBe(false);
    expect(retryResolved).toBe(false);
    expect(host.getPlugin('com.example.plugin')?.state).toBe('loading');
    releaseLoader();
    await registering;
    await retry;
    expect(registeredResolved).toBe(true);
    expect(retryResolved).toBe(true);
    expect(info?.state).toBe('active');
    expect(host.getPlugin('com.example.plugin')?.state).toBe('active');
    expect(entry).toHaveBeenCalledTimes(2);
  });
});
