import { createApi } from './CreateApi.js';
import { readServerEnv } from './Env.js';
import { createServerLogger } from './Logger.js';
import { createPrismaDatabaseStatus } from './persistence/PrismaDatabaseStatus.js';

async function startApi(): Promise<void> {
  const environment = readServerEnv(process.env);
  const logger = createServerLogger(environment.APP_ENV);
  const database = createPrismaDatabaseStatus(environment.DATABASE_URL, logger);
  const api = createApi(database);

  api.addHook('onClose', async () => {
    await database.close();
  });

  try {
    await api.listen({ host: environment.HOST, port: environment.PORT });
  } catch (error: unknown) {
    await api.close();

    throw error;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void api.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }

  logger.info(
    { port: environment.PORT, appEnvironment: environment.APP_ENV },
    'Tro API is listening.',
  );
}

void startApi().catch(() => {
  console.error('Tro API could not start. Check configuration and port availability.');
  process.exitCode = 1;
});
