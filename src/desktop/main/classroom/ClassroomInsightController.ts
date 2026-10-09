import {
  ClassroomInsightCommandSchema,
  InsightFailure,
  type ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import type { AccountTransitionGate } from '../accounts/AccountTransitionGate.js';
import type { ClassroomSessionController } from './ClassroomSessionController.js';
import type { ClassroomInsightApiClient } from './ClassroomInsightApiClient.js';

/** Validates the feature boundary and fences all replies by local lifetime and participation. */
export class ClassroomInsightController {
  private generation = 0;
  private requests = new AbortController();

  constructor(
    private readonly api: Pick<ClassroomInsightApiClient, 'execute'>,
    private readonly accounts: AccountTransitionGate,
    private readonly classroom: Pick<ClassroomSessionController, 'executeInsights'>,
  ) {}

  async execute(raw: unknown, isTrusted: () => boolean): Promise<ClassroomInsightReply> {
    if (!isTrusted()) {
      return { kind: 'failed', code: InsightFailure.FORBIDDEN };
    }
    const parsed = ClassroomInsightCommandSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind === 'export-parent-report') {
      return { kind: 'failed', code: InsightFailure.INVALID };
    }
    const generation = this.generation;
    const signal = this.requests.signal;
    return this.accounts.runRequest<ClassroomInsightReply>(
      async () => {
        try {
          const reply = await this.classroom.executeInsights(parsed.data, (command) =>
            this.api.execute(command, signal),
          );
          return generation === this.generation && isTrusted()
            ? reply
            : { kind: 'failed', code: InsightFailure.STALE };
        } catch {
          return { kind: 'failed', code: InsightFailure.UNAVAILABLE };
        }
      },
      { kind: 'failed', code: InsightFailure.UNAVAILABLE },
    );
  }

  dispose(): void {
    this.generation += 1;
    this.requests.abort();
    this.requests = new AbortController();
  }
}
