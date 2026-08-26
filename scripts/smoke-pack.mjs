// npm 打包/安装冒烟：构建全部包 → npm pack 生成 tarball → 在仓库依赖树之外的
// 临时消费工程中以 tarball 安装（React 19 peer 边界）→ typecheck（skipLibCheck:false）
// 并 vite build 消费端（含 @lumora/studio/style.css 导出存在性验证与依赖隔离断言）。
// 失败时退出码非 0；临时目录总是被清理。
// --self-test：边界判定自检（同前缀兄弟临时目录必须判为仓库外）+ canonicalize
// 抛错时的 raw path 清理回归。
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: opts.cwd ?? root, stdio: 'inherit', timeout: 600_000, ...opts });

const PACKAGES = [
  '@lumora/core',
  '@lumora/plugin-sdk',
  '@lumora/studio',
  '@lumora/mock-plugin',
  '@lumora/openai-compatible-plugin',
];
const CONSUMER_DEP_PEERS = [
  'react@^19.0.0',
  'react-dom@^19.0.0',
  'three@^0.170.0',
  '@react-three/fiber@^9.0.0',
  '@react-three/drei@^10.0.0',
];
const CONSUMER_DEV_DEPS = [
  'typescript@^5.7.2',
  '@types/react@^19.0.0',
  '@types/react-dom@^19.0.0',
  'vite@^6.0.3',
];

/**
 * dir 是否位于 rootDir 内（canonical 判定）：
 * 双方经 realpathSync.native 归一化（展开 Windows 8.3 短名，如 ADMINI~1 → Administrator），
 * 再用 path.relative + 路径段判断 —— 同前缀兄弟目录（<base>/lumora-smoke-x vs <base>/lumora）
 * 落在根外；只拒绝 '..' 本身或以 '..<sep>' 开头的相对路径，首段形如 '..cache' 的
 * 仓库内目录仍判为内部；POSIX 大小写敏感，不做大小写折叠。
 */
const isInside = (dir, rootDir) => {
  const rel = relative(realpathSync.native(rootDir), realpathSync.native(dir));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};

/**
 * 在系统临时目录创建前缀目录，创建后立即进入 try/finally 再做 canonicalize
 * （默认 realpathSync.native，可注入以模拟失败）：无论 canonicalize 是否抛错，
 * finally 都按 raw path 清理，绝不遗留临时目录。
 */
const withRawTempDir = (prefix, fn, canonicalize = (raw) => realpathSync.native(raw)) => {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(canonicalize(raw));
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
};

const isSelfTest = process.argv.includes('--self-test');
if (isSelfTest) {
  withRawTempDir('lumora-boundary-', (base) => {
    const repo = join(base, 'lumora');
    const sibling = join(base, 'lumora-smoke-x');
    const consumer = join(repo, 'consumer');
    const other = join(base, 'other');
    const dotDotSegment = join(repo, '..cache', 'x');
    // 判定基于已存在的真实路径（realpath 归一化），各用例目录都先创建
    mkdirSync(consumer, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(other, { recursive: true });
    mkdirSync(dotDotSegment, { recursive: true });
    const cases = [
      ['仓库自身', isInside(repo, repo), true],
      ['仓库内部目录', isInside(consumer, repo), true],
      ['首段 .. 的仓库内目录', isInside(dotDotSegment, repo), true],
      ['同前缀兄弟临时目录', isInside(sibling, repo), false],
      ['仓库父目录', isInside(base, repo), false],
      ['外部目录', isInside(join(base, 'other'), repo), false],
    ];
    for (const [name, actual, expected] of cases) {
      if (actual !== expected) {
        throw new Error(`边界自检失败: ${name} 期望判定为 ${expected ? '内部' : '外部'}，实际 ${actual ? '内部' : '外部'}`);
      }
    }
    console.log('[smoke] 边界自检通过：同前缀兄弟目录判定为仓库外，仓库内部目录判定为仓库内');
  });

  // canonicalize 抛错清理回归：realpath 失败（或任何 canonicalize 异常）时，
  // finally 必须按 raw path 清理，不得遗留临时目录
  let leaked;
  try {
    withRawTempDir('lumora-boundary-', () => undefined, (raw) => {
      leaked = raw;
      throw new Error('模拟 canonicalize 失败');
    });
    throw new Error('边界自检失败: 期望 canonicalize 抛错');
  } catch (error) {
    if (!String(error.message).includes('模拟 canonicalize')) throw error;
  }
  if (leaked && existsSync(leaked)) {
    throw new Error('边界自检失败: canonicalize 抛错后临时目录未按 raw path 清理');
  }
  console.log('[smoke] canonicalize 抛错清理回归通过');
  process.exit(0);
}

// Windows 上 %TEMP% 可能带 8.3 短名（如 ADMINI~1），普通 realpathSync 不归一化
// 而 vite 内部会得到长名，混用会让 relative 计算出含 .. 的非法 fileName；
// realpathSync.native 能展开短名，把消费工程路径统一成系统长名形式（canonicalize）。
// 消费工程位于仓库依赖树之外，Node 不会向上解析到仓库 node_modules。
withRawTempDir('lumora-smoke-', (tmp) => {
  if (isInside(tmp, root)) {
    throw new Error('冒烟消费工程不得位于仓库依赖树内（临时目录与仓库路径冲突）');
  }
  const consumerDir = join(tmp, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  // tarball 放在消费工程内，file: 依赖相对 consumer package.json 解析
  const tarballDir = join(consumerDir, 'tarballs');
  mkdirSync(tarballDir, { recursive: true });

  const write = (relativePath, content) => {
    const target = join(consumerDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  };

  console.log('[smoke] 1/5 构建全部包');
  run('npm run build');

  console.log('[smoke] 2/5 打包 tarball');
  const tarballs = {};
  for (const name of PACKAGES) {
    // npm pack <name> 会把裸名当 registry 包名解析（本地未发布 → 404），
    // 必须用 --workspace 指定工作区包
    const output = execSync(`npm pack --workspace ${name} --json --pack-destination "${tarballDir}"`, {
      cwd: root,
      encoding: 'utf8',
      timeout: 600_000,
    });
    const [entry] = JSON.parse(output);
    tarballs[name] = `file:./tarballs/${entry.filename}`;
    console.log(`[smoke]   ${name} → ${entry.filename}`);
  }

  console.log('[smoke] 3/5 搭建消费工程并安装 tarball（React 19 peer 边界）');
  const consumerPackage = {
    name: 'lumora-smoke-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@lumora/core': tarballs['@lumora/core'],
      '@lumora/plugin-sdk': tarballs['@lumora/plugin-sdk'],
      '@lumora/studio': tarballs['@lumora/studio'],
      '@lumora/mock-plugin': tarballs['@lumora/mock-plugin'],
      '@lumora/openai-compatible-plugin': tarballs['@lumora/openai-compatible-plugin'],
    },
    // 强制图中 @lumora/core、@lumora/plugin-sdk 引用解析到本地 tarball
    //（各包依赖声明为 0.1.0，尚未发布到 registry，安装时由 overrides 兜底）
    overrides: {
      '@lumora/core': tarballs['@lumora/core'],
      '@lumora/plugin-sdk': tarballs['@lumora/plugin-sdk'],
    },
    devDependencies: {},
  };
  for (const spec of CONSUMER_DEP_PEERS) {
    const at = spec.lastIndexOf('@');
    consumerPackage.dependencies[spec.slice(0, at)] = spec.slice(at + 1);
  }
  for (const spec of CONSUMER_DEV_DEPS) {
    const at = spec.lastIndexOf('@');
    consumerPackage.devDependencies[spec.slice(0, at)] = spec.slice(at + 1);
  }
  write('package.json', JSON.stringify(consumerPackage, null, 2));

  write('index.html', `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>Lumora smoke consumer</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>`);

  write('vite.config.ts', `import { defineConfig } from 'vite';

export default defineConfig({ build: { target: 'es2022' } });
`);

  // skipLibCheck: false —— 声明文件问题（漏声明依赖等）不得被误放行
  write('tsconfig.json', `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": ["src"]
}
`);

  write('src/main.tsx', `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LumoraStudio } from '@lumora/studio';
import type { LumoraStudioHandle } from '@lumora/studio';
import type { PluginDescriptor } from '@lumora/core';
import { definePlugin } from '@lumora/plugin-sdk';
import '@lumora/studio/style.css';
import '@lumora/openai-compatible-plugin/style.css';
import mockManifest from '@lumora/mock-plugin/lumora.plugin.json';
import openAiCompatibleManifest from '@lumora/openai-compatible-plugin/lumora.plugin.json';

const plugins: PluginDescriptor[] = [
  {
    manifest: {
      schemaVersion: '1',
      id: 'com.smoke.plugin',
      name: '冒烟插件',
      version: '0.1.0',
      entry: './dist/index.js',
      contributes: ['command'],
    },
    entry: async () => ({
      default: definePlugin({
        activate: (context) =>
          context.contribute({
            commands: [
              {
                kind: 'command',
                command: {
                  id: 'smoke.hello',
                  title: '你好',
                  execute: () => ({ ok: true }),
                },
              },
            ],
          }),
      }),
    }),
  },
  {
    manifest: mockManifest as unknown as PluginDescriptor['manifest'],
    entry: () => import('@lumora/mock-plugin'),
  },
  {
    manifest: openAiCompatibleManifest as unknown as PluginDescriptor['manifest'],
    entry: () => import('@lumora/openai-compatible-plugin'),
  },
];

// LumoraStudioHandle 导出与样式导入必须通过类型检查与构建
const handleRef: { current: LumoraStudioHandle | null } = { current: null };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LumoraStudio ref={handleRef} plugins={plugins} hostVersion="0.1.0" />
  </StrictMode>,
);
`);

  run('npm install --no-audit --no-fund', { cwd: consumerDir });

  console.log('[smoke] 4/5 验证 style.css 导出真实存在 + 依赖隔离断言');
  const styleCss = join(consumerDir, 'node_modules', '@lumora', 'studio', 'dist', 'style.css');
  if (!existsSync(styleCss)) {
    throw new Error(`@lumora/studio 安装产物缺少 dist/style.css（exports "./style.css" 指向不存在的文件）`);
  }
  const studioPkg = JSON.parse(readFileSync(join(consumerDir, 'node_modules', '@lumora', 'studio', 'package.json'), 'utf8'));
  if (!studioPkg.exports?.['./style.css']) {
    throw new Error('@lumora/studio 安装后 exports 缺少 "./style.css"');
  }
  const openAiPluginDir = join(consumerDir, 'node_modules', '@lumora', 'openai-compatible-plugin');
  const openAiStyleCss = join(openAiPluginDir, 'dist', 'style.css');
  if (!existsSync(openAiStyleCss)) {
    throw new Error('@lumora/openai-compatible-plugin 安装产物缺少 dist/style.css');
  }
  const openAiPluginPkg = JSON.parse(readFileSync(join(openAiPluginDir, 'package.json'), 'utf8'));
  if (!openAiPluginPkg.exports?.['./style.css']) {
    throw new Error('@lumora/openai-compatible-plugin 安装后 exports 缺少 "./style.css"');
  }
  // 依赖隔离：4 个 @lumora 包必须来自本地 tarball 副本（安装进消费工程内），
  // canonical 边界判定不得解析到仓库内；包含边界与断言提示语一致（consumerDir）
  for (const name of PACKAGES) {
    const shortName = name.replace('@lumora/', '');
    const pkgJson = join(consumerDir, 'node_modules', '@lumora', shortName, 'package.json');
    if (!existsSync(pkgJson)) {
      throw new Error(`安装后缺少 @lumora/${shortName}（依赖隔离断言失败）`);
    }
    if (!isInside(pkgJson, consumerDir)) {
      throw new Error(`@lumora/${shortName} 解析到消费工程之外: ${realpathSync.native(pkgJson)}（依赖未隔离，可能被仓库依赖树捕获）`);
    }
  }

  console.log('[smoke] 5/5 typecheck + vite build 消费端');
  run('npm exec -- tsc --noEmit', { cwd: consumerDir });
  run('npm exec -- vite build', { cwd: consumerDir });

  console.log('[smoke] 通过：pack/install/typecheck/build 全链路正常');
});
