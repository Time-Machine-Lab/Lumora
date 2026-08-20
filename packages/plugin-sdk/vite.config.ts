import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', '@lumora/core'],
    },
    sourcemap: true,
    target: 'es2022',
    emptyOutDir: true,
  },
});
