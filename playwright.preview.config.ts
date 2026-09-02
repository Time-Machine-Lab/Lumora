import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PREVIEW_PORT ?? 5202);
const edgeExecutablePath = process.env.PLAYWRIGHT_EDGE_PATH?.trim();
const e2eEnv = process.platform === 'win32' ? 'set VITE_LUMORA_E2E=1&& ' : 'VITE_LUMORA_E2E=1 ';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/accessibility.spec.ts', '**/export.spec.ts', '**/timeline.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    {
      name: 'edge-preview',
      use: {
        browserName: 'chromium',
        ...(edgeExecutablePath
          ? { launchOptions: { executablePath: edgeExecutablePath } }
          : { channel: 'msedge' as const }),
        baseURL: `http://127.0.0.1:${port}`,
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: `${e2eEnv}npm run build -w examples/embedded-host && ${e2eEnv}npm run preview -w examples/embedded-host -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
