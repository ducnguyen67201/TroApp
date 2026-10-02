import { describe, expect, it } from 'vitest';
import { readDesktopReleaseEnv } from '../../scripts/Env.js';

describe('desktop release settings', () => {
  it('matches production env-file settings and gives the shell precedence', () => {
    expect(
      readDesktopReleaseEnv(
        {},
        { MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/file/' },
      ).updateFeedUrl,
    ).toBe('https://downloads.example.test/file/');
    expect(
      readDesktopReleaseEnv(
        { MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/shell/' },
        { MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/file/' },
      ).updateFeedUrl,
    ).toBe('https://downloads.example.test/shell/');
    expect(readDesktopReleaseEnv({}).updateFeedUrl).toBeUndefined();
    expect(readDesktopReleaseEnv({ MAIN_VITE_UPDATE_FEED_URL: '' }).updateFeedUrl).toBeUndefined();
  });

  it('rejects an unsafe feed without including its value in the failure', () => {
    expect(() =>
      readDesktopReleaseEnv({
        MAIN_VITE_UPDATE_FEED_URL: 'http://private.example.test/?secret=value',
      }),
    ).toThrow('Desktop release configuration is invalid.');
  });
});
