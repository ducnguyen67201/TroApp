import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '#contracts': resolve('src/contracts') } },
  test: { include: ['test/**/*.integration.test.ts'] },
});
