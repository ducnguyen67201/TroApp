import { runDevelopmentBootstrap } from './DevelopmentBootstrap.js';

try {
  await runDevelopmentBootstrap({ environment: process.env, nodeVersion: process.version });
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : 'Local development startup failed.');
  process.exitCode = 1;
}
