import { randomUUID } from 'node:crypto';
import { ContextFailure, type ContextCommand, type ContextReply } from '#contracts/StudyContext.js';
import {
  ContextWorkerRequestSchema,
  type ContextWorkerResponseSchema,
} from '#contracts/DesktopContext.js';
import type { z } from 'zod';

export class ContextToolClient {
  private readonly pending = new Map<string, (reply: ContextReply) => void>();

  constructor(
    private readonly send: (request: z.infer<typeof ContextWorkerRequestSchema>) => void,
    private readonly taskRequestId: string,
    private readonly signal: AbortSignal,
  ) {}

  request(command: ContextCommand): Promise<ContextReply> {
    if (this.signal.aborted) {
      return Promise.resolve({ kind: 'failed', code: ContextFailure.STALE });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (reply: ContextReply): void => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
        this.pending.delete(requestId);
        resolve(reply);
      };
      const abort = (): void => {
        finish({ kind: 'failed', code: ContextFailure.STALE });
      };
      const timer = setTimeout(() => {
        finish({ kind: 'failed', code: ContextFailure.UNAVAILABLE });
      }, 26_000);
      this.pending.set(requestId, finish);
      this.signal.addEventListener('abort', abort, { once: true });
      try {
        this.send(
          ContextWorkerRequestSchema.parse({
            kind: 'context-request',
            requestId,
            taskRequestId: this.taskRequestId,
            command,
          }),
        );
      } catch {
        finish({ kind: 'failed', code: ContextFailure.UNAVAILABLE });
      }
    });
  }

  receive(response: z.infer<typeof ContextWorkerResponseSchema>): void {
    this.pending.get(response.requestId)?.(response.reply);
  }

  dispose(): void {
    for (const finish of this.pending.values()) {
      finish({ kind: 'failed', code: ContextFailure.STALE });
    }
  }
}
