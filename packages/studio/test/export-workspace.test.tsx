import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSampleProject } from '@lumora/core';
import type { PluginDescriptor, Project } from '@lumora/core';
import { createStudioRuntime } from '../src/runtime/studio-runtime';
import { ExportWorkspace } from '../src/components/export/ExportWorkspace';
import type { TimelineSession } from '../src/hooks/use-timeline-session';
import type {
  MediaRecorderLike,
  PreviewRecordingDependencies,
  WebmSupport,
} from '../src/export/preview-export';

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

function recorderDependencies(options: { wait?: PreviewRecordingDependencies['waitForFrame'] } = {}) {
  const track = { requestFrame: vi.fn(), stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const canvas = {
    width: 0,
    height: 0,
    captureStream: vi.fn(() => stream),
  } as unknown as HTMLCanvasElement;
  const recorder: MediaRecorderLike = {
    state: 'inactive',
    ondataavailable: null,
    onerror: null,
    onstop: null,
    start: vi.fn(function start(this: MediaRecorderLike) {
      this.state = 'recording';
    }),
    stop: vi.fn(function stop(this: MediaRecorderLike) {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['webm']) } as BlobEvent);
      this.onstop?.(new Event('stop'));
    }),
  };
  const dependencies: PreviewRecordingDependencies = {
    createCanvas: () => canvas,
    createRecorder: () => recorder,
    waitForFrame: options.wait ?? vi.fn(async () => undefined),
  };
  return { dependencies, recorder, track };
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

  it('reports exact-size PNG capture failure instead of downloading a thumbnail fallback', () => {
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

    expect(screen.getByRole('alert')).toHaveTextContent('PNG 导出失败');
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
    const recorder = recorderDependencies();

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
    expect(recorder.recorder.start).not.toHaveBeenCalled();
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
    const recorder = recorderDependencies();
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
    expect(recorder.track.stop).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

    fireEvent.click(screen.getByRole('button', { name: '关闭导出' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not capture, download, or restore the playhead after the project session changes', async () => {
    const runtime = createStudioRuntime();
    await runtime.openProject(projectWithShortShots());
    const project = runtime.getProject()!;
    const { session, seek } = sessionHarness();
    let releaseFrame!: () => void;
    let waits = 0;
    const recorder = recorderDependencies({
      wait: () => {
        waits += 1;
        if (waits !== 1) return Promise.resolve();
        return new Promise<void>((resolve) => { releaseFrame = resolve; });
      },
    });
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
    await waitFor(() => expect(renderFrame).toHaveBeenCalledTimes(1));

    act(() => runtime.editor.openProject(createSampleProject(project.uri, 'Reopened session')));
    releaseFrame();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'));
    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenLastCalledWith(0.5, false);
  });

  it('cancels an in-flight export and releases its media track', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    const { session } = sessionHarness();
    const recorder = recorderDependencies({
      wait: (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
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
    expect(recorder.track.stop).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '导出 WebM' })).toHaveFocus();
  });

  it('keeps the live status outside the busy controls and restores WebM focus after failure', async () => {
    const runtime = createStudioRuntime();
    const project = projectWithShortShots();
    const { session } = sessionHarness();
    let release!: () => void;
    const recorder = recorderDependencies({
      wait: () => new Promise<void>((resolve) => { release = resolve; }),
    });
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
    renderFrame.mockReturnValue(false);
    release();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('WebM 导出失败'));
    expect(primary).toHaveFocus();
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
    fireEvent.click(screen.getByRole('button', { name: '运行 失败导出器' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('插件导出失败'));
    expect(runtime.getProject()).toBe(current);
    expect(screen.getByRole('button', { name: '关闭导出' })).toBeEnabled();
  });
});
