import {
  MaterialCommandSchema,
  MaterialFailure,
  type MaterialPreviewReply,
} from '#contracts/ClassroomMaterials.js';
import type { MaterialApiClient } from './MaterialApiClient.js';
import type { AccountTransitionGate } from '../accounts/AccountTransitionGate.js';

/** Reads originals through backend class authorization, fenced against account transitions. */
export class MaterialPreviewController {
  constructor(
    private readonly api: Pick<MaterialApiClient, 'execute'>,
    private readonly accounts: AccountTransitionGate,
  ) {}

  async readOriginal(raw: unknown, isTrusted: () => boolean): Promise<MaterialPreviewReply> {
    if (!isTrusted()) {
      return { kind: 'failed', code: MaterialFailure.FORBIDDEN };
    }
    const command = MaterialCommandSchema.safeParse(raw);
    if (!command.success || command.data.kind !== 'download') {
      return { kind: 'failed', code: MaterialFailure.INVALID };
    }
    return this.accounts.runRequest<MaterialPreviewReply>(
      async () => {
        const result = await this.api.execute(command.data);
        if (!isTrusted() || result.kind === 'collection') {
          return { kind: 'failed', code: MaterialFailure.UNAVAILABLE };
        }
        return result;
      },
      { kind: 'failed', code: MaterialFailure.UNAVAILABLE },
    );
  }
}
