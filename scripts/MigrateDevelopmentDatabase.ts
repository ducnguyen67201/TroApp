import { z } from 'zod';
import { validateLocalDevelopmentDatabase } from './LocalDevelopmentDatabase.js';
import { CommandOutput, executeCommand } from './RunCommand.js';

async function migrateDevelopmentDatabase(): Promise<void> {
  validateLocalDevelopmentDatabase(process.env);
  const packageCli = z.string().min(1).parse(process.env['npm_execpath']);

  await executeCommand({
    command: process.execPath,
    arguments: [packageCli, 'exec', 'prisma', 'migrate', 'dev'],
    environment: process.env,
    output: CommandOutput.INHERIT,
  });
}

try {
  await migrateDevelopmentDatabase();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : 'Development migration failed.');
  process.exitCode = 1;
}
