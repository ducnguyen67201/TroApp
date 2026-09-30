import pino, { type Logger } from 'pino';
import { AppEnvironment } from '#contracts/AppEnvironment.js';

/** Creates structured backend logs; debug records are emitted only in dev. */
export function createServerLogger(appEnvironment: AppEnvironment): Logger {
  return pino({
    name: 'tro-api',
    level: appEnvironment === AppEnvironment.DEV ? 'debug' : 'info',
  });
}
