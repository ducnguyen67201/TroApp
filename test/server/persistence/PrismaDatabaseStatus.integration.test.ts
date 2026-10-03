import { describe, expect, it, vi } from 'vitest';
import {
  createPrismaDatabaseStatus,
  type DatabaseStatusLogger,
} from '../../../src/server/persistence/PrismaDatabaseStatus.js';
import { createApi } from '../../../src/server/CreateApi.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createServerLogger } from '../../../src/server/Logger.js';
import { SystemStatusSchema } from '#contracts/SystemStatus.js';

describe('Prisma/PostgreSQL wiring', () => {
  it('reports readiness through HTTP after real migrations', async () => {
    const environment = readServerEnv(process.env);
    const database = createPrismaDatabaseStatus(
      environment.DATABASE_URL,
      createServerLogger(environment.APP_ENV),
    );
    const api = createApi(database);

    try {
      const response = await api.inject('/health/ready');
      const body: unknown = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(SystemStatusSchema.parse(body).database).toBe('ready');
    } finally {
      await api.close();
      await database.close();
    }
  });

  it('converts an unavailable PostgreSQL connection into a safe unavailable result', async () => {
    const debug = vi.fn<DatabaseStatusLogger['debug']>();
    const database = createPrismaDatabaseStatus(
      'postgresql://synthetic:unused@127.0.0.1:1/unavailable',
      { debug },
    );

    try {
      expect(await database.isDatabaseReady()).toBe(false);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]?.[0]?.errorType).toBeTypeOf('string');
      expect(debug.mock.calls[0]?.[1]).toBe('Database readiness check failed.');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('synthetic');
    } finally {
      await database.close();
    }
  });
});
