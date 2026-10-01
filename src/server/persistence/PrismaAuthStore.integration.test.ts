import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthStatus } from '#contracts/Auth.js';
import { PrismaClient, UserRole } from '../generated/prisma/client.js';
import { createPrismaAuthStore } from './PrismaAuthStore.js';

const databaseUrl = process.env['DATABASE_URL'];

if (!databaseUrl) {
  throw new Error('Integration DATABASE_URL is required.');
}

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const store = createPrismaAuthStore(databaseUrl);
const future = new Date('2100-01-01T00:00:00.000Z');
const now = new Date('2026-09-30T12:00:00.000Z');

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createPendingSession(subject: string, token: string): Promise<void> {
  const identity = await client.authIdentity.create({
    data: {
      googleSubject: subject,
      email: `${subject}@example.test`,
      emailVerified: true,
    },
  });
  await client.session.create({
    data: { tokenHash: hash(token), identityId: identity.id, expiresAt: future },
  });
}

beforeAll(async () => {
  await client.session.deleteMany();
  await client.authHandoff.deleteMany();
  await client.oAuthFlow.deleteMany();
  await client.user.deleteMany();
  await client.authIdentity.deleteMany();
  await client.workspace.deleteMany();
});

afterAll(async () => {
  await Promise.all([client.$disconnect(), store.close()]);
});

describe('workspace persistence invariants', () => {
  it('atomically creates a workspace and its required owner relationship', async () => {
    const token = 'first-session-token';
    await createPendingSession('first-subject', token);

    const state = await store.createWorkspace({
      tokenHash: hash(token),
      displayName: 'First Studio',
      now,
    });
    const user = await client.user.findUnique({
      where: { googleSubject: 'first-subject' },
      include: { workspace: true },
    });

    expect(state?.status).toBe(AuthStatus.AUTHENTICATED);
    expect(user?.workspace.displayName).toBe('First Studio');
    expect(user?.role).toBe(UserRole.OWNER);
  });

  it('permits several users in one workspace while each user has one required workspace', async () => {
    const workspace = await client.workspace.findFirstOrThrow({
      where: { displayName: 'First Studio' },
    });
    await client.user.create({
      data: {
        googleSubject: 'second-subject',
        email: 'second@example.test',
        emailVerified: true,
        workspaceId: workspace.id,
        role: UserRole.MEMBER,
      },
    });

    expect(await client.user.count({ where: { workspaceId: workspace.id } })).toBe(2);
  });

  it('rolls back workspace creation when the Google subject uniqueness invariant fails', async () => {
    const token = 'conflicting-session-token';
    const identity = await client.authIdentity.findUniqueOrThrow({
      where: { googleSubject: 'first-subject' },
    });
    await client.session.create({
      data: { tokenHash: hash(token), identityId: identity.id, expiresAt: future },
    });
    const countBefore = await client.workspace.count();

    await expect(
      store.createWorkspace({ tokenHash: hash(token), displayName: 'Rolled Back', now }),
    ).rejects.toThrow();
    expect(await client.workspace.count()).toBe(countBefore);
    expect(await client.workspace.findFirst({ where: { displayName: 'Rolled Back' } })).toBeNull();
  });

  it('invalidates a revoked session', async () => {
    const token = 'revoked-session-token';
    await createPendingSession('revoked-subject', token);

    expect(await store.readSession(hash(token), now)).not.toBeNull();
    await store.revokeSession(hash(token), now);
    expect(await store.readSession(hash(token), now)).toBeNull();
  });
});
