import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  AuthStatus,
  HandoffExchangeRequestSchema,
  HandoffExchangeResponseSchema,
  WorkspaceCreateRequestSchema,
} from '#contracts/Auth.js';
import { DatabaseAvailability, SystemStatusSchema } from '#contracts/SystemStatus.js';
import { readServiceStatus } from './application/ReadServiceStatus.js';
import { AuthFailure, type AuthOperations } from './features/auth/AuthService.js';
import type { DatabaseStatus } from './ports/DatabaseStatus.js';

/** Composition only: routes delegate workflows to services and ports. */
export function createApi(database: DatabaseStatus, auth?: AuthOperations): FastifyInstance {
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

  if (auth) {
    registerAuthRoutes(api, auth);
  }

  api.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({ message: 'The request is invalid.' });
      return;
    }

    if (error instanceof AuthFailure) {
      void reply.code(401).send({ message: error.message });
      return;
    }

    void reply.code(500).send({ message: 'The service could not complete this request.' });
  });

  return api;
}

function registerAuthRoutes(api: FastifyInstance, auth: AuthOperations): void {
  api.post('/api/v1/auth/google/start', async (_request, reply) => {
    const authorizeUrl = await auth.startGoogleSignIn();

    return reply.header('cache-control', 'no-store').send({ authorizeUrl });
  });

  api.get('/api/v1/auth/google/callback', async (request, reply) => {
    const query = z
      .object({
        state: z.string().min(1).optional(),
        code: z.string().min(1).optional(),
        error: z.string().min(1).optional(),
        scope: z.string().optional(),
        authuser: z.string().optional(),
        prompt: z.string().optional(),
      })
      .parse(request.query);
    const redirectUrl = await auth.completeGoogleSignIn(query);

    return reply.header('cache-control', 'no-store').redirect(redirectUrl, 302);
  });

  api.post('/api/v1/auth/handoff', async (request, reply) => {
    const body = HandoffExchangeRequestSchema.parse(request.body);
    const result = HandoffExchangeResponseSchema.parse(await auth.exchangeHandoff(body.code));

    return reply.header('cache-control', 'no-store').send(result);
  });

  api.get('/api/v1/auth/session', async (request, reply) => {
    const state = await auth.readSession(readBearerToken(request.headers.authorization));

    return reply.header('cache-control', 'no-store').send(state);
  });

  api.post('/api/v1/workspaces', async (request, reply) => {
    const body = WorkspaceCreateRequestSchema.parse(request.body);
    const state = await auth.createWorkspace(
      readBearerToken(request.headers.authorization),
      body.displayName,
    );

    return reply.code(201).header('cache-control', 'no-store').send(state);
  });

  api.get('/api/v1/workspace', async (request, reply) => {
    const state = await auth.readSession(readBearerToken(request.headers.authorization));

    if (state.status !== AuthStatus.AUTHENTICATED) {
      return reply.code(403).send({ message: 'Workspace setup is required.' });
    }

    return reply.header('cache-control', 'no-store').send(state.workspace);
  });

  api.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(readBearerToken(request.headers.authorization));

    return reply.code(204).send();
  });
}

function readBearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(authorization ?? '');

  if (!match?.[1]) {
    throw new AuthFailure('Authentication is required.');
  }

  return match[1];
}
