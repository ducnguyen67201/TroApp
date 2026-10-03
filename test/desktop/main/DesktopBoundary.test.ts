import { describe, expect, it } from 'vitest';
import { readDesktopEnv } from '../../../src/desktop/main/Env.js';
import { isTrustedFrameUrl } from '../../../src/desktop/main/TrustedFrame.js';

const desktopEnvSource = {
  environment: {},
  bundledAppEnvironment: undefined,
  isPackaged: false,
};

describe('desktop configuration boundary', () => {
  it('rejects non-local plaintext URLs and embedded credentials', () => {
    expect(() =>
      readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: 'http://example.test' }),
    ).toThrow('Desktop configuration is invalid.');
    expect(() =>
      readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: 'https://user:password@example.test' }),
    ).toThrow('Desktop configuration is invalid.');
  });

  it('uses the local API by default', () => {
    expect(readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: undefined }).API_BASE_URL).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('defaults to dev locally and prod when packaged, with an explicit stage mode', () => {
    expect(readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: undefined }).APP_ENV).toBe('dev');
    expect(
      readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: undefined, isPackaged: true }).APP_ENV,
    ).toBe('prod');
    expect(
      readDesktopEnv({
        ...desktopEnvSource,
        bundledApiUrl: undefined,
        bundledAppEnvironment: 'stage',
        isPackaged: true,
      }).APP_ENV,
    ).toBe('stage');
    expect(() =>
      readDesktopEnv({
        ...desktopEnvSource,
        bundledApiUrl: undefined,
        bundledAppEnvironment: 'test',
      }),
    ).toThrow('Desktop configuration is invalid.');
  });
});

describe('IPC document boundary', () => {
  it('rejects a foreign document even on the same origin', () => {
    expect(isTrustedFrameUrl('http://127.0.0.1:5173/foreign', 'http://127.0.0.1:5173/')).toBe(
      false,
    );
    expect(isTrustedFrameUrl('https://example.test/', 'http://127.0.0.1:5173/')).toBe(false);
    expect(isTrustedFrameUrl('file:///tmp/foreign.html', 'file:///app/index.html')).toBe(false);
  });

  it('permits hash changes in the application document', () => {
    expect(isTrustedFrameUrl('file:///app/index.html#settings', 'file:///app/index.html')).toBe(
      true,
    );
  });
});
