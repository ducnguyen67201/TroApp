import {
  PetWorldCommandSchema,
  PetWorldCommandKind,
  PetWorldAssetId,
  PetWorldFailure,
  PetWorldReplySchema,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';

/** Authenticated transport; cookies and untrusted JSON stay out of the renderer. */
export class PetWorldApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  async execute(command: PetWorldCommand, signal?: AbortSignal): Promise<PetWorldReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: PetWorldFailure.UNAUTHORIZED };
    }
    try {
      const timeout = AbortSignal.timeout(30_000);
      const response = await this.request(`${this.baseUrl}/api/v1/pet-world/command`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(
          PetWorldCommandSchema.parse(
            command.kind === PetWorldCommandKind.CATALOG
              ? {
                  ...command,
                  supportedAssetIds: command.supportedAssetIds ?? Object.values(PetWorldAssetId),
                }
              : command,
          ),
        ),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const raw: unknown = await response.json();
      if (signal?.aborted) {
        return { kind: 'failed', code: PetWorldFailure.STALE };
      }
      if (cookie !== this.readCookie()) {
        return { kind: 'failed', code: PetWorldFailure.UNAVAILABLE };
      }
      const reply = PetWorldReplySchema.parse(raw);
      return response.ok || reply.kind === 'failed'
        ? reply
        : { kind: 'failed', code: PetWorldFailure.UNAVAILABLE };
    } catch {
      return {
        kind: 'failed',
        code: signal?.aborted ? PetWorldFailure.STALE : PetWorldFailure.UNAVAILABLE,
      };
    }
  }
}
