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

const DIAGNOSTIC_DELIMITERS = [
  ['comma', ','],
  ['semicolon', ';'],
  ['line break', '\n'],
] as const;

const GENERIC_PROVIDER_ERROR_MESSAGE = 'The AI provider request failed.';
const PRIVATE_PROVIDER_MARKER = 'PRIVATE_PROVIDER_RESPONSE_MARKER';

function diagnosticQuoteWrapper(depth: number, quote: '"' | "'"): string {
  return `${'\\'.repeat(depth === 0 ? 0 : (2 ** depth) - 1)}${quote}`;
}

const UNTRUSTED_PROVIDER_DIAGNOSTICS = [0, 1, 2, 4].flatMap((depth) =>
  (['"', "'"] as const).flatMap((quote) =>
    ([2, 3] as const).flatMap((backslashCount) =>
      DIAGNOSTIC_DELIMITERS.map(([delimiterName, delimiter]) => {
        const wrapper = diagnosticQuoteWrapper(depth, quote);
        return {
          name: `depth ${depth}, ${quote === '"' ? 'double' : 'single'} quote, ${backslashCount % 2 === 0 ? 'even' : 'odd'} backslashes, ${delimiterName}`,
          message: `${wrapper}apiKey${wrapper}:${wrapper}prefix${'\\'.repeat(backslashCount)}${quote}${delimiter}${PRIVATE_PROVIDER_MARKER}${wrapper}`,
        };
      }),
    ),
  ),
).concat([
  { name: 'URL-encoded credential key', message: `%61%70%69%5F%6B%65%79=${PRIVATE_PROVIDER_MARKER}` },
  { name: 'Unicode-escaped credential key', message: `api\\u005fkey=${PRIVATE_PROVIDER_MARKER}` },
  { name: 'unknown response body', message: `<html><body>${PRIVATE_PROVIDER_MARKER}</body></html>` },
]);

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

  it('summarizes invalid schema diagnostics without exposing credential-shaped enum values', async () => {
    const secret = 'sk-live-1234567890abcdef';
    const ai = servicesWith(async () => ({
      ...VALID_PAYLOAD,
      shots: [{ ...VALID_PAYLOAD.shots[0], shotSize: secret }, ...VALID_PAYLOAD.shots.slice(1)],
    }));

    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed).toMatchObject({ status: 'failed', error: { code: 'schema_invalid' } });
    expect(completed.error?.message).toContain('shots[0].shotSize');
    expect(completed.error?.message).not.toContain(secret);
  });

  it.each([
    ['throwing data getter', Object.defineProperty({}, 'code', { get: () => { throw new Error('getter exploded'); } })],
    ['throwing descriptor proxy', new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error('descriptor exploded'); },
      getPrototypeOf: () => { throw new Error('prototype exploded'); },
    })],
  ])('always completes a failed task when provider normalization receives a %s', async (_label, hostileError) => {
    const ai = servicesWith(async () => { throw hostileError; });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const outcome = await Promise.race([
      ai.waitForGenerationTask(submitted.id),
      new Promise<'still-running'>((resolve) => setTimeout(() => resolve('still-running'), 50)),
    ]);

    expect(outcome).not.toBe('still-running');
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'provider_error' } });
  });

  it('keeps a provider-originated AbortError consistent with a failed terminal status', async () => {
    const ai = servicesWith(async () => { throw new DOMException('Provider aborted internally', 'AbortError'); });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });

    await expect(ai.waitForGenerationTask(submitted.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'provider_error', retryable: false },
    });
  });

  it.each([
    new core.AiProviderRequestError({
      code: 'cancelled',
      message: 'Provider cancelled internally.',
      retryable: false,
      costKnown: false,
    }),
    {
      code: 'cancelled',
      message: 'Provider returned a cancelled code.',
      retryable: false,
      costKnown: false,
    },
  ])('treats a provider-originated cancelled code as a failed provider error', async (providerError) => {
    const ai = servicesWith(async () => { throw providerError; });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });

    await expect(ai.waitForGenerationTask(submitted.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'provider_error', retryable: false },
    });
  });

  it.each(UNTRUSTED_PROVIDER_DIAGNOSTICS)(
    'replaces untrusted provider text in direct diagnostics: $name',
    ({ message }) => {
      expect(core.redactAiDiagnosticText(message)).toBe(GENERIC_PROVIDER_ERROR_MESSAGE);
    },
  );

  it.each(UNTRUSTED_PROVIDER_DIAGNOSTICS)(
    'replaces untrusted provider text during normalization: $name',
    ({ message }) => {
      const normalized = core.normalizeAiProviderError(new Error(message, {
        cause: new Error(`cause:${PRIVATE_PROVIDER_MARKER}`),
      }));

      expect(normalized).toMatchObject({
        code: 'provider_error',
        message: GENERIC_PROVIDER_ERROR_MESSAGE,
        retryable: false,
        costKnown: false,
      });
      expect(JSON.stringify(normalized)).not.toContain(PRIVATE_PROVIDER_MARKER);
    },
  );

  it.each(UNTRUSTED_PROVIDER_DIAGNOSTICS)(
    'replaces untrusted provider text across the GenerationTask boundary: $name',
    async ({ message }) => {
      const ai = servicesWith(async () => {
        const error = new Error(message, { cause: new Error(`cause:${PRIVATE_PROVIDER_MARKER}`) });
        Object.assign(error, { responseBody: `response:${PRIVATE_PROVIDER_MARKER}` });
        throw error;
      });
      const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
      const completed = await ai.waitForGenerationTask(submitted.id);

      expect(completed.status).toBe('failed');
      expect(completed.error?.message).toBe(GENERIC_PROVIDER_ERROR_MESSAGE);
      expect(JSON.stringify(completed)).not.toContain(PRIVATE_PROVIDER_MARKER);
    },
  );

  it.each([
    ['invalid_request', 'The AI request is invalid.'],
    ['provider_unavailable', 'The AI provider is unavailable.'],
    ['model_unsupported', 'The AI model is not supported.'],
    ['timeout', 'The AI provider request timed out.'],
    ['rate_limited', 'The AI provider rate limit was reached.'],
    ['schema_invalid', 'The AI provider returned an invalid response.'],
    ['cancelled', GENERIC_PROVIDER_ERROR_MESSAGE],
    ['provider_error', GENERIC_PROVIDER_ERROR_MESSAGE],
  ] as const)('uses a host-owned summary for provider code %s', (code, expectedMessage) => {
    const normalized = core.normalizeAiProviderError({
      code,
      message: PRIVATE_PROVIDER_MARKER,
      retryable: true,
      costKnown: true,
      retryAfterMs: 2500,
      cause: new Error(PRIVATE_PROVIDER_MARKER),
      responseBody: PRIVATE_PROVIDER_MARKER,
    });

    expect(normalized).toEqual({
      code: code === 'cancelled' ? 'provider_error' : code,
      message: expectedMessage,
      retryable: true,
      costKnown: true,
      retryAfterMs: 2500,
    });
    expect(JSON.stringify(normalized)).not.toContain(PRIVATE_PROVIDER_MARKER);
  });

  it.each([
    ['constructor', { marker: PRIVATE_PROVIDER_MARKER }, PRIVATE_PROVIDER_MARKER, Number.POSITIVE_INFINITY],
    ['__proto__', PRIVATE_PROVIDER_MARKER, { marker: PRIVATE_PROVIDER_MARKER }, -1],
  ])('keeps AiProviderRequestError safe for hostile JavaScript data with code %s', (
    code,
    retryable,
    costKnown,
    retryAfterMs,
  ) => {
    const error = new core.AiProviderRequestError({
      code,
      message: PRIVATE_PROVIDER_MARKER,
      retryable,
      costKnown,
      retryAfterMs,
      cause: new Error(PRIVATE_PROVIDER_MARKER),
      responseBody: PRIVATE_PROVIDER_MARKER,
    } as never);

    expect(error).toMatchObject({
      code: 'provider_error',
      message: GENERIC_PROVIDER_ERROR_MESSAGE,
      retryable: false,
      costKnown: false,
    });
    expect(error.retryAfterMs).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(PRIVATE_PROVIDER_MARKER);
  });

  it('does not write provider errors or response bodies to ordinary logs', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const ai = servicesWith(async () => {
        const error = new Error(PRIVATE_PROVIDER_MARKER, { cause: PRIVATE_PROVIDER_MARKER });
        Object.assign(error, { responseBody: PRIVATE_PROVIDER_MARKER });
        throw error;
      });

      const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
      await ai.waitForGenerationTask(submitted.id);

      expect(JSON.stringify([errorLog, warningLog, infoLog].flatMap((spy) => spy.mock.calls))).not.toContain(
        PRIVATE_PROVIDER_MARKER,
      );
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  it('replaces overlong provider diagnostics with the fixed bounded summary', () => {
    expect(core.redactAiDiagnosticText(PRIVATE_PROVIDER_MARKER.repeat(10_000))).toBe(
      GENERIC_PROVIDER_ERROR_MESSAGE,
    );
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
    expect(completed.error?.message).toBe('The AI provider rate limit was reached.');
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
