import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, createRef } from 'react';
import * as THREE from 'three';
import { createGroupObject, createSampleProject } from '@lumora/core';
import type { Manifest, PanelContextProps, PluginDescriptor } from '@lumora/core';
import { LumoraStudio } from '../src/components/LumoraStudio';
import type { LumoraStudioHandle } from '../src/components/LumoraStudio';
import type { ProjectStorage } from '../src/persistence/project-storage';
import { ContentCache } from '../src/components/editor/content-cache';
import { CommandPalette } from '../src/components/CommandPalette';
import * as previewExport from '../src/export/preview-export';

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
  it('opens and closes the export workspace without changing the current project', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const project = createSampleProject('lumora://export-integration', '导出集成');
    render(<LumoraStudio ref={handle} initialProject={project} />);
    const trigger = await screen.findByTestId('open-export-workspace');
    await waitFor(() => expect(handle.current?.runtime.getProject()?.uri).toBe(project.uri));

    trigger.click();
    expect(await screen.findByRole('heading', { name: '导出' })).toBeInTheDocument();
    expect(screen.getByTestId('lumora-studio')).toHaveAttribute('data-workspace', 'export');
    expect(handle.current?.runtime.getProject()?.uri).toBe(project.uri);

    screen.getByRole('button', { name: '关闭导出' }).click();
    await waitFor(() => expect(screen.queryByTestId('export-workspace')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(handle.current?.runtime.getProject()?.uri).toBe(project.uri);
  });

  it('preserves native Space and Enter activation on the closed export button', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const project = createSampleProject('lumora://export-native-key', 'Export native key');
    render(<LumoraStudio ref={handle} initialProject={project} />);
    const trigger = await screen.findByTestId('open-export-workspace');
    await waitFor(() => expect(handle.current?.runtime.getProject()?.uri).toBe(project.uri));
    const playBefore = screen.getByTestId('timeline-play').textContent;
    const hostKeydown = vi.fn();
    window.addEventListener('keydown', hostKeydown);

    try {
      trigger.focus();
      expect(fireEvent.keyDown(trigger, { key: ' ' })).toBe(true);
      expect(hostKeydown).not.toHaveBeenCalled();
      expect(screen.queryByTestId('export-workspace')).not.toBeInTheDocument();
      expect(screen.getByTestId('timeline-play')).toHaveTextContent(playBefore ?? '');
      expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(true);
      expect(hostKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', hostKeydown);
    }
  });

  it('clears the editor selection when Escape originates from a light-DOM button', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const project = createSampleProject('lumora://button-escape', 'Button Escape');
    render(<LumoraStudio ref={handle} initialProject={project} />);
    await waitFor(() => expect(handle.current?.runtime.getProject()?.uri).toBe(project.uri));
    const editor = handle.current!.runtime.editor;
    act(() => editor.setSelection(['sample-cube']));
    const clearSelection = vi.spyOn(editor, 'clearSelection');
    const play = screen.getByTestId('timeline-play');

    play.focus();
    fireEvent.keyDown(play, { key: 'Escape', code: 'Escape' });

    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(editor.getSelection()).toEqual([]);
  });

  it('isolates editor shortcuts while the export workspace is open and idle', async () => {
    let driveDefaultPrevented = false;
    const observeDriveKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyW') return;
      driveDefaultPrevented = event.defaultPrevented;
      window.removeEventListener('keydown', observeDriveKey);
    };
    window.addEventListener('keydown', observeDriveKey);
    const handle = createRef<LumoraStudioHandle>();
    const project = createSampleProject('lumora://export-keyboard', 'Export keyboard');
    render(<LumoraStudio ref={handle} initialProject={project} />);
    const trigger = await screen.findByTestId('open-export-workspace');
    await waitFor(() => expect(handle.current?.runtime.getProject()?.uri).toBe(project.uri));
    const editor = handle.current!.runtime.editor;
    act(() => editor.setSelection(['sample-camera']));
    const undo = vi.spyOn(editor, 'undo').mockReturnValue({ ok: true });
    const redo = vi.spyOn(editor, 'redo').mockReturnValue({ ok: true });
    const duplicate = vi.spyOn(editor, 'duplicateSelection').mockReturnValue({ ok: true });
    const remove = vi.spyOn(editor, 'deleteSelection').mockReturnValue({ ok: true });
    const playBefore = screen.getByTestId('timeline-play').textContent;

    fireEvent.click(trigger);
    const target = await screen.findByRole('button', { name: '关闭导出' });
    fireEvent.keyDown(target, { key: 'K', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(target, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(target, { key: 'z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(target, { key: 'y', ctrlKey: true });
    fireEvent.keyDown(target, { key: 'd', ctrlKey: true });
    fireEvent.keyDown(target, { key: 'Delete' });
    fireEvent.keyDown(target, { key: 'Backspace' });
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'w', code: 'KeyW' });
    fireEvent.keyDown(target, { key: 'Escape' });

    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(driveDefaultPrevented).toBe(false);
    expect(editor.getSelection()).toEqual(['sample-camera']);
    expect(screen.getByTestId('timeline-play')).toHaveTextContent(playBefore ?? '');
  });

  it('keeps the editor selection when Escape is pressed while export is running', async () => {
    let finishRecording: ((blob: Blob) => void) | undefined;
    const supportSpy = vi.spyOn(previewExport, 'detectWebmSupport').mockResolvedValue({
      supported: true,
      mimeType: 'video/webm;codecs=vp9',
    });
    const recordingSpy = vi.spyOn(previewExport, 'recordPreviewWebm').mockImplementation(
      () => new Promise<Blob>((resolve) => {
        finishRecording = resolve;
      }),
    );
    const handle = createRef<LumoraStudioHandle>();

    try {
      render(
        <LumoraStudio
          ref={handle}
          initialProject={createSampleProject('lumora://export-escape-running', 'Export Escape running')}
        />,
      );
      const trigger = await screen.findByTestId('open-export-workspace');
      await waitFor(() => expect(handle.current?.runtime.getProject()?.uri).toBe('lumora://export-escape-running'));
      const editor = handle.current!.runtime.editor;
      act(() => editor.setSelection(['sample-camera']));

      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('button', { name: '导出 WebM' }));
      const cancel = await screen.findByRole('button', { name: '取消导出' });
      fireEvent.keyDown(cancel, { key: 'Escape' });

      expect(editor.getSelection()).toEqual(['sample-camera']);
    } finally {
      await act(async () => {
        finishRecording?.(new Blob(['webm'], { type: 'video/webm' }));
      });
      supportSpy.mockRestore();
      recordingSpy.mockRestore();
    }
  });

  it('remounts export for a replacement session with the same project URI', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:replacement-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const handle = createRef<LumoraStudioHandle>();
    const uri = 'lumora://same-uri-export';
    render(<LumoraStudio ref={handle} initialProject={createSampleProject(uri, 'Original')} />);
    const trigger = await screen.findByTestId('open-export-workspace');
    await waitFor(() => expect(handle.current?.runtime.getProject()?.uri).toBe(uri));
    fireEvent.click(trigger);
    const oldWorkspace = await screen.findByTestId('export-workspace');

    act(() => handle.current!.runtime.editor.openProject(createSampleProject(uri, 'Replacement')));

    await waitFor(() => expect(screen.getByTestId('export-workspace')).not.toBe(oldWorkspace));
    fireEvent.click(screen.getByRole('button', { name: '导出清单' }));
    expect(await screen.findByRole('status')).toHaveTextContent('分镜清单已导出');
  });

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

  it('卸载时释放失败（未解决恢复 fork）：如实上报 onCloseError、运行时保留可恢复、缓存不释放；解决后经 handle.close() 重试成功（第三十轮严重 6）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const onCloseError = vi.fn();
    const cacheDisposeSpy = vi.spyOn(ContentCache.prototype, 'dispose');
    const { unmount } = render(
      <LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" onCloseError={onCloseError} />,
    );
    await screen.findByTestId('test-panel');
    const { runtime, close } = handle.current!;
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
    // 未落盘内容随 teardown 沉没。失败时资源缓存不得释放（宿主重试期间壳层
    // 完整可用）
    unmount();
    await waitFor(() => expect(onCloseError).toHaveBeenCalledTimes(1));
    expect(onCloseError.mock.calls[0]![0]).toContain('恢复快照');
    expect(cacheDisposeSpy).not.toHaveBeenCalled();
    // 运行时保留未 teardown：插件与订阅仍在，恢复快照仍可取（宿主可等待
    // handle.close() 屏障，解决后重试）
    expect(runtime.host.getPlugin('com.test.good')?.state).toBe('active');
    expect(runtime.editor.events.handlerCount).toBeGreaterThan(0); // 编辑器订阅未解除
    expect(persistence.getRecoverySnapshot(A)).not.toBeNull();

    // 宿主解决（显式放弃恢复快照）后经同一 close() 屏障重试：成功释放全部
    // 资源与缓存，且缓存恰好释放一次（cleanup 的失败尝试不计数）
    persistence.clearRecovery(A);
    const outcome = await close();
    expect(outcome.ok).toBe(true);
    expect(runtime.host.listPlugins()).toHaveLength(0);
    expect(runtime.events.handlerCount).toBe(0);
    expect(cacheDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('宿主 onCloseError 回调抛错不产生未处理拒绝（第三十五轮一般 5：修复前回调异常外溢为 unhandledrejection）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    const onCloseError = vi.fn((_message: string) => {
      throw new Error('宿主回调崩溃');
    });
    const { unmount } = render(
      <LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" onCloseError={onCloseError} />,
    );
    await screen.findByTestId('test-panel');
    const { runtime } = handle.current!;
    // 关闭失败 → cleanup 的 close().then 回调调用宿主 onCloseError，回调抛错 ——
    // 修复前回调在 fulfilled/rejected 回调内直接执行，派生 promise 无 catch
    const disposeSpy = vi.spyOn(runtime, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: false, message: '模拟冲刷失败' });
    unmount();
    await waitFor(() => expect(onCloseError).toHaveBeenCalledTimes(1));
    expect(onCloseError.mock.calls[0]![0]).toBe('模拟冲刷失败');
    // 宿主回调异常被隔离：链尾无未处理拒绝
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toHaveLength(0);
    window.removeEventListener('unhandledrejection', onUnhandled);
    disposeSpy.mockRestore();
  });

  it('宿主 async onCloseError 回调 rejection 被吸收（第三十六轮一般 4：修复前 try/catch 只捕同步异常，宿主传 async 回调时返回 Promise 的 rejection 被丢弃、产生 unhandledrejection）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    // async 回调：invokeCloseError 需吸收返回 thenable 的 rejection
    const onCloseError = vi.fn(async (_message: string) => {
      throw new Error('宿主异步回调崩溃');
    });
    const { unmount } = render(
      <LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" onCloseError={onCloseError} />,
    );
    await screen.findByTestId('test-panel');
    const { runtime } = handle.current!;
    const disposeSpy = vi.spyOn(runtime, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: false, message: '模拟冲刷失败' });
    unmount();
    await waitFor(() => expect(onCloseError).toHaveBeenCalledTimes(1));
    expect(onCloseError.mock.calls[0]![0]).toBe('模拟冲刷失败');
    // 链尾无未处理拒绝（修复前 async rejection 外溢）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toHaveLength(0);
    window.removeEventListener('unhandledrejection', onUnhandled);
    disposeSpy.mockRestore();
  });

  it('严重 3：并发一败一成 —— close() 并发调用共享同一 in-flight 裁决（双击/连点不再重复 teardown），失败后清空缓存允许重试，成功释放缓存恰一次', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const cacheDisposeSpy = vi.spyOn(ContentCache.prototype, 'dispose');
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const { runtime, close } = handle.current!;
    const disposeSpy = vi.spyOn(runtime, 'dispose');
    const persistence = runtime.persistence;
    const store = (persistence as unknown as { store: ProjectStorage | null }).store!;
    const A = 'lumora://project/concurrent-close';
    runtime.openProject(createSampleProject(A));
    await waitFor(() => expect(screen.getByTestId('save-state-badge')).toHaveTextContent('已保存'));

    // 制造未解决恢复 fork → close() 返回 {ok:false}
    const realSave = store.save.bind(store);
    store.save = async (p, expected) => {
      if (p.uri === A && p.revision >= 1) {
        return { ok: false, code: 'storage-error', message: '模拟存储错误' };
      }
      return realSave(p, expected);
    };
    runtime.editor.addObject(createGroupObject());
    runtime.editor.openProject(createSampleProject('lumora://project/concurrent-b', 'B'));
    await waitFor(() => expect(persistence.getRecoverySnapshot(A)).not.toBeNull());
    store.save = realSave;

    // 双击/连点：第二次调用共享同一裁决（修复前各自独立执行 runtime.dispose，
    // 重复冲刷/重复 teardown）；runtime.dispose 只执行一次
    const first = close();
    const second = close();
    expect(second).toBe(first);
    const outcome = await first;
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('恢复快照');
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // 失败：运行时未 teardown、缓存未释放（宿主可解决后重试）
    expect(runtime.host.getPlugin('com.test.good')?.state).toBe('active');
    expect(cacheDisposeSpy).not.toHaveBeenCalled();

    // 解决后重试（失败已清空缓存，新调用真正执行）：成功
    persistence.clearRecovery(A);
    const retried = await close();
    expect(retried.ok).toBe(true);
    expect(disposeSpy).toHaveBeenCalledTimes(2);
    expect(cacheDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('严重 3：close() 成功后永久复用同一成功裁决（幂等），runtime.dispose 恰执行一次', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const { runtime, close } = handle.current!;
    const disposeSpy = vi.spyOn(runtime, 'dispose');

    const first = close();
    const second = close();
    expect(second).toBe(first); // 并发共享同一 in-flight
    expect(await first).toEqual({ ok: true });

    // 成功后永久复用成功结果：后续调用不再执行 runtime.dispose
    expect(await close()).toEqual({ ok: true });
    expect(await close()).toEqual({ ok: true });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('严重 3：runtime.dispose 意外拒绝归一为类型化失败（无 unhandled rejection），失败可重试', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const { runtime, close } = handle.current!;
    const disposeSpy = vi.spyOn(runtime, 'dispose');
    disposeSpy.mockRejectedValueOnce(new Error('模拟运行时崩溃'));

    const outcome = await close();
    expect(outcome).toEqual({ ok: false, message: '模拟运行时崩溃' });
    // 失败：缓存清空、可重试 —— 重试走真实 dispose 成功
    expect(await close()).toEqual({ ok: true });
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it('阻断 2/3：close() 成功收敛，cache.dispose 作为终态最后一步恰好释放一次（内部故障注入走真实路径，见 content-cache.test.ts —— 修复前 mock 整个 dispose 抛错恰好避开内部路径，假报失败实为假成功）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const cacheDisposeSpy = vi.spyOn(ContentCache.prototype, 'dispose');
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const { runtime, close } = handle.current!;
    const runtimeDisposeSpy = vi.spyOn(runtime, 'dispose');

    const outcome = await close();
    expect(outcome).toEqual({ ok: true });
    // 终态收敛：runtime 终态释放 + 缓存恰好释放一次（cache.dispose 契约为
    // best-effort 不抛错，内部逐资源清理；close() 不再因缓存故障返回
    // {ok:false} —— 修复前 cache 抛错返回 {ok:false} 但 runtime 已销毁，
    // 宿主保持挂载面对死壳、重试时跳过缓存释放假报成功）
    expect(cacheDisposeSpy).toHaveBeenCalledTimes(1);
    expect(runtimeDisposeSpy).toHaveBeenCalledTimes(1);
    // 成功后幂等：重复 close 复用成功裁决，不再触碰 runtime 与缓存
    expect(await close()).toEqual({ ok: true });
    expect(cacheDisposeSpy).toHaveBeenCalledTimes(1);
    expect(runtimeDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('严重 5（第三十四轮）：cache.dispose 顶层异常并入 close() 结果 —— ok 仍 true 且 message 含明细（修复前无条件裸 {ok:true} 吞掉诊断）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    const cacheDisposeSpy = vi.spyOn(ContentCache.prototype, 'dispose');
    cacheDisposeSpy.mockImplementationOnce(() => {
      throw new Error('模拟缓存释放崩溃');
    });
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const { close } = handle.current!;

    const outcome = await close();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('缓存资源释放失败');
    expect(outcome.message).toContain('模拟缓存释放崩溃');
    expect(cacheDisposeSpy).toHaveBeenCalledTimes(1);
    // 成功后幂等：重复 close 复用同一裁决（失败明细归档保留）
    expect(await close()).toEqual(outcome);
    expect(cacheDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('严重 5（第三十四轮）：runtime 终态 message 经 close() 透传 —— store/host 层失败明细不丢失', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    const { runtime, close } = handle.current!;
    const disposeSpy = vi.spyOn(runtime, 'dispose');
    disposeSpy.mockResolvedValueOnce({ ok: true, message: '终态释放部分失败：host 停用失败' });

    const outcome = await close();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('host 停用失败');
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // 成功后幂等：重复 close 不再触碰 runtime
    expect(await close()).toEqual(outcome);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
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

/** 打开示例项目并选中 sample-camera（使录制可用） */
async function openSampleWithCamera(handle: React.RefObject<LumoraStudioHandle | null>) {
  screen.getByTestId('open-sample-project').click();
  await waitFor(() => expect(handle.current!.runtime.editor.getProject()).not.toBeNull());
  act(() => handle.current!.runtime.editor.setSelection(['sample-camera']));
}

describe('LumoraStudio：覆盖确认模态（复审阻断 4：全应用级模态）', () => {
  it('覆盖确认出现在壳层根级：整壳 inert、其余应用不可达；确认/取消行为正确', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    await openSampleWithCamera(handle);
    // 示例项目 sample-camera 已有录制轨道 → 点击录制进入覆盖确认
    // （fireEvent 包裹 act：native click 不 flush React 提交，模态不会出现）
    fireEvent.click(screen.getByTestId('timeline-record'));
    expect(screen.getByTestId('overwrite-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('overwrite-confirm')).toHaveAttribute('role', 'dialog');
    expect(screen.getByTestId('overwrite-confirm')).toHaveClass('lumora-studio', 'lumora-studio--portal');
    // 整壳 inert：工具栏/对象树/视口/时间线整体不可达（修复前仅时间线内容 inert）
    expect(screen.getByTestId('lumora-studio')).toHaveAttribute('inert');
    // 打开后焦点进入首个可聚焦项
    expect(screen.getByText('覆盖录制')).toHaveFocus();

    // 取消：模态关闭、不开始录制
    fireEvent.click(screen.getByText('取消'));
    expect(screen.queryByTestId('overwrite-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('lumora-studio')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('timeline-record').textContent).toBe('●');

    // 再次进入并确认：录制开始
    fireEvent.click(screen.getByTestId('timeline-record'));
    expect(screen.getByTestId('overwrite-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByText('覆盖录制'));
    expect(screen.queryByTestId('overwrite-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('timeline-record').textContent).toBe('■');
  });

  it('焦点逃逸到对话框外后 Escape 仍取消模态；关闭后焦点还原到触发按钮（复审阻断 4）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    await openSampleWithCamera(handle);
    const record = screen.getByTestId('timeline-record');
    record.focus(); // jsdom 对 disabled 元素调用 focus() 是空操作；此处已启用
    fireEvent.click(record);
    expect(screen.getByText('覆盖录制')).toHaveFocus();
    // 焦点逃逸（程序性 blur / 点击其它区域）后：Escape 必须先于「模态外」分支
    // 判定 —— 修复前 Escape 被 outside 分支吞掉，模态永不关闭
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('overwrite-confirm')).not.toBeInTheDocument();
    expect(record).toHaveFocus();
  });

  it('Ctrl+Shift+K 不泄漏到命令面板；Delete 不穿透全局处理器（应用快捷键统一小写匹配）', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    await openSampleWithCamera(handle);
    fireEvent.click(screen.getByTestId('timeline-record'));
    const confirm = screen.getByText('覆盖录制');
    // Shift 按下时 event.key 为大写 K —— 修复前小写匹配漏判，Ctrl+Shift+K 打开
    // 命令面板（泄漏）
    fireEvent.keyDown(confirm, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    // Delete 被模态 capture 拦截：全局删除处理器不执行，选择不被清空
    fireEvent.keyDown(confirm, { key: 'Delete' });
    expect(handle.current!.runtime.editor.getSelection()).toEqual(['sample-camera']);
    expect(screen.getByTestId('overwrite-confirm')).toBeInTheDocument();
  });

  it('Tab/Shift+Tab 焦点圈闭环，焦点逃逸到对话框外也拉回', async () => {
    const handle = createRef<LumoraStudioHandle>();
    render(<LumoraStudio ref={handle} plugins={[goodPlugin]} hostVersion="0.1.0" />);
    await screen.findByTestId('test-panel');
    await openSampleWithCamera(handle);
    fireEvent.click(screen.getByTestId('timeline-record'));
    const confirm = screen.getByText('覆盖录制');
    const cancel = screen.getByText('取消');
    expect(confirm).toHaveFocus();
    // 首个可聚焦项上 Shift+Tab：回环到末项
    fireEvent.keyDown(confirm, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    // 末项上 Tab：回环到首项
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(confirm).toHaveFocus();
    // 焦点已在对话框外（模拟浏览器默认移动）→ Tab 拉回首项
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(confirm).toHaveFocus();
  });
});
