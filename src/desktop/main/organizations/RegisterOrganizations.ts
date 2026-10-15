import type { AuthResult } from '#contracts/AuthSession.js';
import { DesktopOrganizationRequestSchema } from '#contracts/DesktopOrganizations.js';
import {
  OrganizationAction,
  OrganizationFailure,
  OrganizationReplySchema,
  type OrganizationCommand,
  type OrganizationReply,
} from '#contracts/Organizations.js';
import type { AccountTransitionGate } from '../accounts/AccountTransitionGate.js';

export interface OrganizationAccess<Event> {
  isTrustedSender(event: Event): boolean;
  readSession(): Promise<AuthResult>;
  gate: AccountTransitionGate;
}

/** Holds the account gate through session verification and the authenticated HTTP operation. */
export function registerOrganizationsHandlers<Event>(
  ipc: {
    handle(
      channel: string,
      listener: (event: Event, raw: unknown) => Promise<OrganizationReply>,
    ): void;
  },
  access: OrganizationAccess<Event>,
  client: { execute(command: OrganizationCommand): Promise<OrganizationReply> },
  selectOrganization?: (organizationId: string | null) => Promise<OrganizationReply>,
): void {
  ipc.handle('tro:organizations', async (event, raw): Promise<OrganizationReply> => {
    const unavailable: OrganizationReply = {
      kind: 'failed',
      code: OrganizationFailure.UNAVAILABLE,
    };
    if (!access.isTrustedSender(event)) {
      return unavailable;
    }
    const parsed = DesktopOrganizationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'failed', code: OrganizationFailure.INVALID };
    }
    const action = async (): Promise<OrganizationReply> => {
      try {
        const session = await access.readSession();
        if (
          !access.isTrustedSender(event) ||
          session.kind !== 'signed-in' ||
          session.user.learner !== undefined ||
          session.user.id !== parsed.data.expectedAccountId
        ) {
          return unavailable;
        }
        const command = parsed.data.command;
        const reply = OrganizationReplySchema.parse(
          command.kind === OrganizationAction.SELECT_ADMIN_ORGANIZATION && selectOrganization
            ? await selectOrganization(command.organizationId)
            : await client.execute(command),
        );
        return access.isTrustedSender(event) ? reply : unavailable;
      } catch {
        console.warn('organizations.access.failed', { stage: 'authorize' });
        return unavailable;
      }
    };
    return parsed.data.command.kind === OrganizationAction.SELECT_ADMIN_ORGANIZATION
      ? access.gate.changeContext(action, unavailable)
      : access.gate.runRequest(action, unavailable);
  });
}
