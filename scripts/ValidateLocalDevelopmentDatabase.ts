import { validateLocalDevelopmentDatabase } from './LocalDevelopmentDatabase.js';

try {
  validateLocalDevelopmentDatabase(process.env);
  console.info('Doppler local-development database target is safe.');
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : 'Local database validation failed.');
  process.exitCode = 1;
}
