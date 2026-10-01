import { createApi } from './CreateApi.js';
import { readServerEnv } from './Env.js';
import { AuthService } from './features/auth/AuthService.js';
import { createGoogleIdentityProvider } from './features/auth/GoogleIdentityProvider.js';
import { createServerLogger } from './Logger.js';
import { createPrismaAuthStore } from './persistence/PrismaAuthStore.js';
import { createPrismaDatabaseStatus } from './persistence/PrismaDatabaseStatus.js';

async function startApi(): Promise<void> {
  const environment = readServerEnv(process.env);
  const logger = createServerLogger(environment.APP_ENV);
  const database = createPrismaDatabaseStatus(environment.DATABASE_URL, logger);
  const authStore = createPrismaAuthStore(environment.DATABASE_URL);
  const google = createGoogleIdentityProvider({
    clientId: environment.GOOGLE_CLIENT_ID,
    clientSecret: environment.GOOGLE_CLIENT_SECRET,
    redirectUri: environment.GOOGLE_REDIRECT_URI,
  });
  const auth = new AuthService(authStore, google, {
    googleClientId: environment.GOOGLE_CLIENT_ID,
    googleRedirectUri: environment.GOOGLE_REDIRECT_URI,
  });
  const api = createApi(database, auth);

  api.addHook('onClose', async () => {
    await Promise.all([database.close(), auth.close()]);
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
