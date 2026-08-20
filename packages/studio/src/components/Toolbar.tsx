import { createSampleProject } from '@lumora/core';
import type { Project } from '@lumora/core';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { useEventRefresh } from '../hooks/use-event-refresh';

interface ToolbarProps {
  runtime: StudioRuntime;
  project: Project | null;
  onTogglePlugins: () => void;
  onTogglePalette: () => void;
}

export function Toolbar({ runtime, project, onTogglePlugins, onTogglePalette }: ToolbarProps) {
  useEventRefresh(runtime.events, ['contribution:changed', 'command:changed']);
  const toolbars = runtime.host.contributions.getToolbars();

  return (
    <header className="lumora-toolbar" data-testid="lumora-toolbar">
      <span className="lumora-toolbar__brand">Lumora Studio</span>
      <div className="lumora-toolbar__actions">
        <button
          type="button"
          className="lumora-button"
          data-testid="open-sample-project"
          onClick={() => runtime.openProject(createSampleProject())}
        >
          打开示例项目
        </button>
        <button
          type="button"
          className="lumora-button"
          data-testid="close-project"
          onClick={() => runtime.closeProject()}
          disabled={!project}
        >
          关闭项目
        </button>
        {toolbars.map((item) => {
          const command = runtime.host.commands.get(item.commandId);
          return (
            <button
              key={item.id}
              type="button"
              className="lumora-button lumora-button--plugin"
              data-testid={`toolbar-${item.id}`}
              title={item.tooltip ?? item.label}
              disabled={!command}
              onClick={() => void runtime.host.commands.execute(item.commandId)}
            >
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          className="lumora-button"
          data-testid="open-command-palette"
          onClick={onTogglePalette}
        >
          命令 (Ctrl+K)
        </button>
        <button
          type="button"
          className="lumora-button"
          data-testid="open-plugin-manager"
          onClick={onTogglePlugins}
        >
          插件管理
        </button>
      </div>
      <span className="lumora-toolbar__version">v{runtime.host.hostVersion}</span>
    </header>
  );
}
