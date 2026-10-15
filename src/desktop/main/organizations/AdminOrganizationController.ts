import { AdminOrganization } from '#contracts/AdminOrganization.js';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationReply,
} from '#contracts/Organizations.js';
import type { OrganizationApiClient } from './OrganizationApiClient.js';

/** Main owns selection and cancellation. Switching never changes cookies or impersonates a member. */
export class AdminOrganizationController {
  private organizationId: string | null = null;
  private cookie: string | null;
  private generation = 0;
  private pending = new AbortController();

  constructor(
    private readonly api: Pick<OrganizationApiClient, 'execute'>,
    private readonly readCookie: () => string | null,
    private readonly clearWorkspace: () => void,
    private readonly request: typeof fetch = fetch,
  ) {
    this.cookie = readCookie();
  }

  reset(): void {
    this.generation += 1;
    this.pending.abort();
    this.pending = new AbortController();
    this.organizationId = null;
    this.cookie = this.readCookie();
    this.clearWorkspace();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.cookie !== this.readCookie()) {
      this.reset();
    }
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    const scoped =
      /^\/api\/v1\/(organizations|classroom|lesson-videos|student-access|pet-world)(?:\/|$)/.test(
        path,
      );
    if (!scoped) {
      return this.request(input, init);
    }
    const generation = this.generation;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete(AdminOrganization.HEADER);
    headers.delete('x-tro-classroom-view-as');
    if (this.organizationId && headers.has('cookie')) {
      headers.set(AdminOrganization.HEADER, this.organizationId);
    }
    const response = await this.request(input, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([init.signal, this.pending.signal])
        : this.pending.signal,
    });
    if (generation !== this.generation || this.cookie !== this.readCookie()) {
      throw new Error('Organization changed.');
    }
    return response;
  };

  async selectOrganization(organizationId: string | null): Promise<OrganizationReply> {
    // Exiting remains possible when authority has been revoked or the server is unavailable.
    if (organizationId === null) {
      this.reset();
      return { kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION, organization: null };
    }
    const cookie = this.readCookie();
    const generation = this.generation;
    const reply = await this.api.execute({
      kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION,
      organizationId,
    });
    if (cookie !== this.readCookie() || generation !== this.generation) {
      return { kind: 'failed', code: OrganizationFailure.UNAVAILABLE };
    }
    if (reply.kind !== OrganizationAction.SELECT_ADMIN_ORGANIZATION) {
      return reply;
    }
    if (reply.organization?.id !== organizationId) {
      return { kind: 'failed', code: OrganizationFailure.INVALID };
    }
    this.reset();
    this.organizationId = organizationId;
    return reply;
  }
}
