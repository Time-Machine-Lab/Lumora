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

const DIAGNOSTIC_QUOTE_WRAPPERS = [
  ['raw', '"'],
  ['escaped', '\\"'],
] as const;

const DIAGNOSTIC_DELIMITERS = [
  ['comma', ','],
  ['semicolon', ';'],
  ['line break', '\n'],
] as const;

const SERIALIZED_DIAGNOSTIC_CASES = DIAGNOSTIC_QUOTE_WRAPPERS.flatMap(([keyKind, keyQuote]) =>
  DIAGNOSTIC_QUOTE_WRAPPERS.flatMap(([valueKind, valueQuote]) =>
    DIAGNOSTIC_DELIMITERS.map(([delimiterKind, delimiter]) => ({
      name: `${keyKind} key, ${valueKind} value, ${delimiterKind}`,
      keyQuote,
      valueQuote,
      delimiter,
    })),
  ),
);

function serializedCredentialDiagnostic(
  keyQuote: string,
  valueQuote: string,
  delimiter: string,
  privateMarker: string,
): string {
  return `${keyQuote}apiKey${keyQuote}:${valueQuote}prefix${delimiter} ${privateMarker}${valueQuote}; status=401`;
}

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

  it('redacts credential fragments cut off by the provider diagnostic length cap', async () => {
    const credentialFragmentAtBoundary = `${'x'.repeat(1_989)} sk-1234567`;
    const ai = servicesWith(async () => { throw new Error(`${credentialFragmentAtBoundary}890abcdef`); });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.error?.message).not.toContain('sk-1234567');
    expect(completed.error?.message).toContain('[REDACTED]');
  });

  it('redacts a quoted multi-word credential cut off by the provider diagnostic length cap', async () => {
    const credential = 'TOP SECRET TOKEN WITH MORE DATA';
    const ai = servicesWith(async () => {
      throw new Error(`${'x'.repeat(1_975)} apiKey="${credential}"`);
    });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.error?.message).toContain('[REDACTED]');
    expect(completed.error?.message).not.toContain('SECRET');
    expect(completed.error?.message.length).toBeLessThanOrEqual(2_000);
  });

  it('redacts a truncated quoted credential containing diagnostic delimiters', async () => {
    const credential = 'TOP, SECRET; TOKEN WITH MORE DATA';
    const ai = servicesWith(async () => {
      throw new Error(`${'x'.repeat(1_970)} apiKey="${credential}"`);
    });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.error?.message).toContain('[REDACTED]');
    expect(completed.error?.message).not.toContain('SECRET');
    expect(completed.error?.message).not.toContain('TOKEN');
    expect(completed.error?.message.length).toBeLessThanOrEqual(2_000);
  });

  it('redacts an unquoted multi-word credential at the provider diagnostic length cap', async () => {
    const credential = 'TOP SECRET TOKEN WITH MORE DATA';
    const ai = servicesWith(async () => {
      throw new Error(`${'x'.repeat(1_968)} apiKey=${credential}`);
    });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.error?.message).toContain('[REDACTED]');
    expect(completed.error?.message).not.toContain('SECRET');
    expect(completed.error?.message.length).toBeLessThanOrEqual(2_000);
  });

  it('preserves public diagnostics after complete credential assignments', () => {
    expect(core.redactAiDiagnosticText('apiKey="TOP, SECRET"; status=401')).toBe(
      'apiKey=[REDACTED]; status=401',
    );
    expect(core.redactAiDiagnosticText('apiKey=TOP SECRET; status=401')).toBe(
      'apiKey=[REDACTED]; status=401',
    );
  });

  it.each([
    ['comma', ','],
    ['semicolon', ';'],
    ['line break', '\n'],
  ])('redacts an escaped quote before a %s in direct diagnostics', (_name, delimiter) => {
    const privateTail = 'PRIVATE_ESCAPED_QUOTE_TAIL';
    const message = `apiKey="prefix\\"${delimiter} ${privateTail}"; status=401`;

    const redacted = core.redactAiDiagnosticText(message);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain(privateTail);
  });

  it('uses backslash parity to decide whether a quote closes a credential value', () => {
    const evenSlashes = `apiKey="prefix${'\\'.repeat(2)}"; status=401`;
    const privateTail = 'PRIVATE_ODD_SLASH_TAIL';
    const oddSlashes = `apiKey="prefix${'\\'.repeat(3)}", ${privateTail}"; status=401`;

    expect(core.redactAiDiagnosticText(evenSlashes)).toBe('apiKey=[REDACTED]; status=401');
    const oddRedacted = core.redactAiDiagnosticText(oddSlashes);
    expect(oddRedacted).toContain('[REDACTED]');
    expect(oddRedacted).not.toContain(privateTail);
    expect(oddRedacted).toContain('status=401');
  });

  it.each(SERIALIZED_DIAGNOSTIC_CASES)(
    'redacts serialized credential wrappers in direct diagnostics: $name',
    ({ keyQuote, valueQuote, delimiter }) => {
      const privateMarker = 'PRIVATE_SERIALIZED_DIRECT_MARKER';
      const redacted = core.redactAiDiagnosticText(
        serializedCredentialDiagnostic(keyQuote, valueQuote, delimiter, privateMarker),
      );

      expect(redacted).toContain('[REDACTED]');
      expect(redacted).not.toContain(privateMarker);
      expect(redacted).toContain('status=401');
    },
  );

  it.each(SERIALIZED_DIAGNOSTIC_CASES)(
    'redacts serialized credential wrappers during provider error normalization: $name',
    ({ keyQuote, valueQuote, delimiter }) => {
      const privateMarker = 'PRIVATE_SERIALIZED_NORMALIZED_MARKER';
      const normalized = core.normalizeAiProviderError(
        new Error(serializedCredentialDiagnostic(keyQuote, valueQuote, delimiter, privateMarker)),
      );

      expect(normalized.message).toContain('[REDACTED]');
      expect(normalized.message).not.toContain(privateMarker);
      expect(normalized.message).toContain('status=401');
    },
  );

  it.each(SERIALIZED_DIAGNOSTIC_CASES)(
    'redacts serialized credential wrappers across the GenerationTask boundary: $name',
    async ({ keyQuote, valueQuote, delimiter }) => {
      const privateMarker = 'PRIVATE_SERIALIZED_TASK_MARKER';
      const ai = servicesWith(async () => {
        throw new Error(serializedCredentialDiagnostic(keyQuote, valueQuote, delimiter, privateMarker));
      });
      const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
      const completed = await ai.waitForGenerationTask(submitted.id);

      expect(completed.status).toBe('failed');
      expect(completed.error?.message).toContain('[REDACTED]');
      expect(completed.error?.message).not.toContain(privateMarker);
      expect(completed.error?.message).toContain('status=401');
    },
  );

  it('bounds direct diagnostic redaction output', () => {
    expect(core.redactAiDiagnosticText('x'.repeat(2_500))).toHaveLength(2_000);
  });

  it.each([
    ['comma', ','],
    ['semicolon', ';'],
    ['line break', '\n'],
  ])('redacts an escaped quote before a %s across the provider diagnostic boundary', async (_name, delimiter) => {
    const privateTail = 'PRIVATE_BOUNDARY_TAIL';
    const ai = servicesWith(async () => {
      throw new Error(
        `${'x'.repeat(1_950)} apiKey="prefix\\"${delimiter} ${privateTail}${'y'.repeat(100)}"; status=401`,
      );
    });
    const submitted = ai.submitStoryboard('com.example.storyboard', { model: 'storyboard-1', brief: BRIEF });
    const completed = await ai.waitForGenerationTask(submitted.id);

    expect(completed.error?.message).toContain('[REDACTED]');
    expect(completed.error?.message).not.toContain(privateTail);
    expect(completed.error?.message.length).toBeLessThanOrEqual(2_000);
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
