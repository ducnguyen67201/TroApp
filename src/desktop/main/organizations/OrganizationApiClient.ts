import {
  OrganizationCommandSchema,
  OrganizationFailure,
  OrganizationReplySchema,
  type OrganizationCommand,
  type OrganizationReply,
} from '#contracts/Organizations.js';

/** Organization authority uses the real session and an explicitly verified admin scope. */
export class OrganizationApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  async execute(command: OrganizationCommand): Promise<OrganizationReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: OrganizationFailure.UNAUTHORIZED };
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/organizations/command`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(OrganizationCommandSchema.parse(command)),
        signal: AbortSignal.timeout(10_000),
      });
      const raw: unknown = await response.json();
      return OrganizationReplySchema.parse(raw);
    } catch {
      return { kind: 'failed', code: OrganizationFailure.UNAVAILABLE };
    }
  }
}
