import { describe, expect, it } from 'vitest';
import configuration from '../../electron.vite.config';

describe('worker bundle configuration', () => {
  it('preserves only the optional ws native probes without externalizing the SDK', () => {
    expect(configuration.main?.build?.commonjsOptions?.ignore).toEqual([
      'bufferutil',
      'utf-8-validate',
    ]);
    expect(configuration.main?.build?.externalizeDeps).toBe(false);
  });
});
