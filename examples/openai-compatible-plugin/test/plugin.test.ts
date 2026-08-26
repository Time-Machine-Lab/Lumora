import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginHost, type CreativeBrief, type Manifest } from '@lumora/core';
import manifest from '../lumora.plugin.json';
import { createOpenAiCompatiblePlugin, OPENAI_COMPATIBLE_PROVIDER_ID } from '../src/index';
import { OPENAI_COMPATIBLE_STORAGE_KEY, ProviderConfigStore } from '../src/config';

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

function pluginFixture() {
  const configStore = new ProviderConfigStore(localStorage);
  const descriptor = {
    manifest: manifest as Manifest,
    entry: async () => ({ default: createOpenAiCompatiblePlugin(() => configStore) }),
  };
  return { configStore, descriptor };
}

describe('OpenAI-compatible plugin lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('uses the newly configured custom model for the next host task and draft lineage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion(JSON.stringify(VALID_DRAFT))));
    const { configStore, descriptor } = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0' });
    await host.register(descriptor);

    expect(host.services.ai.listStoryboardProviders().find((item) => item.id === OPENAI_COMPATIBLE_PROVIDER_ID)?.models[0]?.id)
      .toBe('gpt-4o-mini');
    configStore.save({
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

  it('lets the host reject a structurally incomplete provider payload without exposing a draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion(JSON.stringify({
      title: 'Incomplete response',
      summary: 'Missing required shot fields.',
      shots: [{ title: 'Broken' }, { title: 'Broken' }, { title: 'Broken' }],
    }))));
    const { descriptor } = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0' });
    await host.register(descriptor);
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
    const { configStore, descriptor } = pluginFixture();
    const host = new PluginHost({ hostVersion: '0.1.0' });
    const info = await host.register(descriptor);
    configStore.save({
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
    expect(configStore.getSnapshot().apiKey).toBe('');
    expect(localStorage.getItem(OPENAI_COMPATIBLE_STORAGE_KEY)).toContain('vendor/persisted-model');
    expect(localStorage.getItem(OPENAI_COMPATIBLE_STORAGE_KEY)).not.toContain('sk-disable-runtime-marker');

    await host.enable(info.instanceId);
    expect(configStore.getSnapshot()).toMatchObject({
      endpoint: 'https://compatible.example/v1/chat/completions',
      model: 'vendor/persisted-model',
      apiKey: '',
    });
    await host.dispose();
  });

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

    const firstHost = new PluginHost({ hostVersion: '0.1.0' });
    const secondHost = new PluginHost({ hostVersion: '0.1.0' });
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

    resolveSecond(completion(JSON.stringify(VALID_DRAFT)));
    await expect(secondHost.services.ai.waitForGenerationTask(secondTask.id)).resolves.toMatchObject({
      status: 'succeeded',
      model: 'second-model',
    });
    await firstHost.dispose();
    await secondHost.dispose();
  });
});
