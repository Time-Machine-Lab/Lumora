import {
  AI_STORYBOARD_GENERATE_CAPABILITY,
  definePlugin,
  disposable,
  type AiChatRequest,
  type PanelContextProps,
  type PluginDefinition,
  type StoryboardGenerateRequest,
} from '@lumora/plugin-sdk';
import { ProviderConfigStore } from './config';
import { OpenAiSettingsPanel } from './SettingsPanel';
import { generateOpenAiStoryboard, requestOpenAiChat } from './openai-client';
import { ProviderRuntime } from './runtime';
import './style.css';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'com.lumora.openai.compatible.ai';

export function createOpenAiCompatiblePlugin(
  createConfigStore: () => ProviderConfigStore = () => new ProviderConfigStore(),
): PluginDefinition {
  return definePlugin({
    activate(context) {
      const configStore = createConfigStore();
      const runtime = new ProviderRuntime();
      configStore.activate();

      async function* compatibleChat(request: AiChatRequest): AsyncIterable<string> {
        const content = await requestOpenAiChat(configStore.getSnapshot(), request.messages, {
          signal: request.signal,
          lifecycleSignal: runtime.signal,
        });
        yield content;
      }

      function generateStoryboard(request: StoryboardGenerateRequest): Promise<unknown> {
        return generateOpenAiStoryboard(request, configStore.getSnapshot(), {
          lifecycleSignal: runtime.signal,
        });
      }

      function SettingsPanel(props: PanelContextProps) {
        return (
          <OpenAiSettingsPanel
            {...props}
            configStore={configStore}
            lifecycleSignal={runtime.signal}
          />
        );
      }

      context.contribute({
        panels: [{
          kind: 'panel',
          id: 'com.lumora.openai.compatible.settings',
          title: 'OpenAI 设置',
          position: 'left',
          component: SettingsPanel,
        }],
        aiProviders: [{
          kind: 'aiProvider',
          id: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'OpenAI 兼容',
          models: [configStore.getSnapshot().model],
          chat: compatibleChat,
          storyboard: {
            capability: AI_STORYBOARD_GENERATE_CAPABILITY,
            models: () => [{
              id: configStore.getSnapshot().model,
              name: configStore.getSnapshot().model,
              cost: { kind: 'unknown', note: '兼容端点未提供请求前费用信息。' },
            }],
            generate: generateStoryboard,
          },
        }],
      });

      return disposable(() => {
        runtime.deactivate();
        configStore.deactivate();
      });
    },
  });
}

const definition = createOpenAiCompatiblePlugin();

export default definition;
