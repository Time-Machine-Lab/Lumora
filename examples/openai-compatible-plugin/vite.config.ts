import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['es'],
      fileName: 'index',
      cssFileName: 'style',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', '@lumora/plugin-sdk', '@lumora/core'],
    },
    sourcemap: true,
    target: 'es2022',
    emptyOutDir: true,
  },
});
