import { describe, expect, it } from 'vitest';
import { readServerEnv } from './Env.js';

const databaseUrl = 'postgresql://tro:local_demo_only@127.0.0.1:54329/tro';

describe('backend application environment', () => {
  it('defaults to dev and accepts stage or prod', () => {
    expect(readServerEnv({ DATABASE_URL: databaseUrl }).APP_ENV).toBe('dev');
    expect(readServerEnv({ DATABASE_URL: databaseUrl, APP_ENV: 'stage' }).APP_ENV).toBe('stage');
    expect(readServerEnv({ DATABASE_URL: databaseUrl, APP_ENV: 'prod' }).APP_ENV).toBe('prod');
  });

  it('rejects an unsupported mode', () => {
    expect(() => readServerEnv({ DATABASE_URL: databaseUrl, APP_ENV: 'test' })).toThrow(
      'Backend configuration is invalid.',
    );
  });
});
