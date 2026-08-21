import { useEffect, useRef, useState } from 'react';
import type { PluginDescriptor } from '@lumora/core';
import { LumoraStudio } from '@lumora/studio';
import type { LumoraStudioHandle } from '@lumora/studio';
import mockManifest from '@lumora/mock-plugin/lumora.plugin.json';
import { formatLogLine } from './summarize';
import './app.css';

const mockPlugin: PluginDescriptor = {
  manifest: mockManifest as unknown as PluginDescriptor['manifest'],
  // 通过 workspace 源码别名直接加载；生产环境下此入口为构建产物 dist/index.js
  entry: () => import('@lumora/mock-plugin'),
};

/** 演示验收标准 2：非法 Manifest 的插件不会被激活 */
const brokenManifestPlugin: PluginDescriptor = {
  manifest: {
    ...mockManifest,
    id: 'com.example.brokenmanifest',
    name: '坏清单插件',
    schemaVersion: '2',
  } as unknown as PluginDescriptor['manifest'],
};

/** 演示验收标准 2：引擎不兼容的插件不会被激活，且入口不会被加载 */
const brokenEnginePlugin: PluginDescriptor = {
  manifest: {
    ...mockManifest,
    id: 'com.example.brokenengine',
    name: '引擎不兼容插件',
    engine: { lumora: '^99.0.0' },
  } as unknown as PluginDescriptor['manifest'],
  entry: () => import('@lumora/mock-plugin'),
};

/** 演示验收标准 3：面板渲染抛错被错误边界隔离，壳层可用且可禁用该插件 */
function ExplodingPanel(): never {
  throw new Error('演示面板崩溃：插件渲染异常不应影响宿主');
}

const explodingPlugin: PluginDescriptor = {
  manifest: {
    ...mockManifest,
    id: 'com.example.exploding',
    name: '面板崩溃演示插件',
  } as unknown as PluginDescriptor['manifest'],
  entry: async () => ({
    default: {
      activate: (context) =>
        context.contribute({
          panels: [
            {
              kind: 'panel',
              id: 'com.example.exploding.panel',
              title: '爆炸面板',
              component: ExplodingPanel,
            },
          ],
        }),
    },
  }),
};

const PLUGINS: PluginDescriptor[] = [mockPlugin, brokenManifestPlugin, brokenEnginePlugin, explodingPlugin];

/** 默认只记录事件摘要；?debug=full 时输出完整 payload（大数据量下会产生 GB 级字符串，仅限调试） */
const DEBUG_FULL = new URLSearchParams(window.location.search).get('debug') === 'full';

export default function App() {
  const [mounted, setMounted] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const handleRef = useRef<LumoraStudioHandle | null>(null);

  const appendLog = (line: string) => setLog((lines) => [...lines.slice(-49), line]);

  useEffect(() => {
    if (!mounted) return;
    const runtime = handleRef.current?.runtime;
    if (!runtime) return;
    if (DEBUG_FULL) appendLog('事件日志：完整 payload 模式（?debug=full），大数据量下可能导致严重卡顿');
    const opened = runtime.events.on('project:opened', ({ project }) =>
      appendLog(`项目已打开: ${project.name}`),
    );
    const closed = runtime.events.on('project:closed', () => appendLog('项目已关闭'));
    const anyEvent = runtime.events.onAny((event, payload) =>
      appendLog(DEBUG_FULL ? `${event} ${JSON.stringify(payload)}` : formatLogLine(event, payload)),
    );
    return () => {
      opened.dispose();
      closed.dispose();
      anyEvent.dispose();
    };
  }, [mounted]);

  const toggleMount = () => {
    if (mounted) {
      const subscriptionCount = handleRef.current?.runtime.events.handlerCount ?? 0;
      appendLog(`卸载 Studio：释放前事件订阅数 ${subscriptionCount} —— 运行时已释放`);
      setMounted(false);
    } else {
      setMounted(true);
    }
  };

  return (
    <div className="host">
      <header className="host__bar">
        <h1>Lumora 嵌入宿主示例</h1>
        <div className="host__actions">
          <button
            type="button"
            data-testid="reopen-last-export"
            onClick={() => {
              const raw = localStorage.getItem('lumora.demo.last-export');
              if (!raw) {
                appendLog('没有可重开的导出（请先在 Studio 中导出场景）');
                return;
              }
              try {
                const project = JSON.parse(raw);
                handleRef.current?.runtime.openProject(project);
              } catch {
                appendLog('重开失败：导出数据无法解析');
              }
            }}
          >
            重开上次导出（新运行时）
          </button>
          <button type="button" data-testid="studio-mount-toggle" onClick={toggleMount}>
            {mounted ? '卸载 Studio（释放资源）' : '重新挂载 Studio'}
          </button>
        </div>
      </header>
      <div className="host__layout">
        {mounted ? (
          <LumoraStudio ref={handleRef} plugins={PLUGINS} hostVersion="0.1.0" className="host__studio" />
        ) : (
          <div className="host__placeholder" data-testid="studio-placeholder">
            Studio 已卸载 —— WebGL 场景、插件贡献项与事件订阅均已释放
          </div>
        )}
        <aside className="host__log">
          <h2>宿主事件日志</h2>
          <ul data-testid="event-log">
            {log.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
