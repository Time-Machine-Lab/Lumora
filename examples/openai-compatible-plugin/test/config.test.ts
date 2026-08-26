import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  OPENAI_COMPATIBLE_STORAGE_KEY,
  ProviderConfigStore,
  normalizeChatCompletionsEndpoint,
} from '../src/config';

describe('OpenAI-compatible provider configuration', () => {
  beforeEach(() => localStorage.clear());

  const scopedStorageKey = `test-provider:${OPENAI_COMPATIBLE_STORAGE_KEY}`;
  const settings = {
    get: (key: string) => localStorage.getItem(`test-provider:${key}`),
    set: (key: string, value: string) => localStorage.setItem(`test-provider:${key}`, value),
  };

  it.each([
    ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
    ['http://127.0.0.1:8080/api', 'http://127.0.0.1:8080/api/chat/completions'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1/chat/completions'],
  ])('normalizes %s to a permitted Chat Completions endpoint', (input, expected) => {
    expect(normalizeChatCompletionsEndpoint(input)).toBe(expected);
  });

  it.each([
    'http://api.example.com/v1',
    'ftp://api.example.com/v1',
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?api_key=secret',
    'https://api.example.com/v1#fragment',
    'not a URL',
  ])('rejects unsafe or ambiguous endpoint %s', (input) => {
    expect(() => normalizeChatCompletionsEndpoint(input)).toThrow();
  });

  it('persists only normalized endpoint and model while clearing the key on deactivation', () => {
    const store = new ProviderConfigStore(settings);
    store.activate();
    expect(store.getSnapshot()).toEqual({ endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, apiKey: '' });

    store.save({
      endpoint: 'https://compatible.example/v1/',
      model: 'vendor/custom-model',
      apiKey: 'sk-runtime-only-marker',
    });

    const persisted = localStorage.getItem(scopedStorageKey) ?? '';
    expect(JSON.parse(persisted)).toEqual({
      endpoint: 'https://compatible.example/v1/chat/completions',
      model: 'vendor/custom-model',
    });
    expect(persisted).not.toContain('sk-runtime-only-marker');
    expect(store.getSnapshot().apiKey).toBe('sk-runtime-only-marker');

    store.deactivate();
    expect(store.getSnapshot().apiKey).toBe('');

    const restored = new ProviderConfigStore(settings);
    restored.activate();
    expect(restored.getSnapshot()).toEqual({
      endpoint: 'https://compatible.example/v1/chat/completions',
      model: 'vendor/custom-model',
      apiKey: '',
    });
  });

  it('does not replace a valid runtime snapshot with malformed stored data', () => {
    localStorage.setItem(scopedStorageKey, JSON.stringify({
      endpoint: 'http://remote.example/v1',
      model: '',
      apiKey: 'persisted-secret',
    }));
    const store = new ProviderConfigStore(settings);

    store.activate();

    expect(store.getSnapshot()).toEqual({ endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, apiKey: '' });
    expect(JSON.stringify(store.getSnapshot())).not.toContain('persisted-secret');
  });
});
