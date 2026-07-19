import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: {
    alias: {
      '@kyokao/config': resolve('packages/config/src/index.ts'),
      '@kyokao/providers': resolve('packages/providers/src/index.ts'),
      '@kyokao/tools': resolve('packages/tools/src/index.ts'),
      '@kyokao/memory': resolve('packages/memory/src/index.ts'),
      '@kyokao/agent': resolve('packages/agent/src/index.ts'),
      '@kyokao/ui': resolve('packages/ui/src/index.ts'),
    },
  },
});
