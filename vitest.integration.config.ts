import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '#contracts': resolve('src/contracts') } },
  test: {
    include: ['test/**/*.integration.test.ts'],
    /* Files share one disposable database. Unrelated fixtures must not exhaust
       serializable retries; concurrency within individual tests stays enabled. */
    fileParallelism: false,
  },
});
