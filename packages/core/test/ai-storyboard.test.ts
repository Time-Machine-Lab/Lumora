import { describe, expect, it, vi } from 'vitest';
import * as core from '../src/index';
import { createPluginServices } from '../src/services';

interface ExpectedAiService {
  listStoryboardProviders(): Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string; cost: { kind: 'known' | 'unknown' } }>;
  }>;
  submitStoryboard(providerId: string, request: {
    model: string;
    brief: {
      concept: string;
      targetDurationSeconds: number;
      shotCount: number;
      visualStyle?: string;
    };
  }): { id: string; status: string };
  getGenerationTask(taskId: string): unknown;
  waitForGenerationTask(taskId: string): Promise<{
    id: string;
    status: string;
    draft?: { shots: Array<{ title: string; shotSize: string; movement: string; durationSeconds: number; prompt: string }> };
    error?: { code: string; message: string; retryable: boolean; costKnown: boolean };
  }>;
  cancelGenerationTask(taskId: string): boolean;
}

const BRIEF = {
  concept: 'A courier crosses a rain-soaked neon market to deliver a mysterious case.',
  targetDurationSeconds: 12,
  shotCount: 3,
  visualStyle: 'Grounded cinematic sci-fi',
};

const VALID_PAYLOAD = {
  title: 'Neon delivery',
  summary: 'A concise three-beat pursuit.',
  shots: [
    { title: 'Arrival', shotSize: 'wide', movement: 'dolly-in', durationSeconds: 4, prompt: 'Wide market arrival in rain.' },
    { title: 'Pursuit', shotSize: 'medium', movement: 'tracking', durationSeconds: 4, prompt: 'Track beside the courier.' },
    { title: 'Reveal', shotSize: 'close-up', movement: 'static', durationSeconds: 4, prompt: 'Close on the opened case.' },
  ],
};

function servicesWith(generate: (request: { signal: AbortSignal }) => Promise<unknown>, costKind: 'known' | 'unknown' = 'unknown') {
  const registry = {
    getAssetLoaders: () => [],
    getExporters: () => [],
    getAiProviders: () => [
      {
        id: 'com.example.storyboard',
        name: 'Example Storyboard',
        models: [],
        chat: async function* () {},
        storyboard: {
          capability: 'ai.storyboard.generate' as const,
          models: [
            {
              id: 'storyboard-1',
              name: 'Storyboard 1',
              cost:
                costKind === 'known'
                  ? { kind: 'known' as const, amount: 0.02, currency: 'USD', note: 'Per request estimate' }
                  : { kind: 'unknown' as const, note: 'Provider does not report a preflight price' },
            },
          ],
          generate,
        },
      },
    ],
  };
  return createPluginServices(registry, () => null).ai as unknown as ExpectedAiService;
}

function servicesWithMalformedMetadata() {
  const registry = {
    getAssetLoaders: () => [],
    getExporters: () => [],
    getAiProviders: () => [{
      id: 'com.example.malformed',
      name: 'Malformed Storyboard',
      models: [],
      chat: async function* () {},
      storyboard: {
        capability: 'ai.storyboard.generate',
        models: [{ id: 'broken', name: 'Broken model' }],
        generate: async () => new Promise<unknown>(() => undefined),
      },
    }],
  };
  return createPluginServices(registry as never, () => null).ai as unknown as ExpectedAiService;
}

describe('AI storyboard capability', () => {
  it('exports strict brief and draft payload parsers', () => {
    const exports = core as unknown as {
      parseCreativeBrief?: (value: unknown) => unknown;
      parseStoryboardDraftPayload?: (value: unknown) => unknown;
    };

    expect(typeof exports.parseCreativeBrief).toBe('function');
    expect(typeof exports.parseStoryboardDraftPayload).toBe('function');
    expect(exports.parseCreativeBrief?.(BRIEF)).toEqual(BRIEF);
    expect(exports.parseStoryboardDraftPayload?.(VALID_PAYLOAD)).toEqual(VALID_PAYLOAD);
    expect(() =>
      exports.parseStoryboardDraftPayload?.({
        ...VALID_PAYLOAD,
        shots: [{ ...VALID_PAYLOAD.shots[0], durationSeconds: -1 }],
      }),
    ).toThrow();
    expect(() =>
      exports.parseCreativeBrief?.({ ...BRIEF, targetDurationSeconds: 1, shotCount: 24 }),
    ).toThrow();
    expect(
      exports.parseCreativeBrief?.({ ...BRIEF, targetDurationSeconds: 2.4, shotCount: 24 }),
    ).toMatchObject({ targetDurationSeconds: 2.4, shotCount: 24 });
    expect(() =>
      exports.parseCreativeBrief?.({ ...BRIEF, targetDurationSeconds: 601, shotCount: 1 }),
    ).toThrow();
    expect(
      exports.parseCreativeBrief?.({ ...BRIEF, targetDurationSeconds: 600, shotCount: 1 }),
    ).toMatchObject({ targetDurationSeconds: 600, shotCount: 1 });
  });

  it('lists storyboard-capable providers and completes one validated task without retrying', async () => {
    const generate = vi.fn(async () => VALID_PAYLOAD);
    const ai = servicesWith(generate, 'known');

    expect(ai.listStoryboardProviders()).toEqual([
      {
        id: 'com.example.storyboard',
        name: 'Example Storyboard',
        models: [
          {
            id: 'storyboard-1',
            name: 'Storyboard 1',
            cost: { kind: 'known', amount: 0.02, currency: 'USD', note: 'Per request estimate' },
          },
        ],
      },
    ]);

    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    expect(['queued', 'running']).toContain(submitted.status);

    const completed = await ai.waitForGenerationTask(submitted.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.draft?.shots).toHaveLength(3);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(ai.getGenerationTask(submitted.id)).toMatchObject({ status: 'succeeded' });
  });

  it('excludes providers with malformed storyboard metadata from discovery', () => {
    const ai = servicesWithMalformedMetadata();

    expect(ai.listStoryboardProviders()).toEqual([]);
  });

  it('rejects submission when current storyboard metadata is malformed', () => {
    const ai = servicesWithMalformedMetadata();

    expect(() => ai.submitStoryboard('com.example.malformed', {
      model: 'broken',
      brief: BRIEF,
    })).toThrow(/unavailable/i);
  });

  it('fails an invalid provider schema without exposing a draft', async () => {
    const ai = servicesWith(async () => ({ title: 'Broken', summary: 'Missing required fields', shots: [{ title: 'No prompt' }] }));

    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.status).toBe('failed');
    expect(completed.draft).toBeUndefined();
    expect(completed.error).toMatchObject({ code: 'schema_invalid', retryable: false, costKnown: false });
  });

  it('normalizes provider errors, redacts credentials, and never auto-retries unknown-cost failures', async () => {
    const generate = vi.fn(async () => {
      const error = new Error(
        'Rate limited for apiKey=sk-live-1234567890abcdef; response={"api_key":"plain-secret-value","authorization":"Basic dXNlcjpwYXNz"}',
      );
      Object.assign(error, { code: 'rate_limited', retryable: true, retryAfterMs: 2500, costKnown: false });
      throw error;
    });
    const ai = servicesWith(generate);

    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.status).toBe('failed');
    expect(completed.error).toMatchObject({ code: 'rate_limited', retryable: true, costKnown: false });
    expect(completed.error?.message).toContain('[REDACTED]');
    expect(completed.error?.message).not.toContain('sk-live-1234567890abcdef');
    expect(completed.error?.message).not.toContain('plain-secret-value');
    expect(completed.error?.message).not.toContain('dXNlcjpwYXNz');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight task through AbortSignal', async () => {
    const generate = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<unknown>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          void resolve;
        }),
    );
    const ai = servicesWith(generate);

    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    expect(ai.cancelGenerationTask(submitted.id)).toBe(true);
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.status).toBe('cancelled');
    expect(completed.error).toMatchObject({ code: 'cancelled', retryable: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('completes cancellation even when a provider ignores AbortSignal', async () => {
    const ai = servicesWith(async () => new Promise<unknown>(() => undefined));
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });

    expect(ai.cancelGenerationTask(submitted.id)).toBe(true);
    const outcome = await Promise.race([
      ai.waitForGenerationTask(submitted.id),
      new Promise<'still-running'>((resolve) => setTimeout(() => resolve('still-running'), 25)),
    ]);

    expect(outcome).not.toBe('still-running');
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
  });

  it('bounds completed task history while keeping recent terminal tasks waitable', async () => {
    const ai = servicesWith(async () => VALID_PAYLOAD);
    const completedIds: string[] = [];

    for (let index = 0; index < 101; index += 1) {
      const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
      completedIds.push((await ai.waitForGenerationTask(submitted.id)).id);
    }

    expect(ai.getGenerationTask(completedIds[0]!)).toBeUndefined();
    await expect(ai.waitForGenerationTask(completedIds.at(-1)!)).resolves.toMatchObject({ status: 'succeeded' });
  });
});
