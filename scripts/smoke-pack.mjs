/* eslint-env node */
// npm 打包/安装冒烟：构建全部包 → npm pack 生成 tarball → 在临时消费工程中
// 以 tarball 安装（React 19 peer 边界）→ typecheck 并 vite build 消费端
// （含 @lumora/studio/style.css 导出存在性验证）。
// 失败时退出码非 0；临时目录总是被清理。
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: opts.cwd ?? root, stdio: 'inherit', timeout: 600_000, ...opts });

const PACKAGES = ['@lumora/core', '@lumora/plugin-sdk', '@lumora/studio', '@lumora/mock-plugin'];
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

// Windows 上 os.tmpdir() 可能返回 8.3 短名路径（如 ADMINI~1）且 realpath 无法归一化，
// 而 vite 内部 realpath 后是长名路径，混用会让 relative 计算出含 .. 的非法 fileName；
// 因此冒烟目录放在仓库 node_modules 下（长名路径、已被 gitignore）
const tmp = mkdtempSync(join(root, 'node_modules', '.lumora-smoke-'));
const consumerDir = join(tmp, 'consumer');
mkdirSync(consumerDir, { recursive: true });
// tarball 放在消费工程内，file: 依赖相对 consumer package.json 解析
const tarballDir = join(consumerDir, 'tarballs');
mkdirSync(tarballDir, { recursive: true });

const write = (relative, content) => {
  const target = join(consumerDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
};

try {
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

  write('tsconfig.json', `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true,
    "skipLibCheck": true
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
import mockManifest from '@lumora/mock-plugin/lumora.plugin.json';

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

  console.log('[smoke] 4/5 验证 style.css 导出真实存在');
  const styleCss = join(consumerDir, 'node_modules', '@lumora', 'studio', 'dist', 'style.css');
  if (!existsSync(styleCss)) {
    throw new Error(`@lumora/studio 安装产物缺少 dist/style.css（exports "./style.css" 指向不存在的文件）`);
  }
  const studioPkg = JSON.parse(readFileSync(join(consumerDir, 'node_modules', '@lumora', 'studio', 'package.json'), 'utf8'));
  if (!studioPkg.exports?.['./style.css']) {
    throw new Error('@lumora/studio 安装后 exports 缺少 "./style.css"');
  }

  console.log('[smoke] 5/5 typecheck + vite build 消费端');
  run('npm exec -- tsc --noEmit', { cwd: consumerDir });
  run('npm exec -- vite build', { cwd: consumerDir });

  console.log('[smoke] 通过：pack/install/typecheck/build 全链路正常');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
