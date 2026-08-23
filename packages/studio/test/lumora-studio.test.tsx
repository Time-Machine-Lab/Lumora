import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode, createRef } from 'react';
import * as THREE from 'three';
import { createGroupObject, createSampleProject } from '@lumora/core';
import type { Manifest, PanelContextProps, PluginDescriptor } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import { CommandPalette } from '../src/components/CommandPalette';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-canvas">{children}</div>
  ),
  useThree: (selector?: (state: unknown) => unknown) => {
    const state = {
      scene: new THREE.Group(),
      set: () => undefined,
      camera: new THREE.PerspectiveCamera(),
      gl: { setViewport: () => undefined, setScissor: () => undefined, setScissorTest: () => undefined },
      size: { width: 800, height: 600 },
      viewport: { dpr: 1 },
    };
    return selector ? selector(state) : state;
  },
  useFrame: () => undefined,
}));

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  TransformControls: () => null,
}));

function TestPanel(props: PanelContextProps) {
  return <div data-testid="test-panel">面板内容 · 插件 {props.pluginId}</div>;
}

const GOOD_MANIFEST: Manifest = {
  schemaVersion: '1',
  id: 'com.test.good',
  name: '好插件',
  version: '0.1.0',
  entry: './dist/index.js',
};

const goodPlugin: PluginDescriptor = {
  manifest: GOOD_MANIFEST,
  entry: async () => ({
    default: {
      activate: (context) =>
        context.contribute({
          panels: [
            { kind: 'panel', id: 'com.test.good.panel', title: '测试面板', component: TestPanel },
          ],
          toolbars: [
            { kind: 'toolbar', id: 'com.test.good.tb', label: '测试命令', commandId: 'com.test.good.cmd' },
          ],
          commands: [
            {
              kind: 'command',
              command: { id: 'com.test.good.cmd', title: '测试命令', execute: () => ({ ok: true }) },
            },
          ],
        }),
    },
  }),
};

const badPlugin: PluginDescriptor = {
  manifest: {
    schemaVersion: '2',
    id: 'com.test.bad',
    name: '坏插件',
    version: '0.1.0',
    entry: './dist/index.js',
  } as unknown as Manifest,
};

describe('LumoraStudio', () => {
  it('渲染壳层并激活合法插件：面板、工具栏贡献项可见', async () => {
    render(<LumoraStudio plugins={[goodPlugin]} hostVersion="0.1.0" />);
    expect(await screen.findByTestId('lumora-studio')).toBeInTheDocument();
    expect(await screen.findByTestId('mock-canvas')).toBeInTheDocument();
    expect(await screen.findByTestId('test-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('toolbar-com.test.good.tb')).toBeInTheDocument();
    expect(screen.getByTestId('open-plugin-manager')).toBeInTheDocument();
  });

  it('非法 Manifest 插件进入 failed 并在插件管理中显示原因', async () => {
    render(<LumoraStudio plugins={[goodPlugin, badPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    screen.getByTestId('open-plugin-manager').click();
    expect(await screen.findByTestId('plugin-reason-com.test.bad')).toHaveTextContent('Manifest 非法');
    expect(await screen.findByTestId('plugin-state-com.test.good')).toHaveTextContent('运行中');
    expect(screen.getByTestId('plugin-state-com.test.bad')).toHaveTextContent('失败');
  });

  it('禁用插件后其面板与工具栏贡献项全部移除，壳层仍可用', async () => {
    render(<LumoraStudio plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    screen.getByTestId('open-plugin-manager').click();
    (await screen.findByTestId('plugin-toggle-com.test.good')).click();
    await waitFor(() =>
      expect(screen.queryByTestId('panel-tab-com.test.good.panel')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('test-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-com.test.good.tb')).not.toBeInTheDocument();
    // 壳层依然可用
    expect(screen.getByTestId('open-sample-project')).toBeInTheDocument();
    expect(await screen.findByTestId('plugin-state-com.test.good')).toHaveTextContent('已禁用');
  });

  it('打开示例项目后 project:opened 事件可被宿主监听，关闭项目发出 project:closed', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const runtime = handle.current!.runtime;
    const opened = vi.fn();
    const closed = vi.fn();
    runtime.events.on('project:opened', opened);
    runtime.events.on('project:closed', closed);

    screen.getByTestId('open-sample-project').click();
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(opened.mock.calls[0]![0].project.objects.length).toBeGreaterThan(0);
    expect(runtime.getProject()?.uri).toBe('lumora://sample-project');
    expect(screen.queryByTestId('studio-empty-hint')).not.toBeInTheDocument();

    screen.getByTestId('close-project').click();
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('studio-empty-hint')).toBeInTheDocument();
  });

  it('卸载组件时释放运行时：插件停用、订阅清空（WebGL 资源随 Canvas 卸载）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const deactivate = vi.fn();
    const plugin: PluginDescriptor = {
      manifest: GOOD_MANIFEST,
      entry: async () => ({
        default: {
          activate: (context) => {
            context.events.on('project:opened', () => {});
            return context.contribute({});
          },
          deactivate,
        },
      }),
    };
    const { unmount } = render(<LumoraStudio ref={handle} plugins={[plugin]} hostVersion="0.1.0" />);
    await waitFor(() =>
      expect(handle.current!.runtime.host.getPlugin('com.test.good')?.state).toBe('active'),
    );
    const events = handle.current!.runtime.events;
    expect(events.handlerCount).toBeGreaterThan(0);

    unmount();
    await waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    expect(events.handlerCount).toBe(0);
  });

  it('卸载时释放失败（未解决恢复 fork）：如实上报 onError、运行时保留可恢复；解决后重试释放成功（第二十九轮严重 6）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const onError = vi.fn();
    const { unmount } = render(
      <LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" onError={onError} />,
    );
    await screen.findByTestId('test-panel');
    const runtime = handle.current!.runtime;
    const persistence = runtime.persistence;
    const store = (persistence as unknown as { store: ProjectStorage | null }).store!;
    const A = 'lumora://project/dispose-fail';
    const base = createSampleProject(A);
    runtime.openProject(base);
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));

    // 制造未解决恢复 fork：A rev1 排空失败 → 恢复区保留内容
    const realSave = store.save.bind(store);
    store.save = async (p, expected) => {
      if (p.uri === A && p.revision >= 1) {
        return { ok: false, code: 'storage-error', message: '模拟存储错误' };
      }
      return realSave(p, expected);
    };
    runtime.editor.addObject(createGroupObject());
    runtime.editor.openProject(createSampleProject('lumora://project/dispose-fail-b', 'B'));
    await waitFor(() => expect(persistence.getRecoverySnapshot(A)).not.toBeNull());
    store.save = realSave;

    // 卸载：关闭屏障如实上报失败 —— 修复前 fire-and-forget 丢弃 dispose 结果，
    // 未落盘内容随 teardown 沉没
    unmount();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toContain('恢复快照');
    // 运行时保留未 teardown：插件与订阅仍在，恢复快照仍可取（宿主可等待
    // runtime.dispose() 屏障，解决后重试）
    expect(runtime.host.getPlugin('com.test.good')?.state).toBe('active');
    expect(runtime.editor.events.handlerCount).toBeGreaterThan(0); // 编辑器订阅未解除
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();

    // 宿主解决（显式放弃恢复快照）后重试 dispose：成功释放全部资源
    persistence.clearRecovery(A);
    const outcome = await runtime.dispose();
    expect(outcome.ok).toBe(true);
    expect(runtime.host.listPlugins()).toHaveLength(0);
    expect(runtime.events.handlerCount).toBe(0);
  });

  it('StrictMode 下 effect 卸载重放不破坏运行时：插件只启动一次，命令可用，真实卸载仍释放', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const onError = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" onError={onError} />
      </StrictMode>,
    );
    // 启动只执行一次：插件达到 active、命令注册一次、无宿主错误上报
    expect(await screen.findByTestId('test-panel')).toBeInTheDocument();
    const runtime = handle.current!.runtime;
    expect(runtime.host.getPlugin('com.test.good')?.state).toBe('active');
    expect(runtime.host.commands.count()).toBe(1);
    expect(onError).not.toHaveBeenCalled();

    // 事件与命令在重放后的运行时可正常使用
    const executed = vi.fn();
    runtime.events.on('command:executed', executed);
    await runtime.host.commands.execute('com.test.good.cmd');
    expect(executed).toHaveBeenCalledTimes(1);

    // 真实卸载仍释放运行时
    unmount();
    await waitFor(() => expect(runtime.events.handlerCount).toBe(0));
    expect(runtime.host.listPlugins()).toHaveLength(0);
  });

  it('面板渲染抛错时显示错误边界并可通过其禁用插件', async () => {
    function ExplodingPanel(): never {
      throw new Error('面板渲染崩溃');
    }
    const plugin: PluginDescriptor = {
      manifest: GOOD_MANIFEST,
      entry: async () => ({
        default: {
          activate: (context) =>
            context.contribute({
              panels: [
                { kind: 'panel', id: 'com.test.good.panel', title: '爆炸面板', component: ExplodingPanel },
              ],
            }),
        },
      }),
    };
    render(<LumoraStudio plugins={[plugin]} hostVersion="0.1.0" />);
    expect(await screen.findByTestId('panel-error-fallback')).toBeInTheDocument();
    // 壳层仍可用，且可经错误边界禁用插件
    expect(screen.getByTestId('open-sample-project')).toBeInTheDocument();
    screen.getByTestId('disable-plugin-from-panel').click();
    await waitFor(() =>
      expect(screen.queryByTestId('panel-error-fallback')).not.toBeInTheDocument(),
    );
  });

  it('StrictMode 慢 boot 在最终卸载后不再继续注册插件、不写入初始项目、不上报错误', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const onError = vi.fn();
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    // loader 自身可观察的完成点：慢入口放行后真正执行到返回的位置
    let loaderResolved = false;
    const slowPlugin: PluginDescriptor = {
      manifest: { ...GOOD_MANIFEST, id: 'com.test.slow', name: '慢插件' },
      entry: async () => {
        await gate;
        loaderResolved = true;
        return { default: { activate: (context) => context.contribute({}) } };
      },
    };
    const { unmount } = render(
      <StrictMode>
        <LumoraStudio
          ref={handle}
          plugins={[slowPlugin, goodPlugin]}
          hostVersion="0.1.0"
          initialProject={createSampleProject('lumora://slow', '慢项目')}
          onError={onError}
        />
      </StrictMode>,
    );
    const runtime = handle.current!.runtime;
    // 慢插件加载挂起：后续插件与初始项目都尚未处理
    await vi.waitFor(() => expect(runtime.host.getPlugin('com.test.slow')?.state).toBe('loading'));
    expect(runtime.host.getPlugin('com.test.good')).toBeUndefined();
    expect(runtime.getProject()).toBeNull();

    // 最终卸载：取消标记生效，延迟确认的 dispose 已执行
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 放行慢入口：晚到的加载/激活不得复活插件、不得继续注册后续插件、
    // 不得写入初始项目、不得上报宿主错误
    releaseLoad();
    // 等待 loader 真正执行完成（晚到结果已送达宿主的可观察完成点），
    // 再冲刷宏任务让 boot continuation 跑完——避免“条件本就为真”的假阳性
    await vi.waitFor(() => expect(loaderResolved).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.host.getPlugin('com.test.slow')).toBeUndefined();
    expect(runtime.host.getPlugin('com.test.good')).toBeUndefined();
    expect(runtime.host.listPlugins()).toHaveLength(0);
    expect(runtime.getProject()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('命令面板：单个 when() 抛错被隔离并上报，异常命令不可用，正常命令与壳层照常工作', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const onError = vi.fn();
    const plugin: PluginDescriptor = {
      manifest: GOOD_MANIFEST,
      entry: async () => ({
        default: {
          activate: (context) =>
            context.contribute({
              commands: [
                {
                  kind: 'command',
                  command: {
                    id: 'com.test.good.throwing',
                    title: '坏条件',
                    when: () => {
                      throw new Error('when 爆炸');
                    },
                    execute: () => ({ ok: true }),
                  },
                },
                { kind: 'command', command: { id: 'com.test.good.ok', title: '正常命令', execute: () => ({ ok: true }) } },
              ],
            }),
        },
      }),
    };
    render(<LumoraStudio ref={handle} plugins={[plugin]} hostVersion="0.1.0" onError={onError} />);
    await waitFor(() => expect(handle.current!.runtime.host.commands.count()).toBe(2));

    render(<CommandPalette runtime={handle.current!.runtime} onClose={vi.fn()} />);
    // when 抛错：上报宿主错误，命令不可用、不进入面板
    expect(await screen.findByTestId('palette-command-com.test.good.ok')).toBeInTheDocument();
    expect(screen.queryByTestId('palette-command-com.test.good.throwing')).not.toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    // Studio 壳层继续工作
    expect(screen.getByTestId('open-sample-project')).toBeInTheDocument();
    expect(screen.getByTestId('open-plugin-manager')).toBeInTheDocument();
    expect(screen.getByTestId('mock-canvas')).toBeInTheDocument();
  });

  it('插件管理：多个缺 id 非法插件以唯一 instanceId 展示与操作，互不干扰', async () => {
    const anonManifest = null as unknown as Manifest;
    render(
      <LumoraStudio
        plugins={[{ manifest: anonManifest }, { manifest: anonManifest }]}
        hostVersion="0.1.0"
      />,
    );
    await screen.findByTestId('lumora-studio');
    screen.getByTestId('open-plugin-manager').click();
    // 两条记录各自成行：唯一 instanceId 作为 key/testid，展示 id 保持 '<unknown>'
    const firstRow = await screen.findByTestId('plugin-row-<unknown:1>');
    expect(screen.getByTestId('plugin-row-<unknown:2>')).toBeInTheDocument();
    expect(firstRow).toHaveTextContent('Manifest 非法');
    expect(firstRow).toHaveTextContent('<unknown>');
    // 经各自 instanceId 禁用：互不影响
    screen.getByTestId('plugin-toggle-<unknown:1>').click();
    await waitFor(() => expect(screen.getByTestId('plugin-state-<unknown:1>')).toHaveTextContent('已停用'));
    expect(screen.getByTestId('plugin-state-<unknown:2>')).toHaveTextContent('失败');
  });

  it('命令面板：when() 上下文注入命令所属插件 id，与 execute() 使用同一上下文', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const whenSpy = vi.fn((_context: { pluginId?: string }) => true);
    const plugin: PluginDescriptor = {
      manifest: GOOD_MANIFEST,
      entry: async () => ({
        default: {
          activate: (context) =>
            context.contribute({
              commands: [
                {
                  kind: 'command',
                  command: {
                    id: 'com.test.good.when',
                    title: '条件命令',
                    when: whenSpy,
                    execute: () => ({ ok: true }),
                  },
                },
                {
                  kind: 'command',
                  command: {
                    id: 'com.test.good.hidden',
                    title: '隐藏命令',
                    when: () => false,
                    execute: () => ({ ok: true }),
                  },
                },
              ],
            }),
        },
      }),
    };
    render(<LumoraStudio ref={handle} plugins={[plugin]} hostVersion="0.1.0" />);
    await waitFor(() => expect(handle.current!.runtime.host.commands.count()).toBe(2));

    render(<CommandPalette runtime={handle.current!.runtime} onClose={vi.fn()} />);
    expect(whenSpy).toHaveBeenCalledTimes(1);
    expect(whenSpy.mock.calls[0]![0].pluginId).toBe('com.test.good');
    expect(await screen.findByTestId('palette-command-com.test.good.when')).toBeInTheDocument();
    expect(screen.queryByTestId('palette-command-com.test.good.hidden')).not.toBeInTheDocument();
  });
});
