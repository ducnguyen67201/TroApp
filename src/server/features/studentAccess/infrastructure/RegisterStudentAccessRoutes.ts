import { StudentAccessKind, StudentStaffAccessKinds } from '#contracts/StudentAccess.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { StudentAccessCommandSchema, StudentAccessPath } from '#contracts/StudentAccess.js';
import { ClassroomCommandSchema } from '#contracts/Classroom.js';
import { StudentAccessService, hasStudentCookie } from '../application/StudentAccessService.js';
import {
  StudentAccessError,
  StudentAccessPolicy,
  type StudentAccessStore,
} from '../application/StudentAccessStore.js';
import { InvitationAttempts } from '../../classroom/application/InvitationAttempts.js';

/** Allowlisted learner routes preserve session capabilities instead of treating a learner as a general Google user. */
export function registerStudentAccessRoutes(
  api: FastifyInstance,
  store: StudentAccessStore,
  readGoogleUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  secret: string,
  log: Pick<Logger, 'warn'> = api.log,
) {
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const service = new StudentAccessService(
    store,
    digest,
    () => {
      const credential = randomBytes(32).toString('hex');
      return { credential, digest: digest(credential) };
    },
    (code, requestId) => {
      const credential = createHmac('sha256', secret)
        .update(`tro-student-device:${code}:${requestId}`)
        .digest('hex');
      return { credential, digest: digest(credential) };
    },
  );
  const attempts = new InvitationAttempts(StudentAccessPolicy.REQUEST_ATTEMPTS_PER_IP);
  const allowedCommands = new Set([
    'home',
    'join',
    'resume',
    'context',
    'read-material-notes',
    'search-material',
    'read-material-source',
    'leave',
    'save-workspace',
    'report-progress',
    'prepare-submission',
    'submit-work',
  ]);

  api.addHook('preHandler', async (request, reply) => {
    if (!hasStudentCookie(request.headers)) {
      return;
    }
    const path = request.url.split('?')[0];
    if (path === `${StudentAccessPath}/session` || path === `${StudentAccessPath}/sign-out`) {
      return;
    }
    const principal = await service.readPrincipal(request.headers);
    if (!principal) {
      return reply.code(401).send({ kind: 'failed', message: 'Your student session has ended.' });
    }
    if (request.method === 'GET' && path === '/api/v1/model/credential') {
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/classroom/updates') {
      const query =
        typeof request.query === 'object' && request.query !== null ? request.query : {};
      const command = ClassroomCommandSchema.safeParse({ ...query, kind: 'context' });
      if (command.success && (await store.canAccessClassroom(principal, command.data))) {
        return;
      }
    }
    if (request.method === 'POST' && path === '/api/v1/classroom/command') {
      const command = ClassroomCommandSchema.safeParse(request.body);
      if (
        command.success &&
        allowedCommands.has(command.data.kind) &&
        (await store.canAccessClassroom(principal, command.data))
      ) {
        if (
          command.data.kind === 'join' &&
          principal.meetingId &&
          command.data.classSessionId !== principal.meetingId
        ) {
          return reply.code(403).send({ kind: 'failed', code: 'forbidden' });
        }
        return;
      }
    }
    return reply.code(403).send({ kind: 'failed', code: 'forbidden' });
  });

  api.get(`${StudentAccessPath}/session`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const principal = await service.readPrincipal(request.headers);
    return principal
      ? { user: principal.user, role: 'student', expiresAt: principal.expiresAt.toISOString() }
      : reply.code(401).send({ kind: 'signed-out' });
  });
  api.post(`${StudentAccessPath}/sign-out`, async (request, reply) => {
    if (request.headers.origin !== 'app.tro.desktop:/') {
      return reply.code(403).send({ kind: 'failed', message: 'Invalid sign-out request.' });
    }
    await service.revoke(request.headers);
    return reply.header('cache-control', 'no-store').send({ kind: 'done' });
  });
  api.post(`${StudentAccessPath}/session`, async (request, reply) => {
    if (request.headers.origin !== 'app.tro.desktop:/') {
      return reply.code(403).send({ kind: 'failed', message: 'Invalid session request.' });
    }
    const principal = await service.refreshPrincipal(request.headers);
    return principal
      ? reply.header('cache-control', 'no-store').send({
          user: principal.user,
          role: 'student',
          expiresAt: principal.expiresAt.toISOString(),
        })
      : reply.code(401).send({ kind: 'signed-out' });
  });
  api.post(`${StudentAccessPath}/command`, { bodyLimit: 150_000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.headers.origin !== 'app.tro.desktop:/') {
      return reply.code(403).send({ kind: 'failed', message: 'Invalid student access request.' });
    }
    const parsed = StudentAccessCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ kind: 'failed', message: 'Check the class code, student ID and name.' });
    }
    const command = parsed.data;
    const rawDevice = request.headers['x-tro-student-device'];
    const device =
      typeof rawDevice === 'string' && /^[a-f0-9]{64}$/.test(rawDevice) ? rawDevice : null;
    if (command.kind !== StudentAccessKind.STATUS && !attempts.canAttempt(request.ip, Date.now())) {
      return reply
        .code(429)
        .send({ kind: 'failed', message: 'Please wait a minute before trying again.' });
    }
    try {
      const teacherId = StudentStaffAccessKinds.includes(command.kind)
        ? await readGoogleUserId(request.headers)
        : null;
      if (command.kind === StudentAccessKind.CREATE_ADMISSION && teacherId) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const code = [...randomBytes(16)].map((value) => alphabet[value % 32]).join('');
        const now = new Date();
        await store.createAdmission(teacherId, command, digest(code), now);
        return {
          kind: 'admission',
          code,
          mode: command.mode,
          expiresAt: new Date(now.getTime() + StudentAccessPolicy.ACTIVATION_MS).toISOString(),
        };
      }
      return await service.execute(command, device, teacherId);
    } catch (error) {
      log.warn(
        {
          operation: command.kind,
          reason: error instanceof StudentAccessError ? 'refused' : 'storage',
          requestId: request.id,
        },
        'student.access.failed',
      );
      return reply.code(error instanceof StudentAccessError ? 403 : 503).send({
        kind: 'failed',
        message:
          error instanceof StudentAccessError
            ? error.message
            : 'Student access is temporarily unavailable. Please try again.',
      });
    }
  });

  return {
    service,
    readUserId: async (headers: IncomingHttpHeaders): Promise<string | null> =>
      hasStudentCookie(headers)
        ? ((await service.readPrincipal(headers))?.user.id ?? null)
        : readGoogleUserId(headers),
  };
}
