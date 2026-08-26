import { useEffect, useRef, useState } from 'react';
import type { AiProviderErrorCode, EventMap, TypedEventEmitter } from '@lumora/core';
import {
  normalizeChatCompletionsEndpoint,
  normalizeModelName,
  type ProviderConfigStore,
} from './config';
import { testOpenAiConnection } from './openai-client';

interface SettingsPanelProps {
  pluginId: string;
  events: Pick<TypedEventEmitter<EventMap>, 'emit'>;
  configStore: ProviderConfigStore;
  lifecycleSignal: AbortSignal;
}

type Feedback = { kind: 'status' | 'error'; text: string } | null;

function errorCode(error: unknown): AiProviderErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value as AiProviderErrorCode
    : undefined;
}

function connectionErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'invalid_request': return 'URL 或模型配置无效，请检查后重试。';
    case 'authentication_failed': return '鉴权失败，请检查 API Key。';
    case 'model_unsupported': return '端点不存在或模型不受支持。';
    case 'timeout': return '连接超时，请检查端点状态。';
    case 'rate_limited': return '请求被限流，请稍后手动重试。';
    case 'provider_unavailable': return '兼容服务暂不可用。';
    case 'network_error': return '浏览器无法连接端点，请检查网络与 CORS 配置。';
    case 'schema_invalid': return '端点响应不是有效的 Chat Completions 结构。';
    case 'cancelled': return '连接测试已取消。';
    default: return error instanceof Error ? error.message : '连接测试失败。';
  }
}

export function OpenAiSettingsPanel({ pluginId, events, configStore, lifecycleSignal }: SettingsPanelProps) {
  const initial = configStore.getSnapshot();
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const lastSnapshot = useRef(initial);

  useEffect(() => configStore.subscribe(() => {
    const snapshot = configStore.getSnapshot();
    const previous = lastSnapshot.current;
    if (snapshot.endpoint !== previous.endpoint) setEndpoint(snapshot.endpoint);
    if (snapshot.model !== previous.model) setModel(snapshot.model);
    setApiKey(snapshot.apiKey);
    lastSnapshot.current = snapshot;
  }), [configStore]);

  const validatedForm = () => ({
    endpoint: normalizeChatCompletionsEndpoint(endpoint),
    model: normalizeModelName(model),
    apiKey,
  });

  const save = () => {
    try {
      const saved = configStore.save(validatedForm());
      setEndpoint(saved.endpoint);
      setModel(saved.model);
      setFeedback({ kind: 'status', text: '已保存端点和模型；API Key 仅保留在本次运行内存中。' });
      events.emit('contribution:changed', { pluginId });
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : '设置无效。' });
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setFeedback({ kind: 'status', text: '正在测试连接…' });
    try {
      await testOpenAiConnection(validatedForm(), { lifecycleSignal });
      setFeedback({ kind: 'status', text: '连接成功，端点返回了有效的 Chat Completions 响应。' });
    } catch (error) {
      setFeedback({ kind: 'error', text: connectionErrorText(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="lumora-openai-settings" data-testid="openai-compatible-settings">
      <header>
        <h2>OpenAI 兼容设置</h2>
        <span>文本 Provider</span>
      </header>
      <p className="lumora-openai-settings__notice">
        浏览器会直接请求该端点；服务必须允许当前站点的 CORS 请求。远程服务仅允许 HTTPS，本机开发可使用 localhost 或回环 HTTP。
      </p>
      <div className="lumora-openai-settings__fields">
        <label>
          <span>Chat Completions 端点</span>
          <input
            aria-label="Chat Completions 端点"
            value={endpoint}
            disabled={testing}
            inputMode="url"
            spellCheck={false}
            data-testid="openai-endpoint"
            onChange={(event) => { setEndpoint(event.target.value); setFeedback(null); }}
          />
        </label>
        <label>
          <span>模型</span>
          <input
            aria-label="模型"
            value={model}
            disabled={testing}
            spellCheck={false}
            data-testid="openai-model"
            onChange={(event) => { setModel(event.target.value); setFeedback(null); }}
          />
        </label>
        <label>
          <span>API Key（仅本次运行）</span>
          <input
            aria-label="API Key（仅本次运行）"
            type="password"
            value={apiKey}
            disabled={testing}
            autoComplete="off"
            spellCheck={false}
            data-testid="openai-api-key"
            onChange={(event) => { setApiKey(event.target.value); setFeedback(null); }}
          />
          <small>可留空。Key 不写入工程、浏览器存储、导出文件、事件或日志。</small>
        </label>
      </div>
      <div className="lumora-openai-settings__actions">
        <button type="button" className="lumora-button" disabled={testing} onClick={save}>保存设置</button>
        <button type="button" className="lumora-button lumora-openai-settings__test" disabled={testing} onClick={() => void testConnection()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button
          type="button"
          className="lumora-button"
          disabled={testing || !apiKey}
          onClick={() => {
            configStore.clearApiKey();
            setApiKey('');
            setFeedback({ kind: 'status', text: 'API Key 已从运行时内存清除。' });
          }}
        >
          清除 Key
        </button>
      </div>
      {feedback && (
        <p
          className={`lumora-openai-settings__feedback is-${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
    </section>
  );
}
