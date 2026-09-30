import Fastify, { type FastifyInstance } from 'fastify';
import { DatabaseAvailability, SystemStatusSchema } from '#contracts/SystemStatus.js';
import { readServiceStatus } from './application/ReadServiceStatus.js';
import type { DatabaseStatus } from './ports/DatabaseStatus.js';

/** Composition only: routes delegate workflows to services and ports. */
export function createApi(database: DatabaseStatus): FastifyInstance {
  const api = Fastify({ logger: false });

  api.get('/health/live', () => ({ service: 'tro-api', alive: true }));

  /* Keep liveness independent of PostgreSQL; readiness controls whether this
     instance should receive traffic when the database is unavailable. */
  api.get('/health/ready', async (_request, reply) => {
    const status = SystemStatusSchema.parse(await readServiceStatus(database));

    return reply.code(status.database === DatabaseAvailability.READY ? 200 : 503).send(status);
  });

  api.get('/api/v1/system/status', async () => {
    return SystemStatusSchema.parse(await readServiceStatus(database));
  });

  api.setErrorHandler((_error, _request, reply) => {
    void reply.code(500).send({ message: 'The service could not complete this request.' });
  });

  return api;
}
