import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '#contracts': resolve('src/contracts') } },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
