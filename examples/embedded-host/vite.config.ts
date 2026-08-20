import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 示例宿主直接引用 workspace 源码，便于开发调试；先精确后宽泛
      '@lumora/mock-plugin/lumora.plugin.json': fileURLToPath(
        new URL('../../examples/mock-plugin/lumora.plugin.json', import.meta.url),
      ),
      '@lumora/mock-plugin': fileURLToPath(new URL('../../examples/mock-plugin/src/index.tsx', import.meta.url)),
      '@lumora/studio': fileURLToPath(new URL('../../packages/studio/src/index.ts', import.meta.url)),
      '@lumora/plugin-sdk': fileURLToPath(new URL('../../packages/plugin-sdk/src/index.ts', import.meta.url)),
      '@lumora/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
});
