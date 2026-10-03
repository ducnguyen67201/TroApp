import { describe, expect, it } from 'vitest';
import { readServerEnv } from '../../src/server/Env.js';

const databaseUrl = 'postgresql://tro:local_demo_only@127.0.0.1:54329/tro';
const authSecret = 'local-test-secret-at-least-32-characters-long';

describe('backend application environment', () => {
  it('defaults to dev and accepts stage or prod', () => {
    expect(readServerEnv({ DATABASE_URL: databaseUrl, AUTH_SECRET: authSecret }).APP_ENV).toBe(
      'dev',
    );
    expect(
      readServerEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        APP_ENV: 'stage',
        AUTH_BASE_URL: 'https://staging.example.test',
      }).APP_ENV,
    ).toBe('stage');
    expect(
      readServerEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        APP_ENV: 'prod',
        AUTH_BASE_URL: 'https://api.example.test',
      }).APP_ENV,
    ).toBe('prod');
  });

  it('rejects an unsupported mode', () => {
    expect(() =>
      readServerEnv({ DATABASE_URL: databaseUrl, AUTH_SECRET: authSecret, APP_ENV: 'test' }),
    ).toThrow('Backend configuration is invalid.');
  });

  it('rejects the example secret and a non-HTTPS hosted auth URL', () => {
    expect(() =>
      readServerEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: 'replace-with-a-random-secret-at-least-32-characters',
      }),
    ).toThrow('Replace the example AUTH_SECRET');
    expect(() =>
      readServerEnv({ DATABASE_URL: databaseUrl, AUTH_SECRET: authSecret, APP_ENV: 'prod' }),
    ).toThrow('public HTTPS AUTH_BASE_URL');
  });

  it('requires both backend Google OAuth credentials together', () => {
    expect(() =>
      readServerEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        GOOGLE_CLIENT_ID: 'test-client-id',
      }),
    ).toThrow('both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    expect(
      readServerEnv({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: authSecret,
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
      }).GOOGLE_CLIENT_ID,
    ).toBe('test-client-id');
  });
});

it('validates backend speech configuration without requiring it for ordinary startup', () => {
  const base = { DATABASE_URL: databaseUrl, AUTH_SECRET: authSecret };
  expect(readServerEnv(base).ELEVENLABS_API_KEY).toBeUndefined();
  expect(
    readServerEnv({
      ...base,
      ELEVENLABS_API_KEY: 'synthetic-key',
    }).ELEVENLABS_MODEL_ID,
  ).toBe('eleven_flash_v2_5');
});
