import { describe, expect, it } from 'vitest';
import { readServerEnv } from './Env.js';

const databaseUrl = 'postgresql://tro:local_demo_only@127.0.0.1:54329/tro';
const authEnvironment = {
  DATABASE_URL: databaseUrl,
  GOOGLE_CLIENT_ID: 'local-client-id.example.test',
  GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/api/v1/auth/google/callback',
};

describe('backend application environment', () => {
  it('defaults to dev and accepts stage or prod', () => {
    expect(readServerEnv(authEnvironment).APP_ENV).toBe('dev');
    expect(readServerEnv({ ...authEnvironment, APP_ENV: 'stage' }).APP_ENV).toBe('stage');
    expect(readServerEnv({ ...authEnvironment, APP_ENV: 'prod' }).APP_ENV).toBe('prod');
  });

  it('rejects an unsupported mode', () => {
    expect(() => readServerEnv({ ...authEnvironment, APP_ENV: 'test' })).toThrow(
      'Backend configuration is invalid.',
    );
  });

  it('requires backend-only Google settings and a strict callback path', () => {
    expect(() => readServerEnv({ DATABASE_URL: databaseUrl })).toThrow(
      'Backend configuration is invalid.',
    );
    expect(() =>
      readServerEnv({ ...authEnvironment, GOOGLE_REDIRECT_URI: 'https://example.test/callback' }),
    ).toThrow('Backend configuration is invalid.');
  });
});
