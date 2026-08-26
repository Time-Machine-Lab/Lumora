import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'examples/mock-plugin/vitest.config.ts',
  'examples/openai-compatible-plugin/vitest.config.ts',
  'examples/embedded-host/vitest.config.ts',
]);
