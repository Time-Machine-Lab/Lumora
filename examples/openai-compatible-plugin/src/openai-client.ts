import {
  AiProviderRequestError,
  type AiChatMessage,
  type AiProviderErrorCode,
  type StoryboardGenerateRequest,
} from '@lumora/plugin-sdk';
import { normalizeChatCompletionsEndpoint, normalizeModelName, ProviderConfigurationError } from './config';

export interface OpenAiRuntimeConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export type OpenAiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
  readonly fetchImpl?: OpenAiFetch;
  readonly signal?: AbortSignal;
  readonly lifecycleSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CHAT_MESSAGES = 100;

function providerError(
  code: AiProviderErrorCode,
  retryable = false,
  retryAfterMs?: number,
): AiProviderRequestError {
  return new AiProviderRequestError({
    code,
    message: 'OpenAI-compatible request failed.',
    retryable,
    costKnown: false,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 86_400_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), 86_400_000);
}

function httpError(response: Response): AiProviderRequestError {
  if (response.status === 401 || response.status === 403) return providerError('authentication_failed');
  if (response.status === 404) return providerError('model_unsupported');
  if (response.status === 408) return providerError('timeout', true);
  if (response.status === 429) return providerError('rate_limited', true, retryAfterMs(response));
  if (response.status >= 500) return providerError('provider_unavailable', true);
  if (response.status >= 400 && response.status < 500) return providerError('invalid_request');
  return providerError('provider_error');
}

function completionContent(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw providerError('schema_invalid');
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw providerError('schema_invalid');
  const first = choices[0];
  if (typeof first !== 'object' || first === null) throw providerError('schema_invalid');
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) throw providerError('schema_invalid');
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) throw providerError('schema_invalid');
  return content;
}

function normalizedConfig(config: OpenAiRuntimeConfig): OpenAiRuntimeConfig {
  try {
    return {
      endpoint: normalizeChatCompletionsEndpoint(config.endpoint),
      model: normalizeModelName(config.model),
      apiKey: config.apiKey,
    };
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw providerError('invalid_request');
    throw error;
  }
}

function projectChatMessages(messages: unknown): ReadonlyArray<AiChatMessage> {
  try {
    if (!Array.isArray(messages)) throw new Error();
    const expectedLength = messages.length;
    if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_CHAT_MESSAGES) throw new Error();
    const projected: AiChatMessage[] = [];
    for (const message of messages) {
      if (projected.length >= expectedLength) throw new Error();
      if (typeof message !== 'object' || message === null) throw new Error();
      const role = (message as { role?: unknown }).role;
      const content = (message as { content?: unknown }).content;
      if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error();
      if (typeof content !== 'string') throw new Error();
      projected.push({ role, content });
    }
    if (projected.length !== expectedLength) throw new Error();
    return projected;
  } catch {
    throw providerError('invalid_request');
  }
}

function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    void response.json().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export async function requestOpenAiChat(
  configInput: OpenAiRuntimeConfig,
  messages: ReadonlyArray<AiChatMessage>,
  options: RequestOptions = {},
): Promise<string> {
  const config = normalizedConfig(configInput);
  const projectedMessages = projectChatMessages(messages);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const externalSignals = [options.signal, options.lifecycleSignal].filter((signal): signal is AbortSignal => !!signal);
  let externallyAborted = false;
  let timedOut = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  for (const signal of externalSignals) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  if (externallyAborted) {
    for (const signal of externalSignals) signal.removeEventListener('abort', onExternalAbort);
    throw providerError('cancelled');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: projectedMessages,
        temperature: 0.2,
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      }),
      signal: controller.signal,
    });
    if (externallyAborted) throw providerError('cancelled');
    if (timedOut) throw providerError('timeout', true);
    if (!response.ok) throw httpError(response);
    let envelope: unknown;
    try {
      envelope = await readResponseJson(response, controller.signal);
    } catch (error) {
      if (externallyAborted) throw providerError('cancelled');
      if (timedOut) throw providerError('timeout', true);
      if (error instanceof SyntaxError) throw providerError('schema_invalid');
      throw providerError('network_error', true);
    }
    if (externallyAborted) throw providerError('cancelled');
    if (timedOut) throw providerError('timeout', true);
    return completionContent(envelope);
  } catch (error) {
    if (externallyAborted) throw providerError('cancelled');
    if (timedOut) throw providerError('timeout', true);
    if (error instanceof AiProviderRequestError) throw error;
    throw providerError('network_error', true);
  } finally {
    clearTimeout(timer);
    for (const signal of externalSignals) signal.removeEventListener('abort', onExternalAbort);
  }
}

function storyboardSystemPrompt(shotCount: number): string {
  return [
    'Return only one JSON object for a structured storyboard.',
    'The object must contain title, summary, and shots.',
    `shots must contain exactly ${shotCount} items.`,
    'Every shot must contain title, shotSize, movement, durationSeconds, and prompt.',
    'shotSize must be one of: extreme-wide, wide, medium, close-up, extreme-close-up.',
    'movement must be one of: static, pan, tilt, dolly-in, dolly-out, tracking, orbit, handheld.',
    'Do not use Markdown or code fences.',
  ].join(' ');
}

function parseStoryboardContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    throw providerError('schema_invalid');
  }
}

export async function generateOpenAiStoryboard(
  request: StoryboardGenerateRequest,
  config: OpenAiRuntimeConfig,
  options: Omit<RequestOptions, 'signal'> = {},
): Promise<unknown> {
  if (request.model !== normalizeModelName(config.model)) throw providerError('model_unsupported');
  const content = await requestOpenAiChat(config, [
    { role: 'system', content: storyboardSystemPrompt(request.brief.shotCount) },
    { role: 'user', content: JSON.stringify(request.brief) },
  ], { ...options, signal: request.signal });
  if (request.signal.aborted) throw providerError('cancelled');
  return parseStoryboardContent(content);
}

export async function testOpenAiConnection(
  config: OpenAiRuntimeConfig,
  options: RequestOptions = {},
): Promise<{ ok: true }> {
  await requestOpenAiChat(config, [
    { role: 'system', content: 'Reply with OK.' },
    { role: 'user', content: 'Connection test' },
  ], { ...options, maxTokens: 1 });
  return { ok: true };
}
