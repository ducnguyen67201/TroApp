import { PrismaPg } from '@prisma/adapter-pg';
import { AuthStatus, WorkspaceRole, type AuthState } from '#contracts/Auth.js';
import { PrismaClient, UserRole } from '../generated/prisma/client.js';
import type { AuthStore, VerifiedGoogleIdentity } from '../features/auth/AuthService.js';

interface StoredIdentity {
  googleSubject: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface StoredUser {
  id: string;
  role: UserRole;
  workspace: { id: string; displayName: string };
}

function createAuthState(identity: StoredIdentity, user: StoredUser | null): AuthState {
  const profile = {
    email: identity.email,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
  };

  if (!user) {
    return { status: AuthStatus.NEEDS_WORKSPACE, profile };
  }

  return {
    status: AuthStatus.AUTHENTICATED,
    profile,
    workspace: {
      id: user.workspace.id,
      displayName: user.workspace.displayName,
      role: user.role === UserRole.OWNER ? WorkspaceRole.OWNER : WorkspaceRole.MEMBER,
    },
  };
}

/** Keeps generated Prisma types and authentication persistence behind one adapter. */
export function createPrismaAuthStore(databaseUrl: string): AuthStore {
  const adapter = new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
  const client = new PrismaClient({ adapter });

  return {
    async saveOAuthFlow(input): Promise<void> {
      await client.oAuthFlow.create({ data: input });
    },

    async consumeOAuthFlow(stateHash, usedAt) {
      return client.$transaction(async (transaction) => {
        const flow = await transaction.oAuthFlow.findUnique({ where: { stateHash } });

        if (!flow || flow.usedAt || flow.expiresAt <= usedAt) {
          return null;
        }

        const consumed = await transaction.oAuthFlow.updateMany({
          where: { id: flow.id, usedAt: null, expiresAt: { gt: usedAt } },
          data: { usedAt },
        });

        return consumed.count === 1 ? { codeVerifier: flow.codeVerifier, nonce: flow.nonce } : null;
      });
    },

    async saveIdentityAndHandoff(input): Promise<void> {
      await client.$transaction(async (transaction) => {
        const identity = await transaction.authIdentity.upsert({
          where: { googleSubject: input.identity.googleSubject },
          create: mapIdentity(input.identity),
          update: mapIdentity(input.identity),
        });

        await transaction.authHandoff.create({
          data: {
            codeHash: input.codeHash,
            identityId: identity.id,
            expiresAt: input.expiresAt,
          },
        });
      });
    },

    async exchangeHandoff(input) {
      return client.$transaction(async (transaction) => {
        const handoff = await transaction.authHandoff.findUnique({
          where: { codeHash: input.codeHash },
          include: { identity: true },
        });

        if (!handoff || handoff.usedAt || handoff.expiresAt <= input.usedAt) {
          return null;
        }

        const consumed = await transaction.authHandoff.updateMany({
          where: { id: handoff.id, usedAt: null, expiresAt: { gt: input.usedAt } },
          data: { usedAt: input.usedAt },
        });

        if (consumed.count !== 1) {
          return null;
        }

        const user = await transaction.user.findUnique({
          where: { googleSubject: handoff.identity.googleSubject },
          include: { workspace: true },
        });

        await transaction.session.create({
          data: {
            tokenHash: input.tokenHash,
            identityId: handoff.identityId,
            expiresAt: input.expiresAt,
            ...(user ? { userId: user.id } : {}),
          },
        });

        return createAuthState(handoff.identity, user);
      });
    },

    async readSession(tokenHash, now) {
      const session = await client.session.findFirst({
        where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
        include: { identity: true, user: { include: { workspace: true } } },
      });

      return session ? createAuthState(session.identity, session.user) : null;
    },

    async createWorkspace(input) {
      return client.$transaction(async (transaction) => {
        const session = await transaction.session.findFirst({
          where: {
            tokenHash: input.tokenHash,
            revokedAt: null,
            expiresAt: { gt: input.now },
          },
          include: { identity: true, user: { include: { workspace: true } } },
        });

        if (!session || session.user) {
          return null;
        }

        const workspace = await transaction.workspace.create({
          data: {
            displayName: input.displayName,
            users: {
              create: {
                googleSubject: session.identity.googleSubject,
                email: session.identity.email,
                emailVerified: session.identity.emailVerified,
                displayName: session.identity.displayName,
                avatarUrl: session.identity.avatarUrl,
                role: UserRole.OWNER,
              },
            },
          },
          include: { users: true },
        });
        const owner = workspace.users[0];

        if (!owner) {
          throw new Error('Workspace owner creation failed.');
        }

        await transaction.session.update({
          where: { id: session.id },
          data: { userId: owner.id },
        });

        return createAuthState(session.identity, {
          id: owner.id,
          role: owner.role,
          workspace: { id: workspace.id, displayName: workspace.displayName },
        });
      });
    },

    async revokeSession(tokenHash, revokedAt): Promise<void> {
      await client.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt },
      });
    },

    async close(): Promise<void> {
      await client.$disconnect();
    },
  };
}

function mapIdentity(identity: VerifiedGoogleIdentity) {
  return {
    googleSubject: identity.googleSubject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
  };
}
