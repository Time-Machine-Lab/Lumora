import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PanelErrorBoundary } from '../src/components/panels/PanelErrorBoundary';

function ThrowingPanel(): never {
  throw new Error('面板组件爆炸');
}

describe('PanelErrorBoundary', () => {
  it('面板渲染抛错时显示失败说明与禁用入口，不影响外层', () => {
    const onDisable = vi.fn();
    render(
      <PanelErrorBoundary pluginId="com.test" title="坏面板" onDisablePlugin={onDisable}>
        <ThrowingPanel />
      </PanelErrorBoundary>,
    );
    expect(screen.getByTestId('panel-error-fallback')).toBeInTheDocument();
    expect(screen.getByText(/渲染失败/)).toBeInTheDocument();
    expect(screen.getByText(/面板组件爆炸/)).toBeInTheDocument();
    screen.getByTestId('disable-plugin-from-panel').click();
    expect(onDisable).toHaveBeenCalledWith('com.test');
  });

  it('正常内容直接渲染', () => {
    render(
      <PanelErrorBoundary pluginId="com.test" title="好面板" onDisablePlugin={vi.fn()}>
        <div data-testid="healthy-content">健康内容</div>
      </PanelErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-content')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-error-fallback')).not.toBeInTheDocument();
  });

  it('异步抛错（effect 内）也由错误边界捕获', async () => {
    function AsyncThrowingPanel(): never {
      throw new Error('effect 爆炸');
    }
    render(
      <PanelErrorBoundary pluginId="com.test" title="坏面板2" onDisablePlugin={vi.fn()}>
        <AsyncThrowingPanel />
      </PanelErrorBoundary>,
    );
    await waitFor(() => expect(screen.getByTestId('panel-error-fallback')).toBeInTheDocument());
  });
});
