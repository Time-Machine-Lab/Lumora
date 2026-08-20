import { Component } from 'react';
import type { ReactNode } from 'react';

interface PanelErrorBoundaryProps {
  pluginId: string;
  title: string;
  onDisablePlugin: (pluginId: string) => void;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  error: unknown;
}

/**
 * 面板渲染错误隔离：插件面板渲染抛错时只影响该面板，
 * 壳层保持可用，并给出禁用该插件的入口。
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  override state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): PanelErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[lumora:studio] 面板「${this.props.title}」渲染失败（插件 ${this.props.pluginId}）:`, error);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="lumora-panel-error" data-testid="panel-error-fallback" role="alert">
        <h3>面板「{this.props.title}」渲染失败</h3>
        <p className="lumora-panel-error__message">{String(this.state.error)}</p>
        <button
          type="button"
          className="lumora-button lumora-button--danger"
          data-testid="disable-plugin-from-panel"
          onClick={() => this.props.onDisablePlugin(this.props.pluginId)}
        >
          禁用该插件
        </button>
      </div>
    );
  }
}
