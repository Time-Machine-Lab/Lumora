import { useEffect, useState } from 'react';
import type { PanelContextProps } from '@lumora/plugin-sdk';
import { useEventRefresh } from '../hooks/use-event-refresh';

/**
 * 演示 panel 贡献项：展示项目信息、项目事件日志，
 * 并通过 services 调用 assetLoader / exporter 能力。
 */
export function MockConsolePanel({ pluginId, project, events, services }: PanelContextProps) {
  const [log, setLog] = useState<string[]>([]);
  const [assetInfo, setAssetInfo] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  // project:changed：编辑器每次变更（编辑/撤销/重做）后宿主广播，面板实时反映当前快照
  useEventRefresh(events, ['project:opened', 'project:closed', 'project:changed']);

  useEffect(() => {
    const appendLog = (line: string) => setLog((lines) => [...lines.slice(-19), line]);
    const subscriptions = [
      events.on('project:opened', (payload) => appendLog(`project:opened ${payload.uri}`)),
      events.on('project:closed', () => appendLog('project:closed')),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [events]);

  const loadAsset = async () => {
    try {
      const asset = await services.assets.load('https://cdn.lumora.example/scene.mock.json');
      const objects = (asset.data as { objects?: unknown[] }).objects?.length ?? 0;
      setAssetInfo(`已加载 ${asset.uri}（${objects} 个对象）`);
    } catch (error) {
      setAssetInfo(`加载失败: ${(error as Error).message}`);
    }
  };

  const runExporter = async () => {
    if (!project) {
      setExportInfo('未打开项目，无法导出');
      return;
    }
    try {
      const result = await services.exporters.run('com.lumora.mock.exporter', project);
      setExportInfo(`已导出 ${result.fileName}（${result.data.length} 字符）`);
    } catch (error) {
      setExportInfo(`导出失败: ${(error as Error).message}`);
    }
  };

  return (
    <section className="lumora-mock-console" data-testid="mock-console-panel">
      <h4>Mock 控制台（插件 {pluginId}）</h4>
      <p>
        {project
          ? `当前项目: ${project.name}，${project.objects.length} 个对象`
          : '未打开项目'}
      </p>
      <div className="lumora-mock-actions">
        <button type="button" data-testid="mock-load-asset" onClick={loadAsset}>
          加载示例资源
        </button>
        <button type="button" data-testid="mock-run-exporter" onClick={runExporter}>
          导出演示
        </button>
      </div>
      {assetInfo ? <p className="lumora-mock-result">{assetInfo}</p> : null}
      {exportInfo ? <p className="lumora-mock-result">{exportInfo}</p> : null}
      <ul className="lumora-mock-log" data-testid="mock-event-log">
        {log.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
