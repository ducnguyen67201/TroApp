import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  PetRecognitionCategory,
  PetWorldCommandKind,
  PetWorldFailure,
  PetWorldReplySchema,
} from '#contracts/PetWorld.js';
import { PetWorldService } from '../../../../src/server/features/petWorld/application/PetWorldService.js';
import { registerPetWorldRoutes } from '../../../../src/server/features/petWorld/infrastructure/RegisterPetWorldRoutes.js';
import { MemoryPetWorldStore, PetWorldFixtureIds } from './PetWorldFixtures.js';

function createApi() {
  const api = fastify();
  const store = new MemoryPetWorldStore();
  const service = new PetWorldService(store);
  const log = { warn: vi.fn(), error: vi.fn() };
  registerPetWorldRoutes(
    api,
    (headers) =>
      Promise.resolve(typeof headers['x-test-user'] === 'string' ? headers['x-test-user'] : null),
    service,
    log,
  );
  return { api, store, log };
}

describe('Pet World HTTP boundary', () => {
  it('requires authentication and rejects untrusted point claims before writes', async () => {
    const { api, store } = createApi();
    try {
      const anonymous = await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        payload: { kind: PetWorldCommandKind.OWN_WORLD },
      });
      expect(anonymous.statusCode).toBe(401);
      const invalid = await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        headers: { 'x-test-user': 'student' },
        payload: { kind: PetWorldCommandKind.OWN_WORLD, balance: '1000' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(store.wallets.size).toBe(0);
    } finally {
      await api.close();
    }
  });

  it('returns private validated teacher receipts and refuses a student issuer', async () => {
    const { api, store, log } = createApi();
    const payload = {
      kind: PetWorldCommandKind.GRANT_POINTS,
      requestId: randomUUID(),
      classId: PetWorldFixtureIds.CLASS,
      studentIds: ['student'],
      pointsPerStudent: '9007199254740993',
      category: PetRecognitionCategory.CURIOSITY,
      note: 'A private teacher note.',
    };
    try {
      const denied = await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        headers: { 'x-test-user': 'student' },
        payload,
      });
      expect(denied.statusCode).toBe(403);
      const result = await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        headers: { 'x-test-user': 'teacher' },
        payload,
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      const body: unknown = result.json();
      expect(PetWorldReplySchema.parse(body).kind).toBe('granted');
      expect(result.body).not.toContain('balance');
      expect(store.entries.size).toBe(1);
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(payload.note);
    } finally {
      await api.close();
    }
  });

  it('maps request conflicts to 409 and opaque internal failures to 503', async () => {
    const { api, store, log } = createApi();
    const payload = {
      kind: PetWorldCommandKind.GRANT_POINTS,
      requestId: randomUUID(),
      classId: PetWorldFixtureIds.CLASS,
      studentIds: ['student'],
      pointsPerStudent: '10',
      category: PetRecognitionCategory.OTHER,
    };
    try {
      await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        headers: { 'x-test-user': 'teacher' },
        payload,
      });
      const conflict = await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        headers: { 'x-test-user': 'teacher' },
        payload: { ...payload, pointsPerStudent: '20' },
      });
      expect(conflict.statusCode).toBe(409);
      const conflictBody: unknown = conflict.json();
      expect(PetWorldReplySchema.parse(conflictBody)).toEqual({
        kind: 'failed',
        code: PetWorldFailure.REQUEST_CONFLICT,
      });
      store.failOnReceipt = true;
      const failure = await api.inject({
        method: 'POST',
        url: '/api/v1/pet-world/command',
        headers: { 'x-test-user': 'teacher' },
        payload: { ...payload, requestId: randomUUID() },
      });
      expect(failure.statusCode).toBe(503);
      expect(failure.body).not.toContain('Synthetic');
      expect(log.error).toHaveBeenCalled();
      expect(store.entries.size).toBe(1);
    } finally {
      await api.close();
    }
  });
});
