import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSampleProject,
  PluginHost,
  type CreativeBrief,
  type Manifest,
  type PluginSettingsStorage,
} from '@lumora/core';
import { waitForStoryboardTaskExecution } from '../../../packages/core/src/services';
import manifest from '../lumora.plugin.json';
import { createOpenAiCompatiblePlugin, OPENAI_COMPATIBLE_PROVIDER_ID } from '../src/index';
import { ProviderConfigStore } from '../src/config';
import type { OpenAiFetch } from '../src/openai-client';
import { createControlledBodyStageResponse } from './body-stage-response';

const BRIEF: CreativeBrief = {
  concept: 'A courier crosses a rain-soaked neon market to deliver a mysterious case.',
  targetDurationSeconds: 12,
  shotCount: 3,
};

const VALID_DRAFT = {
  title: 'Neon delivery',
  summary: 'A three-beat pursuit.',
  shots: [
    { title: 'Arrival', shotSize: 'wide', movement: 'dolly-in', durationSeconds: 4, prompt: 'Wide rainy market.' },
    { title: 'Pursuit', shotSize: 'medium', movement: 'tracking', durationSeconds: 4, prompt: 'Track the courier.' },
    { title: 'Reveal', shotSize: 'close-up', movement: 'static', durationSeconds: 4, prompt: 'Reveal the case.' },
  ],
};

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

let fixtureSequence = 0;

function pluginFixture() {
  const prefix = `openai-fixture-${fixtureSequence += 1}`;
  let configStore: ProviderConfigStore | undefined;
  const pluginSettingsStorage: PluginSettingsStorage = {
    get: (pluginInstanceId, key) => localStorage.getItem(`${prefix}:${pluginInstanceId}:${key}`),
    set: (pluginInstanceId, key, value) => localStorage.setItem(`${prefix}:${pluginInstanceId}:${key}`, value),
    remove: (pluginInstanceId, key) => localStorage.removeItem(`${prefix}:${pluginInstanceId}:${key}`),
  };
  const descriptor = {
    manifest: manifest as Manifest,
    entry: async () => ({
      default: createOpenAiCompatiblePlugin((settings) => {
        configStore = new ProviderConfigStore(settings);
        return configStore;
      }),
    }),
  };
  return {
    descriptor,
    pluginSettingsStorage,
    get configStore(): ProviderConfigStore {
      if (!configStore) throw new Error('Plugin is not active.');
      return configStore;
    },
    persistedText: () => Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return key?.startsWith(`${prefix}:`) ? localStorage.getItem(key) : null;
    }).join('\n'),
  };
}

describe('OpenAI-compatible plugin lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the newly configured custom model for the next host task and draft lineage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion(JSON.stringify(VALID_DRAFT))));
    const fixture = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: fixture.pluginSettingsStorage });
    await host.register(fixture.descriptor);

    expect(host.services.ai.listStoryboardProviders().find((item) => item.id === OPENAI_COMPATIBLE_PROVIDER_ID)?.models[0]?.id)
      .toBe('gpt-4o-mini');
    fixture.configStore.save({
      endpoint: 'https://compatible.example/v1',
      model: 'vendor/new-storyboard-model',
      apiKey: '',
    });
    expect(host.services.ai.listStoryboardProviders().find((item) => item.id === OPENAI_COMPATIBLE_PROVIDER_ID)?.models[0]?.id)
      .toBe('vendor/new-storyboard-model');

    const submitted = host.services.ai.submitStoryboard(OPENAI_COMPATIBLE_PROVIDER_ID, {
      model: 'vendor/new-storyboard-model',
      brief: BRIEF,
    });
    const completed = await host.services.ai.waitForGenerationTask(submitted.id);

    expect(completed).toMatchObject({ status: 'succeeded', model: 'vendor/new-storyboard-model' });
    expect(completed.draft).toMatchObject({ model: 'vendor/new-storyboard-model' });
    expect(completed.draft?.shots).toHaveLength(3);
    await host.dispose();
  });

  it('uses the latest configured model for Chat validation and the exact outgoing request', async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () => completion('model-b-response'));
    vi.stubGlobal('fetch', fetchImpl);
    const fixture = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: fixture.pluginSettingsStorage });
    await host.register(fixture.descriptor);
    fixture.configStore.save({
      endpoint: 'https://compatible.example/v1',
      model: 'model-b',
      apiKey: '',
    });

    const chunks: string[] = [];
    for await (const chunk of host.services.ai.chat(OPENAI_COMPATIBLE_PROVIDER_ID, {
      model: 'model-b',
      messages: [{ role: 'user', content: 'hello' }],
    })) chunks.push(chunk);

    expect(chunks).toEqual(['model-b-response']);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'model-b' });
    await expect((async () => {
      for await (const _chunk of host.services.ai.chat(OPENAI_COMPATIBLE_PROVIDER_ID, {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'stale' }],
      })) {
        // Consume the stream so host validation executes.
      }
    })()).rejects.toThrow(/gpt-4o-mini/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await host.dispose();
  });

  it('lets the host reject a structurally incomplete provider payload without exposing a draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion(JSON.stringify({
      title: 'Incomplete response',
      summary: 'Missing required shot fields.',
      shots: [{ title: 'Broken' }, { title: 'Broken' }, { title: 'Broken' }],
    }))));
    const fixture = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: fixture.pluginSettingsStorage });
    await host.register(fixture.descriptor);
    const model = host.services.ai.listStoryboardProviders().find((item) => item.id === OPENAI_COMPATIBLE_PROVIDER_ID)!.models[0]!.id;

    const submitted = host.services.ai.submitStoryboard(OPENAI_COMPATIBLE_PROVIDER_ID, { model, brief: BRIEF });
    const completed = await host.services.ai.waitForGenerationTask(submitted.id);

    expect(completed).toMatchObject({ status: 'failed', error: { code: 'schema_invalid' } });
    expect(completed.draft).toBeUndefined();
    await host.dispose();
  });

  it('cancels an in-flight request and clears only the key when disabled, then restores non-sensitive settings', async () => {
    const captured: { signal?: AbortSignal } = {};
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      captured.signal = init?.signal ?? undefined;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const fixture = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: fixture.pluginSettingsStorage });
    const info = await host.register(fixture.descriptor);
    fixture.configStore.save({
      endpoint: 'https://compatible.example/v1',
      model: 'vendor/persisted-model',
      apiKey: 'sk-disable-runtime-marker',
    });
    const submitted = host.services.ai.submitStoryboard(OPENAI_COMPATIBLE_PROVIDER_ID, {
      model: 'vendor/persisted-model',
      brief: BRIEF,
    });
    const completed = host.services.ai.waitForGenerationTask(submitted.id);

    await host.disable(info.instanceId);

    await expect(completed).resolves.toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect(captured.signal?.aborted).toBe(true);
    expect(fixture.configStore.getSnapshot().apiKey).toBe('');
    expect(fixture.persistedText()).toContain('vendor/persisted-model');
    expect(fixture.persistedText()).not.toContain('sk-disable-runtime-marker');

    await host.enable(info.instanceId);
    expect(fixture.configStore.getSnapshot()).toMatchObject({
      endpoint: 'https://compatible.example/v1/chat/completions',
      model: 'vendor/persisted-model',
      apiKey: '',
    });
    await host.dispose();
  });

  it.each([
    ['caller abort', 'caller', 'cancelled', 'cancelled'],
    ['plugin lifecycle abort', 'lifecycle', 'cancelled', 'cancelled'],
    ['deadline', 'deadline', 'failed', 'timeout'],
  ] as const)(
    'keeps the terminal task and project unchanged after a %s body-stage late success',
    async (_label, trigger, status, code) => {
      if (trigger === 'deadline') vi.useFakeTimers();
      const bodyStage = createControlledBodyStageResponse({
        choices: [{ message: { content: JSON.stringify(VALID_DRAFT) } }],
      });
      vi.stubGlobal('fetch', bodyStage.fetchImpl);
      const fixture = pluginFixture();
      const host = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: fixture.pluginSettingsStorage });
      const project = createSampleProject();
      const projectBefore = structuredClone(project);
      host.setProject(project);
      const info = await host.register(fixture.descriptor);
      const submitted = host.services.ai.submitStoryboard(OPENAI_COMPATIBLE_PROVIDER_ID, {
        model: 'gpt-4o-mini',
        brief: BRIEF,
      });
      const applicationSettled = waitForStoryboardTaskExecution(host.services, submitted.id);
      await bodyStage.bodyReadStarted;

      if (trigger === 'caller') {
        expect(host.services.ai.cancelGenerationTask(submitted.id)).toBe(true);
      } else if (trigger === 'lifecycle') {
        await host.disable(info.instanceId);
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        vi.useRealTimers();
      }

      const terminal = await host.services.ai.waitForGenerationTask(submitted.id);
      expect(terminal).toMatchObject({ status, error: { code } });
      expect(terminal).not.toHaveProperty('draft');
      expect(host.getProject()).toEqual(projectBefore);

      bodyStage.releaseBody();
      await Promise.all([bodyStage.readerCleanupSettled, applicationSettled]);

      const completed = host.services.ai.getGenerationTask(submitted.id);
      expect(completed).toMatchObject({ status, error: { code } });
      expect(completed).not.toHaveProperty('draft');
      expect(host.getProject()).toEqual(projectBefore);
      await host.dispose();
    },
  );

  it('isolates credentials and lifecycle cancellation between simultaneous hosts', async () => {
    const first = pluginFixture();
    const second = pluginFixture();
    const captured = new Map<string, { authorization: string | null; signal?: AbortSignal }>();
    let resolveSecond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      captured.set(url, {
        authorization: new Headers(init?.headers).get('Authorization'),
        signal: init?.signal ?? undefined,
      });
      if (url.includes('first.example')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return new Promise<Response>((resolve, reject) => {
        resolveSecond = resolve;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }));

    const firstHost = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: first.pluginSettingsStorage });
    const secondHost = new PluginHost({ hostVersion: '0.1.0', pluginSettingsStorage: second.pluginSettingsStorage });
    const firstInfo = await firstHost.register(first.descriptor);
    await secondHost.register(second.descriptor);
    first.configStore.save({ endpoint: 'https://first.example/v1', model: 'first-model', apiKey: 'first-key' });
    second.configStore.save({ endpoint: 'https://second.example/v1', model: 'second-model', apiKey: 'second-key' });

    const firstTask = firstHost.services.ai.submitStoryboard(OPENAI_COMPATIBLE_PROVIDER_ID, {
      model: 'first-model',
      brief: BRIEF,
    });
    const secondTask = secondHost.services.ai.submitStoryboard(OPENAI_COMPATIBLE_PROVIDER_ID, {
      model: 'second-model',
      brief: BRIEF,
    });

    await firstHost.disable(firstInfo.instanceId);

    await expect(firstHost.services.ai.waitForGenerationTask(firstTask.id)).resolves.toMatchObject({ status: 'cancelled' });
    expect(captured.get('https://first.example/v1/chat/completions')?.signal?.aborted).toBe(true);
    expect(captured.get('https://second.example/v1/chat/completions')).toMatchObject({
      authorization: 'Bearer second-key',
    });
    expect(captured.get('https://second.example/v1/chat/completions')?.signal?.aborted).toBe(false);
    expect(second.configStore.getSnapshot().apiKey).toBe('second-key');

    await firstHost.enable(firstInfo.instanceId);
    expect(first.configStore.getSnapshot()).toEqual({
      endpoint: 'https://first.example/v1/chat/completions',
      model: 'first-model',
      apiKey: '',
    });
    expect(first.persistedText()).toContain('first-model');
    expect(second.persistedText()).toContain('second-model');
    expect(first.persistedText()).not.toContain('first-key');
    expect(first.persistedText()).not.toContain('second-key');
    expect(second.persistedText()).not.toContain('first-key');
    expect(second.persistedText()).not.toContain('second-key');

    resolveSecond(completion(JSON.stringify(VALID_DRAFT)));
    await expect(secondHost.services.ai.waitForGenerationTask(secondTask.id)).resolves.toMatchObject({
      status: 'succeeded',
      model: 'second-model',
    });
    await firstHost.dispose();
    await secondHost.dispose();
  });
});
