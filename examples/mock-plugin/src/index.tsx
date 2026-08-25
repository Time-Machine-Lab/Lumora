import {
  AI_STORYBOARD_GENERATE_CAPABILITY,
  AiProviderRequestError,
  definePlugin,
} from '@lumora/plugin-sdk';
import type {
  AiChatRequest,
  Asset,
  ExportResult,
  Project,
  StoryboardDraftPayload,
  StoryboardGenerateRequest,
} from '@lumora/plugin-sdk';
import { MockAiChatPanel } from './panels/MockAiChatPanel';
import { MockConsolePanel } from './panels/MockConsolePanel';

/** mock-1：逐字流式回复的演示模型 */
async function* mockChat(request: AiChatRequest): AsyncIterable<string> {
  const reply = `Mock AI（${request.model}）收到 ${request.messages.length} 条消息，正在示例回答。`;
  for (let i = 0; i < reply.length; i += 1) {
    if (request.signal?.aborted) return;
    yield reply[i];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function buildMockStoryboard(request: StoryboardGenerateRequest): StoryboardDraftPayload {
  const { brief } = request;
  const shotSizes = ['wide', 'medium', 'close-up'] as const;
  const movements = ['dolly-in', 'tracking', 'static'] as const;
  const durationSeconds = Math.min(600, Math.max(0.1, brief.targetDurationSeconds / brief.shotCount));
  const shots = Array.from({ length: brief.shotCount }, (_, index) => {
    const suffix = ` Shot ${index + 1} of ${brief.shotCount}; ${brief.visualStyle ?? 'cinematic naturalism'}.`;
    const concept = brief.concept.slice(0, Math.max(0, 4_000 - suffix.length)).trimEnd();
    return {
      title: `Shot ${index + 1}`,
      shotSize: shotSizes[index % shotSizes.length]!,
      movement: movements[index % movements.length]!,
      durationSeconds,
      prompt: `${concept}${suffix}`,
    };
  });
  return {
    title: 'Offline storyboard draft',
    summary: `A ${brief.shotCount}-shot plan for a ${brief.targetDurationSeconds}-second sequence.`,
    shots,
  };
}

async function generateMockStoryboard(request: StoryboardGenerateRequest): Promise<unknown> {
  switch (request.model) {
    case 'mock-storyboard-timeout':
      await abortableDelay(5, request.signal);
      throw new AiProviderRequestError({
        code: 'timeout',
        message: 'The offline provider simulated a timeout.',
        retryable: true,
        costKnown: false,
      });
    case 'mock-storyboard-rate-limit':
      throw new AiProviderRequestError({
        code: 'rate_limited',
        message: 'The offline provider simulated a rate limit.',
        retryable: true,
        retryAfterMs: 3_000,
        costKnown: false,
      });
    case 'mock-storyboard-schema-error':
      return { title: 'Invalid offline payload', shots: [{ title: 'Missing fields' }] };
    case 'mock-storyboard-slow':
      await abortableDelay(30_000, request.signal);
      return buildMockStoryboard(request);
    case 'mock-storyboard-success':
      await abortableDelay(20, request.signal);
      return buildMockStoryboard(request);
    default:
      throw new AiProviderRequestError({
        code: 'model_unsupported',
        message: `Unsupported offline storyboard model: ${request.model}`,
        retryable: false,
        costKnown: false,
      });
  }
}

function loadMockAsset(uri: string): Asset {
  return {
    uri,
    mime: 'application/json',
    data: {
      kind: 'scene',
      source: uri,
      objects: [
        { id: 'mock-import-cube', kind: 'box', position: [0, 0.5, 0], color: '#ffd43b' },
        { id: 'mock-import-torus', kind: 'torus', position: [2, 0.5, 0], color: '#cc5de8' },
      ],
    },
  };
}

function exportProject(project: Project): ExportResult {
  return {
    fileName: `${project.name}.mock.json`,
    mime: 'application/json',
    data: JSON.stringify(
      { uri: project.uri, name: project.name, exportedBy: 'com.lumora.mock', objects: project.objects },
      null,
      2,
    ),
  };
}

const definition = definePlugin({
  async activate(context) {
    context.log('info', 'Mock 示例插件已激活');
    return context.contribute({
      panels: [
        {
          kind: 'panel',
          id: 'com.lumora.mock.panel.console',
          title: 'Mock 控制台',
          position: 'bottom',
          component: MockConsolePanel,
        },
        { kind: 'panel', id: 'com.lumora.mock.panel.ai', title: 'Mock AI 助手', component: MockAiChatPanel },
      ],
      commands: [
        {
          kind: 'command',
          command: {
            id: 'com.lumora.mock.exportScene',
            title: '导出场景为 JSON',
            category: 'Lumora Mock',
            async execute(_args, commandContext) {
              const project = commandContext.getProject();
              if (!project) return { ok: false, error: new Error('没有打开的项目可导出') };
              // 全量项目 JSON（场景/设置/活动场景/资源 base64 载荷均在列）：
              // 宿主「重开上次导出」按钮据此在全新运行时中恢复项目；
              // localStorage 仅用于示例宿主的跨运行时重开演示
              const data = JSON.stringify(project, null, 2);
              localStorage.setItem('lumora.demo.last-export', data);
              const blob = new Blob([data], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `${project.name}.mock.json`;
              anchor.click();
              URL.revokeObjectURL(url);
              return { ok: true, value: data.length };
            },
          },
        },
        {
          kind: 'command',
          command: {
            id: 'com.lumora.mock.showProjectInfo',
            title: '显示项目信息',
            category: 'Lumora Mock',
            execute(_args, commandContext) {
              const project = commandContext.getProject();
              // eslint-disable-next-line no-console -- 示例插件的演示日志
              console.log(
                `[com.lumora.mock] ${project ? `当前项目: ${project.name}（${project.objects.length} 个对象）` : '未打开项目'}`,
              );
              return { ok: true, value: project?.name ?? null };
            },
          },
        },
      ],
      toolbars: [
        {
          kind: 'toolbar',
          id: 'com.lumora.mock.toolbar.export',
          label: '导出场景',
          tooltip: '将当前场景导出为 JSON 文件',
          commandId: 'com.lumora.mock.exportScene',
          order: 10,
        },
      ],
      assetLoaders: [
        {
          kind: 'assetLoader',
          id: 'com.lumora.mock.asset',
          name: 'Mock JSON 场景',
          extensions: ['.mock.json'],
          load: loadMockAsset,
        },
      ],
      aiProviders: [
        {
          kind: 'aiProvider',
          id: 'com.lumora.mock.ai',
          name: 'Mock AI',
          models: ['mock-1'],
          chat: mockChat,
          storyboard: {
            capability: AI_STORYBOARD_GENERATE_CAPABILITY,
            models: [
              {
                id: 'mock-storyboard-success',
                name: 'Success',
                cost: { kind: 'known', amount: 0, currency: 'USD', note: 'Offline mock; no charge.' },
              },
              {
                id: 'mock-storyboard-timeout',
                name: 'Timeout',
                cost: { kind: 'unknown', note: 'Failure cost is intentionally unknown.' },
              },
              {
                id: 'mock-storyboard-rate-limit',
                name: 'Rate limit',
                cost: { kind: 'unknown', note: 'Failure cost is intentionally unknown.' },
              },
              {
                id: 'mock-storyboard-schema-error',
                name: 'Invalid schema',
                cost: { kind: 'unknown', note: 'Failure cost is intentionally unknown.' },
              },
              {
                id: 'mock-storyboard-slow',
                name: 'Slow / cancellable',
                cost: { kind: 'unknown', note: 'Cancel this request to test abort handling.' },
              },
            ],
            generate: generateMockStoryboard,
          },
        },
      ],
      exporters: [
        {
          kind: 'exporter',
          id: 'com.lumora.mock.exporter',
          name: 'Mock 场景导出',
          formats: ['mock-json'],
          export: exportProject,
        },
      ],
    });
  },
  deactivate() {
    // eslint-disable-next-line no-console -- 示例插件的演示日志
    console.log('[com.lumora.mock] 插件已停用，所有贡献项已由宿主回收');
  },
});

export default definition;
