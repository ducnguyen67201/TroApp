import { describe, expect, it } from 'vitest';
import { AppEnvironment } from '#contracts/AppEnvironment.js';
import { createServerLogger } from '../../src/server/Logger.js';

describe('backend log level', () => {
  it('enables debug only in dev', () => {
    expect(createServerLogger(AppEnvironment.DEV).isLevelEnabled('debug')).toBe(true);
    expect(createServerLogger(AppEnvironment.STAGE).isLevelEnabled('debug')).toBe(false);
    expect(createServerLogger(AppEnvironment.PROD).isLevelEnabled('debug')).toBe(false);
  });
});
