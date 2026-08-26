import { ZodError } from 'zod';
import type { Asset, AiChatRequest, ExportResult } from './contributions/types';
import type { Project } from './scene/types';
import { deepFreeze } from './scene/immutable';
import {
  AI_STORYBOARD_GENERATE_CAPABILITY,
  AiProviderRequestError,
  normalizeAiProviderError,
  parseAiStoryboardCapability,
  parseCreativeBrief,
  parseStoryboardDraftPayload,
  resolveStoryboardModels,
  type AiStoryboardCapability,
  type AiProviderErrorData,
  type GenerationTask,
  type StoryboardGenerateRequest,
  type StoryboardProviderInfo,
} from './ai/storyboard';

export interface AssetService {
  load(uri: string): Promise<Asset>;
}

export interface AiService {
  chat(providerId: string, request: AiChatRequest): AsyncIterable<string>;
  listStoryboardProviders(): ReadonlyArray<StoryboardProviderInfo>;
  submitStoryboard(providerId: string, request: Omit<StoryboardGenerateRequest, 'signal'>): GenerationTask;
  getGenerationTask(taskId: string): GenerationTask | undefined;
  waitForGenerationTask(taskId: string): Promise<GenerationTask>;
  cancelGenerationTask(taskId: string): boolean;
}

export interface ExporterService {
  run(exporterId: string, project: Project): Promise<ExportResult>;
}

/** 宿主提供给插件与 UI 的统一服务门面 */
export interface PluginServices {
  assets: AssetService;
  ai: AiService;
  exporters: ExporterService;
}

interface RegisteredAiProvider {
  id: string;
  name: string;
  models: string[];
  chat(request: AiChatRequest): AsyncIterable<string>;
  storyboard?: AiStoryboardCapability;
}

interface ServiceRegistry {
  getAssetLoaders(): Array<{ id: string; name: string; extensions: string[]; load(uri: string): unknown }>;
  getAiProviders(): RegisteredAiProvider[];
  getExporters(): Array<{ id: string; name: string; formats: string[]; export(project: Project): unknown }>;
}

interface TaskControl {
  controller: AbortController;
  completion: Promise<GenerationTask>;
  finish(task: GenerationTask): void;
}

const MAX_RETAINED_GENERATION_TASKS = 100;

function isTerminalTask(task: GenerationTask): boolean {
  return task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled';
}

function publicTaskSnapshot(task: GenerationTask): GenerationTask {
  return deepFreeze(structuredClone(task));
}

function taskId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ai-task-${suffix}`;
}

function validatedStoryboardCapability(provider: RegisteredAiProvider): AiStoryboardCapability | undefined {
  if (provider.storyboard === undefined) return undefined;
  try {
    return parseAiStoryboardCapability(provider.storyboard);
  } catch {
    return undefined;
  }
}

function schemaIssuePath(error: ZodError): string | undefined {
  const path = error.issues[0]?.path;
  if (!path || path.length === 0) return undefined;
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    return result ? `${result}.${segment}` : segment;
  }, '');
}

function invalidSchemaError(costKnown: boolean, error?: ZodError): AiProviderErrorData {
  const path = error ? schemaIssuePath(error) : undefined;
  const code = error?.issues[0]?.code;
  const safeDetail = path ? ` at ${path}${code ? ` (${code})` : ''}` : '';
  return {
    code: 'schema_invalid',
    message: `Provider returned an invalid storyboard schema${safeDetail}.`,
    retryable: false,
    costKnown,
  };
}

class StoryboardTaskService {
  private readonly registry: ServiceRegistry;
  private readonly tasks = new Map<string, GenerationTask>();
  private readonly controls = new Map<string, TaskControl>();

  constructor(registry: ServiceRegistry) {
    this.registry = registry;
  }

  listProviders(): ReadonlyArray<StoryboardProviderInfo> {
    const providers = this.registry.getAiProviders().flatMap((provider) => {
      const storyboard = validatedStoryboardCapability(provider);
      if (!storyboard) return [];
      try {
        return [{ id: provider.id, name: provider.name, models: structuredClone(resolveStoryboardModels(storyboard)) }];
      } catch {
        return [];
      }
    });
    return deepFreeze(providers);
  }

  submit(providerId: string, request: Omit<StoryboardGenerateRequest, 'signal'>): GenerationTask {
    const provider = this.registry.getAiProviders().find((candidate) => candidate.id === providerId);
    const storyboard = provider ? validatedStoryboardCapability(provider) : undefined;
    if (!storyboard) {
      throw new AiProviderRequestError({
        code: 'provider_unavailable',
        message: `Storyboard provider is unavailable: ${providerId}`,
        retryable: false,
        costKnown: false,
      });
    }
    let models;
    try {
      models = resolveStoryboardModels(storyboard);
    } catch {
      throw new AiProviderRequestError({
        code: 'provider_unavailable',
        message: `Storyboard provider model catalog is unavailable: ${providerId}`,
        retryable: false,
        costKnown: false,
      });
    }
    const model = models.find((candidate) => candidate.id === request.model);
    if (!model) {
      throw new AiProviderRequestError({
        code: 'model_unsupported',
        message: `Storyboard model is not supported: ${request.model}`,
        retryable: false,
        costKnown: false,
      });
    }

    let brief;
    try {
      brief = parseCreativeBrief(request.brief);
    } catch (error) {
      throw new AiProviderRequestError({
        code: 'invalid_request',
        message: error instanceof Error ? error.message : 'Creative brief is invalid.',
        retryable: false,
        costKnown: false,
      });
    }

    const id = taskId();
    const task: GenerationTask = {
      id,
      capability: AI_STORYBOARD_GENERATE_CAPABILITY,
      providerId,
      model: model.id,
      brief,
      cost: structuredClone(model.cost),
      status: 'queued',
      submittedAt: new Date().toISOString(),
    };
    this.tasks.set(id, task);

    const controller = new AbortController();
    let finish!: (task: GenerationTask) => void;
    const completion = new Promise<GenerationTask>((resolve) => {
      finish = resolve;
    });
    this.controls.set(id, { controller, completion, finish });
    void this.execute(storyboard, task, controller);
    return publicTaskSnapshot(this.tasks.get(id)!);
  }

  get(taskIdValue: string): GenerationTask | undefined {
    const task = this.tasks.get(taskIdValue);
    return task ? publicTaskSnapshot(task) : undefined;
  }

  wait(taskIdValue: string): Promise<GenerationTask> {
    const task = this.tasks.get(taskIdValue);
    if (task && isTerminalTask(task)) return Promise.resolve(publicTaskSnapshot(task));
    const control = this.controls.get(taskIdValue);
    if (!control) {
      return Promise.reject(
        new AiProviderRequestError({
          code: 'invalid_request',
          message: `Unknown generation task: ${taskIdValue}`,
          retryable: false,
          costKnown: false,
        }),
      );
    }
    return control.completion.then(publicTaskSnapshot);
  }

  cancel(taskIdValue: string): boolean {
    const task = this.tasks.get(taskIdValue);
    const control = this.controls.get(taskIdValue);
    if (!task || !control || isTerminalTask(task)) {
      return false;
    }
    control.controller.abort();
    this.completeCancelled(task);
    return true;
  }

  cancelProvider(providerId: string): void {
    for (const task of [...this.tasks.values()]) {
      if (task.providerId === providerId && !isTerminalTask(task)) this.cancel(task.id);
    }
  }

  dispose(): void {
    for (const task of [...this.tasks.values()]) {
      if (!isTerminalTask(task)) this.cancel(task.id);
    }
    this.controls.clear();
    this.tasks.clear();
  }

  private async execute(
    capability: AiStoryboardCapability,
    initialTask: GenerationTask,
    controller: AbortController,
  ): Promise<void> {
    const running: GenerationTask = {
      ...initialTask,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(running.id, running);
    try {
      const raw = await capability.generate({
        model: running.model,
        brief: structuredClone(running.brief),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        this.completeCancelled(running);
        return;
      }
      let payload;
      try {
        payload = parseStoryboardDraftPayload(raw);
      } catch (error) {
        const failed: GenerationTask = {
          ...running,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: invalidSchemaError(running.cost.kind === 'known', error instanceof ZodError ? error : undefined),
        };
        this.completeTask(failed);
        return;
      }
      if (payload.shots.length !== running.brief.shotCount) {
        this.completeTask({
          ...running,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: invalidSchemaError(running.cost.kind === 'known'),
        });
        return;
      }
      const succeeded: GenerationTask = {
        ...running,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        draft: {
          id: `draft-${running.id}`,
          providerId: running.providerId,
          model: running.model,
          generatedAt: new Date().toISOString(),
          title: payload.title,
          summary: payload.summary,
          brief: structuredClone(running.brief),
          cost: structuredClone(running.cost),
          shots: payload.shots.map((shot, index) => ({ ...shot, id: `${running.id}-shot-${index + 1}` })),
        },
      };
      this.completeTask(succeeded);
    } catch (error) {
      if (controller.signal.aborted) {
        this.completeCancelled(running);
        return;
      }
      const failed: GenerationTask = {
        ...running,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: normalizeAiProviderError(error, running.cost.kind === 'known'),
      };
      this.completeTask(failed);
    }
  }

  private completeCancelled(task: GenerationTask): void {
    const cancelled: GenerationTask = {
      ...task,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: { code: 'cancelled', message: 'Generation cancelled.', retryable: false, costKnown: false },
    };
    this.completeTask(cancelled);
  }

  private completeTask(task: GenerationTask): void {
    const current = this.tasks.get(task.id);
    if (!current || isTerminalTask(current)) return;
    this.tasks.set(task.id, task);
    const control = this.controls.get(task.id);
    control?.finish(publicTaskSnapshot(task));
    this.controls.delete(task.id);
    this.pruneTaskHistory();
  }

  private pruneTaskHistory(): void {
    let terminalCount = 0;
    for (const task of this.tasks.values()) {
      if (isTerminalTask(task)) terminalCount += 1;
    }
    let removeCount = terminalCount - MAX_RETAINED_GENERATION_TASKS;
    if (removeCount <= 0) return;
    for (const [id, task] of this.tasks) {
      if (!isTerminalTask(task)) continue;
      this.tasks.delete(id);
      removeCount -= 1;
      if (removeCount === 0) return;
    }
  }
}

const taskServices = new WeakMap<PluginServices, StoryboardTaskService>();

export function cancelStoryboardTasksForProvider(services: PluginServices, providerId: string): void {
  taskServices.get(services)?.cancelProvider(providerId);
}

export function disposePluginServices(services: PluginServices): void {
  const tasks = taskServices.get(services);
  tasks?.dispose();
  taskServices.delete(services);
}

export function createPluginServices(
  registry: ServiceRegistry,
  _getProject: () => Project | null,
): PluginServices {
  const storyboardTasks = new StoryboardTaskService(registry);
  const services: PluginServices = {
    assets: {
      async load(uri) {
        const ext = extensionOf(uri);
        const loaders = registry.getAssetLoaders().filter((loader) =>
          ext !== null ? loader.extensions.includes(ext) : true,
        );
        const loader = loaders[0];
        if (!loader) {
          const available = registry.getAssetLoaders().flatMap((l) => l.extensions).join(', ') || '无';
          throw new Error(`没有可加载 "${uri}" 的资源加载器（扩展名 ${ext ?? '未知'}，可用: ${available}）`);
        }
        return (await loader.load(uri)) as Asset;
      },
    },
    ai: {
      async *chat(providerId, request) {
        const provider = registry.getAiProviders().find((p) => p.id === providerId);
        if (!provider) throw new Error(`未知 AI 提供方: ${providerId}`);
        if (!provider.models.includes(request.model)) {
          throw new Error(`模型 "${request.model}" 不受支持，可用: ${provider.models.join(', ')}`);
        }
        yield* provider.chat(request);
      },
      listStoryboardProviders: () => storyboardTasks.listProviders(),
      submitStoryboard: (providerId, request) => storyboardTasks.submit(providerId, request),
      getGenerationTask: (id) => storyboardTasks.get(id),
      waitForGenerationTask: (id) => storyboardTasks.wait(id),
      cancelGenerationTask: (id) => storyboardTasks.cancel(id),
    },
    exporters: {
      async run(exporterId, project) {
        const exporter = registry.getExporters().find((e) => e.id === exporterId);
        if (!exporter) throw new Error(`未知导出器: ${exporterId}`);
        return (await exporter.export(project)) as ExportResult;
      },
    },
  };
  taskServices.set(services, storyboardTasks);
  return services;
}

/** 提取 URI 扩展名（含前导点），无扩展名返回 null */
export function extensionOf(uri: string): string | null {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const match = /\.([a-z0-9]+(?:[.-][a-z0-9]+)*)$/i.exec(withoutQuery);
  return match ? match[0].toLowerCase() : null;
}
