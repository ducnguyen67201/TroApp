const LocalDatabasePort = '54329';
const LocalDatabaseName = '/tro';
const LocalDatabaseHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Refuses automatic development migrations unless both the app mode and target are local. */
export function validateLocalDevelopmentDatabase(environment: NodeJS.ProcessEnv): void {
  if (environment['APP_ENV'] !== 'dev') {
    throw new Error(
      'Automatic development migration refused: the Doppler config must set APP_ENV=dev.',
    );
  }

  const databaseUrl = environment['DATABASE_URL'];
  let target: URL;

  try {
    target = new URL(databaseUrl ?? '');
  } catch {
    throw new Error(
      'Automatic development migration refused: the Doppler config must provide a valid DATABASE_URL.',
    );
  }

  const isPostgreSql = target.protocol === 'postgresql:' || target.protocol === 'postgres:';
  const isComposeDatabase =
    LocalDatabaseHosts.has(target.hostname) &&
    target.port === LocalDatabasePort &&
    target.pathname === LocalDatabaseName;

  if (!isPostgreSql || !isComposeDatabase) {
    throw new Error(
      'Automatic development migration refused: DATABASE_URL must target the local Tro PostgreSQL database on loopback port 54329.',
    );
  }
}
