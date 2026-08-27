import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSampleProject } from '@lumora/core';
import type { PluginDescriptor, Project } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import { ExportWorkspace } from '../src/components/export/ExportWorkspace';
import type { TimelineSession } from '../src/hooks/use-timeline-session';
import type {
  PreviewEncodedFrame,
  PreviewEncoderSession,
  PreviewRecordingDependencies,
  WebmSupport,
} from '../src/export/preview-export';

interface ConfigSupportProbe {
  hasVideoEncoder: boolean;
  hasVideoFrame: boolean;
  isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean }>;
}

const AsyncExportWorkspace = ExportWorkspace as unknown as (
  props: Parameters<typeof ExportWorkspace>[0] & { supportProbe: ConfigSupportProbe },
) => ReturnType<typeof ExportWorkspace>;

function projectWithShortShots(): Project {
  const project = createSampleProject('lumora://export-ui', '导出界面');
  return {
    ...project,
    shots: project.shots.map((shot, index) => ({
      ...shot,
      startTime: index * 0.04,
      endTime: index * 0.04 + 0.04,
    })),
  };
}

function sessionHarness(options: { recording?: boolean } = {}) {
  const pause = vi.fn();
  const seek = vi.fn();
  const getTime = vi.fn(() => 0.5);
  return {
    session: {
      pause,
      seek,
      timeline: { getTime },
      state: { recording: options.recording ?? false },
    } as unknown as TimelineSession,
    pause,
    seek,
  };
}

function encoderDependencies(options: { flush?: () => Promise<Blob> } = {}) {
  const encodedFrames: PreviewEncodedFrame[] = [];
  const canvas = {
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
  const encoder = {
    encodeQueueSize: 0,
    encodeFrame: vi.fn((_canvas, frame) => encodedFrames.push({ ...frame })),
    waitForQueueSize: vi.fn(async () => undefined),
    flush: vi.fn(options.flush ?? (async () => new Blob(['webm'], { type: 'video/webm;codecs=vp8' }))),
    close: vi.fn(),
  } as Omit<PreviewEncoderSession, 'encodeFrame' | 'waitForQueueSize' | 'flush' | 'close'> & {
    encodeFrame: ReturnType<typeof vi.fn>;
    waitForQueueSize: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  const configure = vi.fn();
  const createEncoder = vi.fn(() => {
    configure();
    return encoder;
  });
  const dependencies: PreviewRecordingDependencies = {
    createCanvas: () => canvas,
    createEncoder,
  };
  return { dependencies, encoder, encodedFrames, createEncoder, configure };
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const SUPPORTED: WebmSupport = { supported: true, mimeType: 'video/webm;codecs=vp8' };

const SEEK_SESSION_REENTRIES: Array<[
  string,
  (runtime: ReturnType<typeof createStudioRuntime>, project: Project) => void,
]> = [
  ['resets the editor', (runtime) => runtime.editor.reset()],
  ['opens a different URI', (runtime) => {
    runtime.editor.openProject(createSampleProject('lumora://seek-different', 'Different project'));
  }],
  ['reopens the same URI', (runtime, project) => {
    runtime.editor.openProject(createSampleProject(project.uri, 'Reopened project'));
  }],
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function registerDeferredExporter(
  runtime: ReturnType<typeof createStudioRuntime>,
  result: Promise<{ fileName: string; mime: string; data: string }>,
) {
  const exportCall = vi.fn(() => result);
  const plugin: PluginDescriptor = {
    manifest: {
      schemaVersion: '1',
      id: 'com.example.slowexport',
      name: '慢导出插件',
      version: '0.1.0',
      entry: './dist/index.js',
    },
    entry: async () => ({
      default: {
        activate: (context) =>
          context.contribute({
            exporters: [{
              kind: 'exporter',
              id: 'com.example.slowexport.json',
              name: '慢导出器',
              formats: ['json'],
              export: exportCall,
            }],
          }),
      },
    }),
  };
  await runtime.host.register(plugin);
  return { exportCall, pluginId: plugin.manifest.id };
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:export-download'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

describe('ExportWorkspace', () => {
  it('keeps frame exports disabled until the offscreen capture bridge is ready', () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const props = {
      runtime,
      project,
      session,
      captureRef: { current: vi.fn(() => 'data:image/png;base64,shot') },
      exportFrameRef: { current: vi.fn(() => true) },
      support: SUPPORTED,
      onClose: vi.fn(),
    };

    const { rerender } = render(<ExportWorkspace {...props} captureReady={false} />);
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /导出 .* PNG/ })[0]).toBeDisabled();

    rerender(<ExportWorkspace {...props} captureReady />);
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: /导出 .* PNG/ })[0]).toBeEnabled();
  });

  it('defaults to all shots at 720p/24fps and exposes per-shot PNG export', () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: vi.fn(() => 'data:image/png;base64,shot') }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '导出' })).toBeInTheDocument();
    expect(screen.getByLabelText('导出范围')).toHaveValue('all');
    expect(screen.getByLabelText('分辨率')).toHaveValue('720p');
    expect(screen.getByLabelText('帧率')).toHaveValue('24');
    expect(screen.getAllByRole('button', { name: /导出 .* PNG/ })).toHaveLength(3);
    expect(screen.getByTestId('export-summary')).toHaveTextContent('3 个分镜');
    expect(screen.getByTestId('export-summary')).toHaveTextContent('4.50 秒');
  });

  it('disables PNG and WebM frame export while timeline recording is active', () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness({ recording: true });

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: vi.fn(() => 'data:image/png;base64,shot') }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /导出 .* PNG/ })[0]).toBeDisabled();
  });

  it('reports exact-size PNG capture failure instead of downloading a thumbnail fallback', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const thumbnailCapture = vi.fn(() => 'data:image/png;base64,thumbnail');

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: thumbnailCapture }}
        exportFrameRef={{ current: vi.fn(() => false) }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /导出 .* PNG/ })[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent('PNG 导出失败');
    expect(thumbnailCapture).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('rejects PNG capture when the shot camera is outside the active scene', () => {
    const runtime = createStudioRuntime();
    const base = createSampleProject();
    const project: Project = {
      ...base,
      scenes: [
        { ...base.scenes[0]!, rootObjectIds: base.scenes[0]!.rootObjectIds.filter((id) => id !== 'sample-camera') },
        { id: 'inactive', name: 'Inactive', rootObjectIds: ['sample-camera'], activeCameraId: 'sample-camera' },
      ],
    };
    const { session } = sessionHarness();
    const exportFrame = vi.fn(() => true);

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: exportFrame }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /导出 分镜 1.*PNG/i }));

    expect(screen.getByRole('alert')).toHaveTextContent('有效机位');
    expect(exportFrame).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('shows unsupported codec state before encoding and creates no recorder', () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const recorder = encoderDependencies();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        support={{ supported: false, reason: '当前浏览器不支持 VP8/VP9 WebM 编码' }}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('不支持 VP8/VP9');
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();
  });

  it('keeps WebM disabled with a status while the selected VP8 config is checking', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const check = deferred<{ supported: boolean }>();
    const supportProbe: ConfigSupportProbe = {
      hasVideoEncoder: true,
      hasVideoFrame: true,
      isConfigSupported: vi.fn(() => check.promise),
    };

    render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={supportProbe}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('正在检查 VP8');
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    check.resolve({ supported: true });
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled());
  });

  it.each([
    ['unsupported', async () => ({ supported: false }), '不支持当前分辨率'],
    ['failed', async () => { throw new Error('capability unavailable'); }, 'capability unavailable'],
  ])('shows an actionable reason when VP8 preflight is %s', async (_label, check, reason) => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();

    render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{
          hasVideoEncoder: true,
          hasVideoFrame: true,
          isConfigSupported: vi.fn(check),
        }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(reason));
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  });

  it('ignores an out-of-order VP8 result after resolution changes', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const firstCheck = deferred<{ supported: boolean }>();
    const secondCheck = deferred<{ supported: boolean }>();
    const isConfigSupported = vi.fn()
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);

    render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '480p' } });
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(2));

    secondCheck.resolve({ supported: true });
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled());
    firstCheck.resolve({ supported: false });
    await act(async () => firstCheck.promise);

    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(isConfigSupported).toHaveBeenNthCalledWith(2, expect.objectContaining({
      width: 854,
      height: 480,
    }));
  });

  it('keeps the current unsupported config disabled when an old config later reports support', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const recorder = encoderDependencies();
    const firstCheck = deferred<{ supported: boolean }>();
    const secondCheck = deferred<{ supported: boolean }>();
    const isConfigSupported = vi.fn()
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);

    render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '480p' } });
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(2));

    secondCheck.resolve({ supported: false });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不支持当前分辨率'));
    firstCheck.resolve({ supported: true });
    await act(async () => firstCheck.promise);

    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('不支持当前分辨率');
    expect(isConfigSupported).toHaveBeenNthCalledWith(2, expect.objectContaining({
      width: 854,
      height: 480,
    }));
    expect(recorder.createEncoder).not.toHaveBeenCalled();
    expect(recorder.configure).not.toHaveBeenCalled();
    expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('disables WebM synchronously when a supported selection changes', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    const { session } = sessionHarness();
    const firstCheck = deferred<{ supported: boolean }>();
    const secondCheck = deferred<{ supported: boolean }>();
    let disabledWhenSecondProbeStarted: boolean | undefined;
    let checkingWhenSecondProbeStarted: boolean | undefined;
    const isConfigSupported = vi.fn()
      .mockReturnValueOnce(firstCheck.promise)
      .mockImplementationOnce(() => {
        disabledWhenSecondProbeStarted = screen.getByRole('button', { name: '导出 WebM' })
          .hasAttribute('disabled');
        checkingWhenSecondProbeStarted = screen.queryByRole('status') !== null;
        return secondCheck.promise;
      });

    render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(1));
    firstCheck.resolve({ supported: true });
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled());

    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '480p' } });
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(2));

    expect(disabledWhenSecondProbeStarted).toBe(true);
    expect(checkingWhenSecondProbeStarted).toBe(true);
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('正在检查 VP8');
  });

  it('ignores an old session preflight result after the same project URI is reopened', async () => {
    const runtime = createStudioRuntime();
    await runtime.openProject(createSampleProject('lumora://vp8-session', 'Initial'));
    const initial = runtime.getProject()!;
    const firstToken = runtime.editor.getSessionToken();
    const { session } = sessionHarness();
    const firstCheck = deferred<{ supported: boolean }>();
    const secondCheck = deferred<{ supported: boolean }>();
    const isConfigSupported = vi.fn()
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);

    const view = render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={initial}
        projectSessionToken={firstToken}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(1));

    act(() => runtime.editor.openProject(createSampleProject(initial.uri, 'Replacement')));
    const replacement = runtime.getProject()!;
    view.rerender(
      <AsyncExportWorkspace
        runtime={runtime}
        project={replacement}
        projectSessionToken={runtime.editor.getSessionToken()}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(2));
    secondCheck.resolve({ supported: true });
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled());
    firstCheck.resolve({ supported: false });
    await act(async () => firstCheck.promise);

    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a replacement session unsupported when the old session later reports support', async () => {
    const runtime = createStudioRuntime();
    await runtime.openProject(createSampleProject('lumora://vp8-session', 'Initial'));
    const initial = runtime.getProject()!;
    const firstToken = runtime.editor.getSessionToken();
    const { session } = sessionHarness();
    const recorder = encoderDependencies();
    const firstCheck = deferred<{ supported: boolean }>();
    const secondCheck = deferred<{ supported: boolean }>();
    const isConfigSupported = vi.fn()
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);

    const view = render(
      <AsyncExportWorkspace
        runtime={runtime}
        project={initial}
        projectSessionToken={firstToken}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(1));

    act(() => runtime.editor.openProject(createSampleProject(initial.uri, 'Replacement')));
    const replacement = runtime.getProject()!;
    view.rerender(
      <AsyncExportWorkspace
        runtime={runtime}
        project={replacement}
        projectSessionToken={runtime.editor.getSessionToken()}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        supportProbe={{ hasVideoEncoder: true, hasVideoFrame: true, isConfigSupported }}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(isConfigSupported).toHaveBeenCalledTimes(2));
    secondCheck.resolve({ supported: false });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不支持当前分辨率'));
    firstCheck.resolve({ supported: true });
    await act(async () => firstCheck.promise);

    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('不支持当前分辨率');
    expect(recorder.createEncoder).not.toHaveBeenCalled();
    expect(recorder.configure).not.toHaveBeenCalled();
    expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('downloads a privacy-safe manifest for the selected range', async () => {
    const runtime = createStudioRuntime();
    const project: Project = {
      ...createSampleProject(),
      pluginData: { private: { apiKey: 'secret-value' } },
    };
    const { session } = sessionHarness();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('导出范围'), { target: { value: 'sample-shot-2' } });
    fireEvent.click(screen.getByRole('button', { name: '导出清单' }));

    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    const manifest = JSON.parse(await readBlob(blob));
    expect(manifest.shots).toHaveLength(1);
    expect(manifest.shots[0].id).toBe('sample-shot-2');
    expect(JSON.stringify(manifest)).not.toContain('secret-value');
  });

  it('exports WebM with progress, restores the playhead, and remains closable', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    const { session, pause, seek } = sessionHarness();
    const recorder = encoderDependencies();
    const renderFrame = vi.fn(() => true);
    const onClose = vi.fn();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: renderFrame }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('导出完成'));
    expect(renderFrame).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalled();
    expect(seek).toHaveBeenLastCalledWith(0.5, false);
    expect(recorder.encoder.close).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

    fireEvent.click(screen.getByRole('button', { name: '关闭导出' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('serializes a pending plugin exporter with every core export operation', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    await runtime.openProject(project);
    const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
    const plugin = await registerDeferredExporter(runtime, pluginResult.promise);
    const { session } = sessionHarness();
    const recorder = encoderDependencies();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={runtime.getProject()!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    const pluginButton = screen.getByRole('button', { name: '运行 慢导出器' });
    fireEvent.click(pluginButton);

    expect(plugin.exportCall).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出清单' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /导出 .* PNG/ })[0]).toBeDisabled();
    fireEvent.click(pluginButton);
    expect(plugin.exportCall).toHaveBeenCalledTimes(1);
    expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();

    pluginResult.resolve({ fileName: 'slow.json', mime: 'application/json', data: '{}' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('慢导出器导出完成'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('suppresses a pending plugin result after the workspace closes and unmounts', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    await runtime.openProject(project);
    const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
    await registerDeferredExporter(runtime, pluginResult.promise);
    const { session } = sessionHarness();
    const onClose = vi.fn();
    const view = render(
      <ExportWorkspace
        runtime={runtime}
        project={runtime.getProject()!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        support={SUPPORTED}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '运行 慢导出器' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭导出' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();

    await act(async () => {
      pluginResult.resolve({ fileName: 'stale.json', mime: 'application/json', data: '{}' });
      await pluginResult.promise;
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ['WebM is unsupported', {
      captureReady: true,
      support: { supported: false, reason: 'WebCodecs unavailable' } as WebmSupport,
    }],
    ['the capture bridge is unavailable', {
      captureReady: false,
      support: SUPPORTED,
    }],
  ])('invalidates a pending plugin result and focuses the manifest when %s', async (_label, capability) => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    await runtime.openProject(project);
    const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
    const plugin = await registerDeferredExporter(runtime, pluginResult.promise);
    const { session } = sessionHarness();
    render(
      <ExportWorkspace
        runtime={runtime}
        project={runtime.getProject()!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        captureReady={capability.captureReady}
        support={capability.support}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '运行 慢导出器' }));
    await act(async () => {
      await runtime.host.disable(plugin.pluginId);
    });
    await act(async () => {
      pluginResult.resolve({ fileName: 'removed.json', mime: 'application/json', data: '{}' });
      await pluginResult.promise;
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '运行 慢导出器' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '导出清单' })).toHaveFocus());
  });

  it('focuses close when a removed plugin leaves no enabled export operation', async () => {
    const runtime = createStudioRuntime();
    const project = { ...createSampleProject(), shots: [] };
    await runtime.openProject(project);
    const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
    const plugin = await registerDeferredExporter(runtime, pluginResult.promise);
    const { session } = sessionHarness();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={runtime.getProject()!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        captureReady={false}
        support={{ supported: false, reason: 'WebCodecs unavailable' }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '运行 慢导出器' }));
    await act(async () => {
      await runtime.host.disable(plugin.pluginId);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: '关闭导出' })).toHaveFocus());
    expect(screen.getByRole('button', { name: '导出清单' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出 WebM' })).toBeDisabled();
  });

  it('cancels stale focus restoration when a newer export starts', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createStudioRuntime();
      const project = createSampleProject();
      await runtime.openProject(project);
      const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
      const plugin = await registerDeferredExporter(runtime, pluginResult.promise);
      const { session } = sessionHarness();
      render(
        <ExportWorkspace
          runtime={runtime}
          project={runtime.getProject()!}
          session={session}
          captureRef={{ current: null }}
          exportFrameRef={{ current: vi.fn(() => true) }}
          captureReady
          support={SUPPORTED}
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '运行 慢导出器' }));
      await act(async () => {
        await runtime.host.disable(plugin.pluginId);
      });

      const manifestButton = screen.getByRole('button', { name: '导出清单' });
      await act(async () => {
        manifestButton.focus();
        fireEvent.click(manifestButton);
      });
      act(() => vi.runOnlyPendingTimers());

      expect(manifestButton).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a removed plugin result stale after the same exporter id is registered again', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    await runtime.openProject(project);
    const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
    const plugin = await registerDeferredExporter(runtime, pluginResult.promise);
    const { session } = sessionHarness();
    render(
      <ExportWorkspace
        runtime={runtime}
        project={runtime.getProject()!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '运行 慢导出器' }));

    await act(async () => {
      await runtime.host.disable(plugin.pluginId);
      await runtime.host.enable(plugin.pluginId);
    });
    expect(screen.getByRole('button', { name: '运行 慢导出器' })).toBeEnabled();

    await act(async () => {
      pluginResult.resolve({ fileName: 'stale-generation.json', mime: 'application/json', data: '{}' });
      await pluginResult.promise;
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('插件导出器已变更，导出已取消');
  });

  it('does not seek after pause synchronously replaces the project session', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject('lumora://pause-reentry', 'Pause reentry');
    await runtime.openProject(project);
    const { session, pause, seek } = sessionHarness();
    pause.mockImplementation(() => {
      runtime.editor.openProject(createSampleProject(project.uri, 'Replacement'));
    });

    render(
      <ExportWorkspace
        runtime={runtime}
        project={runtime.getProject()!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /导出 分镜 1.*PNG/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('项目会话已变更'));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(seek).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it.each(SEEK_SESSION_REENTRIES)(
    'cancels PNG before capture when seek synchronously %s',
    async (_label, replaceSession) => {
      const runtime = createStudioRuntime();
      const initial = createSampleProject('lumora://png-seek-reentry', 'PNG seek reentry');
      await runtime.openProject(initial);
      const project = runtime.getProject()!;
      const { session, seek } = sessionHarness();
      const exportFrame = vi.fn(() => true);
      seek.mockImplementationOnce(() => replaceSession(runtime, project));

      render(
        <ExportWorkspace
          runtime={runtime}
          project={project}
          session={session}
          captureRef={{ current: null }}
          exportFrameRef={{ current: exportFrame }}
          support={SUPPORTED}
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /导出 分镜 1.*PNG/ }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('项目会话已变更'));
      expect(seek).toHaveBeenCalledTimes(1);
      expect(exportFrame).not.toHaveBeenCalled();
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    },
  );

  it('cancels PNG before capture when seek queues a session replacement', async () => {
    const runtime = createStudioRuntime();
    const initial = createSampleProject('lumora://png-seek-microtask', 'PNG seek microtask');
    await runtime.openProject(initial);
    const project = runtime.getProject()!;
    const { session, seek } = sessionHarness();
    const exportFrame = vi.fn(() => true);
    seek.mockImplementationOnce(() => {
      queueMicrotask(() => runtime.editor.openProject(createSampleProject(project.uri, 'Replacement')));
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,frame');

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: exportFrame }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /导出 分镜 1.*PNG/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('项目会话已变更'));
    expect(exportFrame).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('cancels PNG before download when capture queues a session replacement', async () => {
    const runtime = createStudioRuntime();
    const initial = createSampleProject('lumora://png-capture-microtask', 'PNG capture microtask');
    await runtime.openProject(initial);
    const project = runtime.getProject()!;
    const { session } = sessionHarness();
    const exportFrame = vi.fn(() => {
      queueMicrotask(() => runtime.editor.openProject(createSampleProject(project.uri, 'Replacement')));
      return true;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,frame');

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: exportFrame }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /导出 分镜 1.*PNG/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('项目会话已变更'));
    expect(exportFrame).toHaveBeenCalledTimes(1);
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it.each(SEEK_SESSION_REENTRIES)(
    'cancels WebM before capture when seek synchronously %s',
    async (_label, replaceSession) => {
      const runtime = createStudioRuntime();
      const initial = projectWithShortShots();
      await runtime.openProject(initial);
      const project = runtime.getProject()!;
      const { session, seek } = sessionHarness();
      const recorder = encoderDependencies();
      const exportFrame = vi.fn(() => true);
      seek.mockImplementationOnce(() => replaceSession(runtime, project));

      render(
        <ExportWorkspace
          runtime={runtime}
          project={project}
          session={session}
          captureRef={{ current: null }}
          exportFrameRef={{ current: exportFrame }}
          support={SUPPORTED}
          recordingDependencies={recorder.dependencies}
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'));
      expect(seek).toHaveBeenCalledTimes(1);
      expect(exportFrame).not.toHaveBeenCalled();
      expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );

  it('cancels WebM before capture when seek queues a session replacement', async () => {
    const runtime = createStudioRuntime();
    const initial = projectWithShortShots();
    await runtime.openProject(initial);
    const project = runtime.getProject()!;
    const { session, seek } = sessionHarness();
    const recorder = encoderDependencies();
    const exportFrame = vi.fn(() => true);
    seek.mockImplementationOnce(() => {
      queueMicrotask(() => runtime.editor.openProject(createSampleProject(project.uri, 'Replacement')));
    });

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: exportFrame }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'));
    expect(exportFrame).not.toHaveBeenCalled();
    expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not request a WebM frame after capture queues a same-URI session replacement', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    await runtime.openProject(project);
    const current = runtime.getProject()!;
    const { session } = sessionHarness();
    const recorder = encoderDependencies();
    const renderFrame = vi.fn(() => {
      queueMicrotask(() => runtime.editor.openProject(createSampleProject(project.uri, 'Replacement')));
      return true;
    });

    render(
      <ExportWorkspace
        runtime={runtime}
        project={current}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: renderFrame }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));

    await waitFor(() => expect(renderFrame).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'));
    expect(recorder.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not download or restore the playhead after the project session changes', async () => {
    const runtime = createStudioRuntime();
    await runtime.openProject(projectWithShortShots());
    const project = runtime.getProject()!;
    const { session, seek } = sessionHarness();
    const flush = deferred<Blob>();
    const recorder = encoderDependencies({ flush: () => flush.promise });
    const renderFrame = vi.fn(() => true);

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: renderFrame }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));
    await waitFor(() => expect(recorder.encoder.flush).toHaveBeenCalledTimes(1));

    act(() => runtime.editor.openProject(createSampleProject(project.uri, 'Reopened session')));
    flush.resolve(new Blob(['stale-webm'], { type: 'video/webm;codecs=vp8' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenLastCalledWith(0.5, false);
  });

  it('keeps a newer WebM operation busy when a removed plugin promise settles', async () => {
    const runtime = createStudioRuntime();
    const initial = projectWithShortShots();
    await runtime.openProject(initial);
    const project = runtime.getProject()!;
    const pluginResult = deferred<{ fileName: string; mime: string; data: string }>();
    const plugin = await registerDeferredExporter(runtime, pluginResult.promise);
    const flush = deferred<Blob>();
    const recorder = encoderDependencies({ flush: () => flush.promise });
    const { session } = sessionHarness();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '运行 慢导出器' }));
    await act(async () => {
      await runtime.host.disable(plugin.pluginId);
    });
    fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));
    await waitFor(() => expect(recorder.encoder.flush).toHaveBeenCalledTimes(1));

    await act(async () => {
      pluginResult.resolve({ fileName: 'stale.json', mime: 'application/json', data: '{}' });
      await pluginResult.promise;
    });

    expect(screen.getByTestId('export-operation-controls')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('正在导出');
    expect(screen.getByRole('button', { name: '导出清单' })).toBeDisabled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    flush.resolve(new Blob(['current-webm'], { type: 'video/webm;codecs=vp8' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('导出完成'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight export and closes its encoder', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    const { session } = sessionHarness();
    const recorder = encoderDependencies({
      flush: () => new Promise<Blob>(() => undefined),
    });

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: vi.fn(() => true) }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 WebM' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消导出' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'));
    expect(recorder.encoder.close).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 WebM' })).toHaveFocus());
  });

  it('keeps the live status outside the busy controls and restores WebM focus after failure', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    const { session } = sessionHarness();
    const flush = deferred<Blob>();
    const recorder = encoderDependencies({ flush: () => flush.promise });
    const renderFrame = vi.fn(() => true);

    render(
      <ExportWorkspace
        runtime={runtime}
        project={project}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: renderFrame }}
        support={SUPPORTED}
        recordingDependencies={recorder.dependencies}
        onClose={vi.fn()}
      />,
    );
    const primary = screen.getByRole('button', { name: '导出 WebM' });
    fireEvent.click(primary);

    const controls = await screen.findByTestId('export-operation-controls');
    expect(controls).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('export-workspace')).not.toHaveAttribute('aria-busy');
    expect(controls).not.toContainElement(screen.getByRole('status'));
    flush.reject(new Error('codec failed'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('WebM 导出失败'));
    await waitFor(() => expect(primary).toHaveFocus());
  });

  it('isolates a plugin exporter failure and preserves the current project', async () => {
    const runtime = createStudioRuntime();
    const project = createSampleProject();
    await runtime.openProject(project);
    const plugin: PluginDescriptor = {
      manifest: {
        schemaVersion: '1',
        id: 'com.example.failedexport',
        name: '失败导出插件',
        version: '0.1.0',
        entry: './dist/index.js',
      },
      entry: async () => ({
        default: {
          activate: (context) =>
            context.contribute({
              exporters: [{
                kind: 'exporter',
                id: 'com.example.failedexport.json',
                name: '失败导出器',
                formats: ['json'],
                export: () => {
                  throw new Error('插件导出失败');
                },
              }],
            }),
        },
      }),
    };
    await runtime.host.register(plugin);
    const current = runtime.getProject();
    const { session } = sessionHarness();

    render(
      <ExportWorkspace
        runtime={runtime}
        project={current!}
        session={session}
        captureRef={{ current: null }}
        exportFrameRef={{ current: null }}
        support={SUPPORTED}
        onClose={vi.fn()}
      />,
    );
    const pluginButton = screen.getByRole('button', { name: '运行 失败导出器' });
    fireEvent.click(pluginButton);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('插件导出失败'));
    expect(pluginButton).toHaveFocus();
    expect(runtime.getProject()).toBe(current);
    expect(screen.getByRole('button', { name: '关闭导出' })).toBeEnabled();
  });
});
