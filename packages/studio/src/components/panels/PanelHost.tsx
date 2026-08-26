import { useRef, useState } from 'react';
import type { PanelContribution, Project } from '@lumora/core';
import type { StudioRuntime } from '../../runtime/studio-runtime';
import { useEventRefresh } from '../../hooks/use-event-refresh';
import { PanelErrorBoundary } from './PanelErrorBoundary';

interface PanelHostProps {
  runtime: StudioRuntime;
  project: Project | null;
  onDisablePlugin: (pluginId: string) => void;
}

/** 侧栏面板宿主：渲染各插件的 panel 贡献项，逐个用错误边界隔离 */
export function PanelHost({ runtime, project, onDisablePlugin }: PanelHostProps) {
  useEventRefresh(runtime.events, ['contribution:changed', 'plugin:state-changed']);
  const panels = runtime.host.contributions.getPanels();
  const [activeId, setActiveId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  if (panels.length === 0) return null;
  const active = panels.find((panel) => panel.id === activeId) ?? panels[0];

  return (
    <aside className="lumora-panels" data-testid="lumora-panels" aria-label="插件面板">
      <div className="lumora-panels__tabs" role="tablist">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            aria-selected={panel.id === active.id}
            className={`lumora-panels__tab${panel.id === active.id ? ' lumora-panels__tab--active' : ''}`}
            data-testid={`panel-tab-${panel.id}`}
            onClick={() => {
              setActiveId(panel.id);
              requestAnimationFrame(() => contentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
            }}
          >
            {panel.title}
          </button>
        ))}
      </div>
      <div ref={contentRef} className="lumora-panels__content" role="tabpanel">
        <ActivePanel panel={active} runtime={runtime} project={project} onDisablePlugin={onDisablePlugin} />
      </div>
    </aside>
  );
}

function ActivePanel({
  panel,
  runtime,
  project,
  onDisablePlugin,
}: {
  panel: PanelContribution & { pluginId: string };
  runtime: StudioRuntime;
  project: Project | null;
  onDisablePlugin: (pluginId: string) => void;
}) {
  const Component = panel.component;
  return (
    // key 按面板 id：切换/移除面板时重建边界，避免错误状态残留到下一个面板
    <PanelErrorBoundary
      key={panel.id}
      pluginId={panel.pluginId}
      title={panel.title}
      onDisablePlugin={onDisablePlugin}
    >
      <Component
        pluginId={panel.pluginId}
        project={project}
        events={runtime.events}
        commands={runtime.host.commands}
        services={runtime.host.services}
        hostVersion={runtime.host.hostVersion}
      />
    </PanelErrorBoundary>
  );
}
