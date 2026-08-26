import { describe, expect, it, vi } from 'vitest';
import type { CreativeBrief } from '@lumora/plugin-sdk';
import {
  generateOpenAiStoryboard,
  requestOpenAiChat,
  testOpenAiConnection,
  type OpenAiFetch,
  type OpenAiRuntimeConfig,
} from '../src/openai-client';

const CONFIG: OpenAiRuntimeConfig = {
  endpoint: 'https://compatible.example/v1/chat/completions',
  model: 'vendor/storyboard-v2',
  apiKey: 'sk-runtime-only-marker',
};

const BRIEF: CreativeBrief = {
  concept: 'A courier crosses a rain-soaked neon market to deliver a mysterious case.',
  targetDurationSeconds: 12,
  shotCount: 3,
  visualStyle: 'Grounded cinematic sci-fi',
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

function completion(content: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('OpenAI-compatible Chat Completions client', () => {
  it('sends the configured endpoint, model, structured prompt, and optional Bearer key once', async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () => completion(JSON.stringify(VALID_DRAFT)));

    const result = await generateOpenAiStoryboard(
      { model: CONFIG.model, brief: BRIEF, signal: new AbortController().signal },
      CONFIG,
      { fetchImpl },
    );

    expect(result).toEqual(VALID_DRAFT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init = {}] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CONFIG.endpoint);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-runtime-only-marker');
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'temperature']);
    expect(body.model).toBe('vendor/storyboard-v2');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('api_key');
    expect(String(init.body)).not.toContain(CONFIG.apiKey);
    expect(body.messages.map((message: Record<string, unknown>) => Object.keys(message).sort()))
      .toEqual([['content', 'role'], ['content', 'role']]);
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    expect(body.messages[1].content).toContain(BRIEF.concept);
    expect(body.messages[1].content).toContain('"shotCount":3');
  });

  it('omits Authorization for an empty key and parses a standard chat response', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return completion('Connection OK');
    });

    await expect(requestOpenAiChat(
      { ...CONFIG, apiKey: '' },
      [{ role: 'user', content: 'ping' }],
      { fetchImpl },
    )).resolves.toBe('Connection OK');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('projects messages to exact role and content fields before serialization', async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () => completion('Connection OK'));
    const message: Record<string, unknown> = {
      role: 'user',
      content: 'ping',
      secret: 'PRIVATE_MESSAGE_FIELD',
      counter: 1n,
    };
    message.circular = message;

    await expect(requestOpenAiChat(CONFIG, [message] as never, { fetchImpl })).resolves.toBe('Connection OK');

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain('PRIVATE_MESSAGE_FIELD');
  });

  it.each([
    ['unsupported role', () => [{ role: 'tool', content: 'ping' }]],
    ['non-string content', () => [{ role: 'user', content: 7 }]],
    ['non-array messages', () => ({ role: 'user', content: 'ping' })],
    ['throwing iterator', () => new Proxy([{ role: 'user', content: 'ping' }], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('PRIVATE_MESSAGE_ITERATOR');
        return Reflect.get(target, property, receiver);
      },
    })],
    ['over-yielding iterator', () => Object.assign([{ role: 'user', content: 'ping' }], {
      *[Symbol.iterator]() {
        yield { role: 'user', content: 'ping' };
        yield { role: 'assistant', content: 'unexpected' };
      },
    })],
    ['under-yielding iterator', () => Object.assign([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ], {
      *[Symbol.iterator]() {
        yield { role: 'user', content: 'ping' };
      },
    })],
  ] as const)('rejects %s as invalid_request before fetch', async (_name, messages) => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () => completion('should not run'));
    const outcome = requestOpenAiChat(CONFIG, messages() as never, { fetchImpl });

    await expect(outcome).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'The AI request is invalid.',
      retryable: false,
    });
    await expect(outcome).rejects.not.toThrow(/PRIVATE_MESSAGE_ITERATOR/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'authentication_failed'],
    [403, 'authentication_failed'],
    [404, 'model_unsupported'],
    [408, 'timeout'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('maps HTTP %s without consuming or exposing the response body', async (status, code) => {
    const response = new Response('PRIVATE_PROVIDER_BODY', {
      status,
      headers: status === 429 ? { 'Retry-After': '3' } : undefined,
    });
    const text = vi.spyOn(response, 'text');
    const json = vi.spyOn(response, 'json');
    const fetchImpl = vi.fn(async () => response);

    const outcome = requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], { fetchImpl });

    await expect(outcome).rejects.toMatchObject({ code });
    await expect(outcome).rejects.not.toThrow(/PRIVATE_PROVIDER_BODY|sk-runtime-only-marker/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('maps browser network or CORS failures without exposing native error text', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch PRIVATE_CORS_DETAIL'); });
    const outcome = requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], { fetchImpl });

    await expect(outcome).rejects.toMatchObject({ code: 'network_error' });
    await expect(outcome).rejects.not.toThrow(/PRIVATE_CORS_DETAIL|sk-runtime-only-marker/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps invalid response JSON syntax to non-retryable schema_invalid', async () => {
    await expect(requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl: vi.fn(async () => new Response('{not-json', { status: 200 })),
    })).rejects.toMatchObject({ code: 'schema_invalid', retryable: false });
  });

  it('maps response body transport failures to retryable network_error without leaking details', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('PRIVATE_BODY_STREAM_FAILURE'));
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const outcome = requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl: vi.fn(async () => response),
    });

    await expect(outcome).rejects.toMatchObject({ code: 'network_error', retryable: true });
    await expect(outcome).rejects.not.toThrow(/PRIVATE_BODY_STREAM_FAILURE/);
  });

  it('maps malformed success envelopes and content to schema_invalid', async () => {

    await expect(requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })),
    })).rejects.toMatchObject({ code: 'schema_invalid' });

    await expect(generateOpenAiStoryboard(
      { model: CONFIG.model, brief: BRIEF, signal: new AbortController().signal },
      CONFIG,
      { fetchImpl: vi.fn(async () => completion('not-json')) },
    )).rejects.toMatchObject({ code: 'schema_invalid' });
  });

  it('maps its deadline to timeout and external abort to cancelled with no late success', async () => {
    const hangingFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await expect(requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const cancelled = requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl: hangingFetch,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    expect(hangingFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['caller abort', 'caller', 'cancelled'],
    ['lifecycle abort', 'lifecycle', 'cancelled'],
    ['deadline', 'deadline', 'timeout'],
  ] as const)('preserves %s while the response body is still being read', async (_label, trigger, code) => {
    const caller = new AbortController();
    const lifecycle = new AbortController();
    let resolveBody!: (value: unknown) => void;
    let markBodyReadSettled!: () => void;
    const bodyReadSettled = new Promise<void>((resolve) => { markBodyReadSettled = resolve; });
    const response = completion(JSON.stringify(VALID_DRAFT));
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    }).finally(markBodyReadSettled);
    vi.spyOn(response, 'json').mockImplementation(() => body);
    const fetchImpl = vi.fn<OpenAiFetch>(async () => response);
    const outcome = requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl,
      signal: caller.signal,
      lifecycleSignal: lifecycle.signal,
      timeoutMs: trigger === 'deadline' ? 5 : 1_000,
    });
    const rejection = expect(outcome).rejects.toMatchObject({ code });
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledTimes(1));

    if (trigger === 'caller') caller.abort();
    if (trigger === 'lifecycle') lifecycle.abort();

    await rejection;
    resolveBody({ choices: [{ message: { content: JSON.stringify(VALID_DRAFT) } }] });
    await bodyReadSettled;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('settles a body-stage deadline before an abort-ignoring late success arrives', async () => {
    let resolveBody!: (value: unknown) => void;
    let markBodyReadSettled!: () => void;
    const bodyReadSettled = new Promise<void>((resolve) => { markBodyReadSettled = resolve; });
    const response = completion(JSON.stringify(VALID_DRAFT));
    vi.spyOn(response, 'json').mockImplementation(() => new Promise((resolve) => {
      resolveBody = resolve;
    }).finally(markBodyReadSettled));

    const outcome = requestOpenAiChat(CONFIG, [{ role: 'user', content: 'ping' }], {
      fetchImpl: vi.fn(async () => response),
      timeoutMs: 5,
    });

    await expect(outcome).rejects.toMatchObject({ code: 'timeout' });
    resolveBody({ choices: [{ message: { content: JSON.stringify(VALID_DRAFT) } }] });
    await bodyReadSettled;
    expect(response.json).toHaveBeenCalledTimes(1);
  });

  it('tests the current connection through the same sanitized protocol path', async () => {
    const fetchImpl = vi.fn<OpenAiFetch>(async () => completion('OK'));

    await expect(testOpenAiConnection(CONFIG, { fetchImpl })).resolves.toEqual({ ok: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(CONFIG.apiKey);
    expect(body.model).toBe(CONFIG.model);
    expect(body.max_tokens).toBe(1);
  });
});
