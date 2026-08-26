import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiSettingsPanel } from '../src/SettingsPanel';
import { OPENAI_COMPATIBLE_STORAGE_KEY, ProviderConfigStore } from '../src/config';

describe('OpenAI-compatible settings panel', () => {
  let configStore: ProviderConfigStore;
  let lifecycleController: AbortController;

  beforeEach(() => {
    localStorage.clear();
    configStore = new ProviderConfigStore({
      get: (key) => localStorage.getItem(`settings-panel:${key}`),
      set: (key, value) => localStorage.setItem(`settings-panel:${key}`, value),
    });
    configStore.activate();
    lifecycleController = new AbortController();
    vi.unstubAllGlobals();
  });

  const renderPanel = (emit = vi.fn()) => {
    render(
      <OpenAiSettingsPanel
        pluginId="com.lumora.openai.compatible"
        events={{ emit }}
        configStore={configStore}
        lifecycleSignal={lifecycleController.signal}
      />,
    );
    return emit;
  };

  it('provides discoverable validated settings, a runtime-only password, and a CORS notice', () => {
    const emit = vi.fn();
    renderPanel(emit);

    expect(screen.getByRole('heading', { name: 'OpenAI 兼容设置' })).toBeInTheDocument();
    expect(screen.getByLabelText('API Key（仅本次运行）')).toHaveAttribute('type', 'password');
    expect(screen.getByText(/CORS/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Chat Completions 端点'), { target: { value: 'http://remote.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(screen.getByRole('alert')).toHaveTextContent('HTTPS');
    expect(emit).not.toHaveBeenCalled();
  });

  it('saves only endpoint/model, refreshes neutral contributions, and keeps the key in memory', () => {
    const emit = vi.fn();
    renderPanel(emit);
    fireEvent.change(screen.getByLabelText('Chat Completions 端点'), { target: { value: 'https://vendor.example/v1' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'vendor/custom-model' } });
    fireEvent.change(screen.getByLabelText('API Key（仅本次运行）'), { target: { value: 'sk-panel-runtime-marker' } });

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(screen.getByRole('status')).toHaveTextContent('已保存');
    expect(configStore.getSnapshot()).toMatchObject({
      endpoint: 'https://vendor.example/v1/chat/completions',
      model: 'vendor/custom-model',
      apiKey: 'sk-panel-runtime-marker',
    });
    expect(localStorage.getItem(`settings-panel:${OPENAI_COMPATIBLE_STORAGE_KEY}`)).not.toContain('sk-panel-runtime-marker');
    expect(emit).toHaveBeenCalledWith('contribution:changed', { pluginId: 'com.lumora.openai.compatible' });
  });

  it('shows immediate sanitized connection feedback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 })));
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接成功'));
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
  });
});
