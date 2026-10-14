import { expect, it, vi } from 'vitest';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationCommand,
  type OrganizationReply,
} from '#contracts/Organizations.js';
import {
  registerOrganizationsHandlers,
  type OrganizationAccess,
} from '../../../../src/desktop/main/organizations/RegisterOrganizations.js';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';

interface TestEvent {
  trusted: boolean;
}

function createHandlers() {
  const gate = new AccountTransitionGate(
    () => false,
    () => false,
  );
  const access = {
    gate,
    isTrustedSender: (event: TestEvent) => event.trusted,
    readSession: vi.fn<OrganizationAccess<TestEvent>['readSession']>().mockResolvedValue({
      kind: 'signed-in',
      user: { id: 'current', name: 'Sample', email: 'sample@example.test', isAdmin: false },
    }),
  } satisfies OrganizationAccess<TestEvent>;
  const client = {
    execute: vi
      .fn<(command: OrganizationCommand) => Promise<OrganizationReply>>()
      .mockResolvedValue({ kind: 'home', organizations: [], isAdmin: false }),
  };
  const handlers = new Map<
    string,
    (event: TestEvent, raw: unknown) => Promise<OrganizationReply>
  >();
  registerOrganizationsHandlers(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    access,
    client,
  );
  return {
    access,
    client,
    gate,
    invoke: async (
      raw: unknown,
      event: TestEvent = { trusted: true },
    ): Promise<OrganizationReply> => {
      const handler = handlers.get('tro:organizations');
      if (!handler) {
        throw new Error('Missing organizations handler');
      }
      return handler(event, raw);
    },
  };
}

it('rejects untrusted senders, stale identities and injected capabilities before HTTP access', async () => {
  const { invoke, access, client } = createHandlers();
  const request = { expectedAccountId: 'current', command: { kind: OrganizationAction.HOME } };
  expect(await invoke(request, { trusted: false })).toEqual({
    kind: 'failed',
    code: OrganizationFailure.UNAVAILABLE,
  });
  expect(access.readSession).not.toHaveBeenCalled();
  expect(await invoke({ ...request, expectedAccountId: 'previous' })).toEqual({
    kind: 'failed',
    code: OrganizationFailure.UNAVAILABLE,
  });
  expect(await invoke({ ...request, cookie: 'injected' })).toEqual({
    kind: 'failed',
    code: OrganizationFailure.INVALID,
  });
  expect(
    await invoke({
      ...request,
      command: {
        kind: 'change-role',
        organizationId: '11111111-1111-4111-8111-111111111111',
        userId: 'student',
        role: 'owner',
      },
    }),
  ).toEqual({ kind: 'failed', code: OrganizationFailure.INVALID });
  expect(client.execute).not.toHaveBeenCalled();
  expect(await invoke(request)).toMatchObject({ kind: 'home' });
  expect(client.execute).toHaveBeenCalledExactlyOnceWith({ kind: OrganizationAction.HOME });
});

it('holds account transitions through the request and checks the sender after verification', async () => {
  const { invoke, access, client, gate } = createHandlers();
  let finishSession:
    | ((reply: Awaited<ReturnType<OrganizationAccess<TestEvent>['readSession']>>) => void)
    | undefined;
  access.readSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSession = resolve;
      }),
  );
  const event = { trusted: true };
  const pending = invoke(
    { expectedAccountId: 'current', command: { kind: OrganizationAction.HOME } },
    event,
  );
  expect((await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  event.trusted = false;
  finishSession?.({
    kind: 'signed-in',
    user: { id: 'current', name: 'Sample', email: 'sample@example.test', isAdmin: false },
  });
  expect(await pending).toEqual({ kind: 'failed', code: OrganizationFailure.UNAVAILABLE });
  expect(client.execute).not.toHaveBeenCalled();
  expect(await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).toEqual({
    kind: 'signed-out',
  });
});

it('withholds private replies if the trusted document changes while HTTP is in flight', async () => {
  const { invoke, client, gate } = createHandlers();
  let finishRequest: ((reply: OrganizationReply) => void) | undefined;
  client.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRequest = resolve;
      }),
  );
  const event = { trusted: true };
  const pending = invoke(
    { expectedAccountId: 'current', command: { kind: OrganizationAction.HOME } },
    event,
  );
  await Promise.resolve();
  expect((await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  event.trusted = false;
  finishRequest?.({
    kind: 'invitation',
    code: 'a'.repeat(43),
    expiresAt: '2026-10-21T12:00:00.000Z',
  });
  expect(await pending).toEqual({ kind: 'failed', code: OrganizationFailure.UNAVAILABLE });
});
