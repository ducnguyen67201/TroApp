import { describe, expect, it } from 'vitest';
import { validateLocalDevelopmentDatabase } from './LocalDevelopmentDatabase.js';

describe('local development database migration safety', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('allows the Compose database at %s', (host) => {
    expect(() => {
      validateLocalDevelopmentDatabase({
        APP_ENV: 'dev',
        DATABASE_URL: `postgresql://tro:password@${host}:54329/tro`,
      });
    }).not.toThrow();
  });

  it.each([
    ['a non-development mode', 'prod', 'postgresql://tro:password@127.0.0.1:54329/tro'],
    ['a remote host', 'dev', 'postgresql://tro:password@database.example.com:5432/tro'],
    ['a different local port', 'dev', 'postgresql://tro:password@127.0.0.1:5432/tro'],
    ['a different database', 'dev', 'postgresql://tro:password@127.0.0.1:54329/production'],
  ])('refuses %s without disclosing the URL', (_case, appEnvironment, databaseUrl) => {
    expect(() => {
      validateLocalDevelopmentDatabase({ APP_ENV: appEnvironment, DATABASE_URL: databaseUrl });
    }).toThrow('Automatic development migration refused');

    try {
      validateLocalDevelopmentDatabase({ APP_ENV: appEnvironment, DATABASE_URL: databaseUrl });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(databaseUrl);
      expect(String(error)).not.toContain('password');
    }
  });
});
