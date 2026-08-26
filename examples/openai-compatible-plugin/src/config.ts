export const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_MODEL = 'gpt-4o-mini';
export const OPENAI_COMPATIBLE_STORAGE_KEY = 'lumora.plugin.openai-compatible.settings.v1';

export interface OpenAiProviderConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type ConfigListener = () => void;

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const parts = normalized.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part));
}

export function normalizeChatCompletionsEndpoint(input: string): string {
  const value = input.trim();
  if (!value) throw new ProviderConfigurationError('请输入 Chat Completions 端点。');
  if (value.length > 2_048) throw new ProviderConfigurationError('端点长度不能超过 2048 个字符。');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigurationError('端点必须是有效的绝对 URL。');
  }
  if (url.username || url.password) {
    throw new ProviderConfigurationError('端点不能包含用户名或密码。');
  }
  if (url.search || url.hash) {
    throw new ProviderConfigurationError('端点不能包含查询参数或片段。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ProviderConfigurationError('端点必须使用 HTTPS；仅 localhost 或回环地址允许 HTTP。');
  }

  const path = url.pathname.replace(/\/+$/g, '');
  if (!path.toLowerCase().endsWith('/chat/completions')) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = path;
  }
  return url.toString();
}

export function normalizeModelName(input: string): string {
  const model = input.trim();
  if (!model) throw new ProviderConfigurationError('请输入模型名称。');
  if (model.length > 160) throw new ProviderConfigurationError('模型名称不能超过 160 个字符。');
  if ([...model].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) {
    throw new ProviderConfigurationError('模型名称不能包含控制字符。');
  }
  return model;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export class ProviderConfigStore {
  private readonly storage?: StorageLike;
  private snapshot: OpenAiProviderConfig = {
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    apiKey: '',
  };
  private readonly listeners = new Set<ConfigListener>();

  constructor(storage: StorageLike | undefined = defaultStorage()) {
    this.storage = storage;
  }

  activate(): void {
    let endpoint = DEFAULT_ENDPOINT;
    let model = DEFAULT_MODEL;
    try {
      const raw = this.storage?.getItem(OPENAI_COMPATIBLE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { endpoint?: unknown; model?: unknown };
        if (typeof parsed.endpoint !== 'string' || typeof parsed.model !== 'string') {
          throw new ProviderConfigurationError('Stored settings are invalid.');
        }
        endpoint = normalizeChatCompletionsEndpoint(parsed.endpoint);
        model = normalizeModelName(parsed.model);
      }
    } catch {
      endpoint = DEFAULT_ENDPOINT;
      model = DEFAULT_MODEL;
    }
    this.snapshot = { endpoint, model, apiKey: '' };
    this.notify();
  }

  save(input: OpenAiProviderConfig): OpenAiProviderConfig {
    const next: OpenAiProviderConfig = {
      endpoint: normalizeChatCompletionsEndpoint(input.endpoint),
      model: normalizeModelName(input.model),
      apiKey: input.apiKey,
    };
    const persisted = JSON.stringify({ endpoint: next.endpoint, model: next.model });
    try {
      this.storage?.setItem(OPENAI_COMPATIBLE_STORAGE_KEY, persisted);
    } catch {
      throw new ProviderConfigurationError('浏览器无法保存端点和模型设置。');
    }
    this.snapshot = next;
    this.notify();
    return this.getSnapshot();
  }

  clearApiKey(): void {
    if (!this.snapshot.apiKey) return;
    this.snapshot = { ...this.snapshot, apiKey: '' };
    this.notify();
  }

  deactivate(): void {
    this.snapshot = { ...this.snapshot, apiKey: '' };
    this.notify();
    this.listeners.clear();
  }

  getSnapshot(): OpenAiProviderConfig {
    return { ...this.snapshot };
  }

  subscribe(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
