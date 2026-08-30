import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { createSampleProject } from '@lumora/core';
import type { Manifest, PluginDescriptor, Project } from '@lumora/core';
import { LumoraStudio } from '@lumora/studio';
import type { LumoraStudioHandle } from '@lumora/studio';
import mockManifest from '@lumora/mock-plugin/lumora.plugin.json';
import openAiCompatibleManifest from '@lumora/openai-compatible-plugin/lumora.plugin.json';
import '@lumora/openai-compatible-plugin/style.css';
import { formatLogLine } from './summarize';
import './app.css';

const mockPlugin: PluginDescriptor = {
  manifest: mockManifest as unknown as PluginDescriptor['manifest'],
  // 通过 workspace 源码别名直接加载；生产环境下此入口为构建产物 dist/index.js
  entry: () => import('@lumora/mock-plugin'),
};

const openAiCompatiblePlugin: PluginDescriptor = {
  manifest: openAiCompatibleManifest as unknown as PluginDescriptor['manifest'],
  entry: () => import('@lumora/openai-compatible-plugin'),
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

/** e2e 覆盖：真实 manifest 声明 exportableSettings（含 BENIGN 歧义键）→
 *  includePrivate 导出经 ProjectMenu 下载链路按声明投影，com.example.settings
 *  命名空间随包携带声明的公开键，其余字段（含凭据形态键）绝不进包 */
const settingsPlugin: PluginDescriptor = {
  manifest: {
    schemaVersion: '1',
    id: 'com.example.settings',
    name: '设置导出插件',
    version: '0.1.0',
    entry: './dist/index.js',
    exportableSettings: [
      'theme',
      'model',
      'tokenBudget',
      'authMode',
      'cookieConsent',
      'cookieSettings',
      'sessionMode',
    ],
    privateSettings: ['serverUrl'],
  } satisfies Manifest,
  entry: async () => ({
    default: {
      activate: (context) => context.contribute({}),
    },
  }),
};

/** e2e 覆盖：manifest 缺失 → 注册即失败（fail-closed），其 pluginData 命名空间
 *  无任何声明依据，includePrivate 导出整段排除 */
const noManifestPlugin: PluginDescriptor = {
  manifest: undefined as unknown as Manifest,
  entry: async () => ({
    default: {
      activate: (context) => context.contribute({}),
    },
  }),
};

/** e2e 覆盖：真实 manifest 声明凭据形态键（exportableSettings 含 apiKey）→
 *  构建期整包拒绝，includePrivate 导出不产生下载。仅 ?plugins=leaky 时注册，
 *  避免污染常规宿主的导出路径 */
const leakySettingsPlugin: PluginDescriptor = {
  manifest: {
    schemaVersion: '1',
    id: 'com.example.leaky',
    name: '泄漏声明插件',
    version: '0.1.0',
    entry: './dist/index.js',
    exportableSettings: ['apiKey', 'theme'],
  } satisfies Manifest,
  entry: async () => ({
    default: {
      activate: (context) => context.contribute({}),
    },
  }),
};

/** 第三十轮一般 4：逐类真实 manifest 显式声明凭据键 —— B1 无边界全小写复合
 *  （sessionid）、S7 session/cookie 系列（cookieHeader）、CJK 敏感词（访问令牌）
 *  各注册独立命名空间插件；仅 ?plugins=leaky-<类别> 时注册对应类别，
 *  includePrivate 导出逐类断言整包拒绝且不产生下载。
 *  id 必须为反向域名风格（validateManifest ID_PATTERN 不允许连字符），
 *  否则 manifest 校验失败、声明不生效、导出静默剥离而非整包拒绝 */
const leakyCategoryPlugin = (id: string, name: string, credentialKey: string): PluginDescriptor => ({
  manifest: {
    schemaVersion: '1',
    id,
    name,
    version: '0.1.0',
    entry: './dist/index.js',
    exportableSettings: [credentialKey, 'theme'],
  } satisfies Manifest,
  entry: async () => ({
    default: {
      activate: (context) => context.contribute({}),
    },
  }),
});
const LEAKY_B1 = leakyCategoryPlugin('com.example.leaky.b1', '泄漏声明插件 B1', 'sessionid');
const LEAKY_S7 = leakyCategoryPlugin('com.example.leaky.s7', '泄漏声明插件 S7', 'cookieHeader');
const LEAKY_CJK = leakyCategoryPlugin('com.example.leaky.cjk', '泄漏声明插件 CJK', '访问令牌');

const LEAKY_PLUGINS = new URLSearchParams(window.location.search).get('plugins');

const PLUGINS: PluginDescriptor[] = [
  mockPlugin,
  openAiCompatiblePlugin,
  brokenManifestPlugin,
  brokenEnginePlugin,
  explodingPlugin,
  settingsPlugin,
  noManifestPlugin,
  ...(LEAKY_PLUGINS === 'leaky' ? [leakySettingsPlugin] : []),
  ...(LEAKY_PLUGINS === 'leaky-b1' ? [LEAKY_B1] : []),
  ...(LEAKY_PLUGINS === 'leaky-s7' ? [LEAKY_S7] : []),
  ...(LEAKY_PLUGINS === 'leaky-cjk' ? [LEAKY_CJK] : []),
];

/** 默认只记录事件摘要；?debug=full 时输出完整 payload（大数据量下会产生 GB 级字符串，仅限调试） */
const DEBUG_FULL = new URLSearchParams(window.location.search).get('debug') === 'full';

/** 本地存储后端选择：?storage=opfs 使用 OPFS，缺省 IndexedDB（持久化门面可切换，TML-53 范围项） */
const STORAGE = new URLSearchParams(window.location.search).get('storage') === 'opfs' ? 'opfs' : 'indexeddb';
const DUAL_STUDIO_FIXTURE = new URLSearchParams(window.location.search).get('fixture') === 'dual-studio';
const ROUND3_REVIEW_FIXTURE = new URLSearchParams(window.location.search).get('fixture');

function createRound3ReviewProject(dense = false): Project {
  const project = createSampleProject('lumora://tml-563-round3', 'TML-563 60fps 回归');
  const sourceTrack = project.tracks[0]!;
  return {
    ...project,
    settings: { ...project.settings, fps: 60 },
    tracks: [{
      ...sourceTrack,
      id: 'review-60fps',
      name: '60fps 相邻关键帧',
      keyframes: dense
        ? Array.from({ length: 60 }, (_, index) => ({
            time: 1 + index / 60,
            value: [index, 0, 0] as [number, number, number],
          }))
        : [
            { time: 1, value: [0, 0, 0] },
            { time: 1 + 1 / 60, value: [1, 0, 0] },
          ],
    }],
  };
}

export default function App() {
  const [mounted, setMounted] = useState(true);
  // 第三十一轮严重 3：卸载进行中（close() 未 settle）时禁用触发按钮 ——
  // 双击/连点不再并发进入卸载流程；close() 本身是 single-flight（重复调用
  // 共享同一 in-flight 裁决），此处是 UI 层对同一问题的第一道防线
  const [closing, setClosing] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const handleRef = useRef<LumoraStudioHandle | null>(null);
  const logToggleRef = useRef<HTMLButtonElement>(null);
  const logDialogRef = useRef<HTMLElement>(null);

  const appendLog = (line: string) => setLog((lines) => [...lines.slice(-49), line]);

  const closeLog = useCallback(() => {
    setLogOpen(false);
    requestAnimationFrame(() => logToggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!logOpen) return;
    const frame = requestAnimationFrame(() => {
      logDialogRef.current?.querySelector<HTMLButtonElement>('[data-testid="host-log-close"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [logOpen]);

  const handleLogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]'),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

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

  const toggleMount = async () => {
    if (mounted) {
      // 第三十一轮严重 3：卸载进行中禁止再次进入（双击/连点防护）
      if (closing) return;
      setClosing(true);
      try {
        const subscriptionCount = handleRef.current?.runtime.events.handlerCount ?? 0;
        // 第三十轮严重 6：卸载走 handle.close() 可等待屏障 —— 冲刷失败/未解决
        // 恢复 fork 时释放被拒绝，保持挂载并记录原因（未落盘内容仍可恢复），
        // 绝不「假装已卸载」丢弃内容
        const outcome = await handleRef.current?.close();
        if (outcome && !outcome.ok) {
          appendLog(`卸载被拒绝：${outcome.message ?? '运行时释放失败'} —— Studio 保持挂载，请先解决未保存内容`);
          return;
        }
        appendLog(`卸载 Studio：释放前事件订阅数 ${subscriptionCount} —— 运行时已释放`);
        setMounted(false);
      } finally {
        setClosing(false);
      }
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
            ref={logToggleRef}
            type="button"
            className="host__log-toggle"
            data-testid="host-log-toggle"
            aria-controls="host-event-log"
            aria-expanded={logOpen}
            onClick={() => {
              if (logOpen) closeLog();
              else setLogOpen(true);
            }}
          >
            {logOpen ? '收起日志' : '事件日志'}
          </button>
          <button
            type="button"
            data-testid="reopen-last-export"
            disabled={closing}
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
          <button type="button" data-testid="studio-mount-toggle" disabled={closing} onClick={toggleMount}>
            {closing ? '正在释放资源…' : mounted ? '卸载 Studio（释放资源）' : '重新挂载 Studio'}
          </button>
        </div>
      </header>
      <div className="host__layout">
        <div className="host__studio-region" data-testid="host-studio-region" inert={logOpen || undefined}>
          {mounted ? (
            <LumoraStudio
              ref={handleRef}
              plugins={PLUGINS}
              hostVersion="0.1.0"
              storage={STORAGE}
              pluginSettingsNamespace="embedded-host"
              className="host__studio"
              initialProject={ROUND3_REVIEW_FIXTURE?.startsWith('tml-563-round3')
                ? createRound3ReviewProject(ROUND3_REVIEW_FIXTURE === 'tml-563-round3-dense')
                : undefined}
            />
          ) : (
            <div className="host__placeholder" data-testid="studio-placeholder">
              Studio 已卸载 —— WebGL 场景、插件贡献项与事件订阅均已释放
            </div>
          )}
        </div>
        <aside
          ref={logDialogRef}
          id="host-event-log"
          className="host__log"
          data-testid="host-event-log"
          data-open={logOpen || undefined}
          role={logOpen ? 'dialog' : undefined}
          aria-modal={logOpen || undefined}
          tabIndex={logOpen ? -1 : 0}
          aria-labelledby="host-event-log-heading"
          onKeyDown={logOpen ? handleLogKeyDown : undefined}
        >
          <div className="host__log-header">
            <h2 id="host-event-log-heading">宿主事件日志</h2>
            {logOpen && (
              <button
                type="button"
                className="host__log-close"
                data-testid="host-log-close"
                aria-label="关闭事件日志"
                title="关闭事件日志"
                onClick={closeLog}
              >
                <X aria-hidden="true" />
              </button>
            )}
          </div>
          <ul data-testid="event-log">
            {log.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </aside>
      </div>
      {DUAL_STUDIO_FIXTURE && (
        <div className="host__fixture-studio" data-testid="dual-studio-fixture">
          <LumoraStudio hostVersion="0.1.0" />
        </div>
      )}
    </div>
  );
}
