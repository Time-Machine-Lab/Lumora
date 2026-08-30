import type { PluginInfo } from '@lumora/core';
import type { RefObject } from 'react';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { X } from 'lucide-react';
import { useEventRefresh } from '../hooks/use-event-refresh';
import { ModalDialog } from './ModalDialog';

interface PluginManagerProps {
  runtime: StudioRuntime;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const STATE_LABELS: Record<PluginInfo['state'], string> = {
  registered: '已注册',
  loading: '加载中',
  activating: '激活中',
  active: '运行中',
  deactivating: '停用中',
  inactive: '已停用',
  disabled: '已禁用',
  failed: '失败',
};

export function PluginManager({ runtime, onClose, returnFocusRef }: PluginManagerProps) {
  useEventRefresh(runtime.events, ['plugin:state-changed', 'contribution:changed']);
  const plugins = runtime.host.listPlugins();

  return (
    <ModalDialog
      dialogClassName="lumora-modal"
      backdropTestId="plugin-manager"
      ariaLabelledBy="plugin-manager-title"
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
        <header className="lumora-modal__header">
          <h2 id="plugin-manager-title">插件管理</h2>
          <button
            type="button"
            className="lumora-icon-button lumora-modal__close"
            data-testid="close-plugin-manager"
            aria-label="关闭插件管理"
            title="关闭插件管理"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <p className="lumora-modal__hint">插件代码在独立的错误隔离中运行；失败原因与停用入口见下表。</p>
        <ul className="lumora-plugin-list">
          {plugins.length === 0 && <li className="lumora-plugin-list__empty">尚未注册任何插件</li>}
          {plugins.map((plugin) => (
            // 记录键/操作一律使用稳定唯一的 instanceId；manifest id 仅展示
            <li
              key={plugin.instanceId}
              className="lumora-plugin-row"
              data-testid={`plugin-row-${plugin.instanceId}`}
            >
              <div className="lumora-plugin-row__main">
                <span className="lumora-plugin-row__name">
                  {plugin.name} <code>{plugin.id}</code>
                </span>
                <span className="lumora-plugin-row__meta">
                  v{plugin.version} · 贡献: {plugin.contributes.length > 0 ? plugin.contributes.join('、') : '无'}
                </span>
                <span
                  className={`lumora-state lumora-state--${plugin.state}`}
                  data-testid={`plugin-state-${plugin.instanceId}`}
                >
                  {STATE_LABELS[plugin.state]}
                </span>
              </div>
              {plugin.reason && (
                <p
                  className="lumora-plugin-row__reason"
                  data-testid={`plugin-reason-${plugin.instanceId}`}
                >
                  {String(plugin.reason)}
                </p>
              )}
              <div className="lumora-plugin-row__actions">
                {plugin.state === 'active' && (
                  <button
                    type="button"
                    className="lumora-button lumora-button--danger"
                    data-testid={`plugin-toggle-${plugin.instanceId}`}
                    onClick={() => void runtime.host.disable(plugin.instanceId)}
                  >
                    禁用
                  </button>
                )}
                {(plugin.state === 'inactive' || plugin.state === 'disabled') && (
                  <button
                    type="button"
                    className="lumora-button"
                    data-testid={`plugin-toggle-${plugin.instanceId}`}
                    onClick={() => {
                      void runtime.host.enable(plugin.instanceId).catch(() => {});
                    }}
                  >
                    {plugin.reason ? '重新启用' : '启用'}
                  </button>
                )}
                {plugin.state === 'failed' && (
                  <button
                    type="button"
                    className="lumora-button lumora-button--danger"
                    data-testid={`plugin-toggle-${plugin.instanceId}`}
                    onClick={() => void runtime.host.disable(plugin.instanceId)}
                  >
                    禁用
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
    </ModalDialog>
  );
}
