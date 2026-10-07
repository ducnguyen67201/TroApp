import { randomUUID } from 'node:crypto';
import {
  ClassroomToolRequestSchema,
  ClassroomFailure,
  type ClassroomReply,
  type ClassroomToolCommand,
  type ClassroomToolResponseSchema,
} from '#contracts/Classroom.js';
import type { z } from 'zod';

/** Correlated private worker/main calls; cancellation settles every pending tool. */
export class ClassroomToolClient {
  private readonly pending = new Map<string, (reply: ClassroomReply) => void>();

  constructor(
    private readonly send: (message: z.infer<typeof ClassroomToolRequestSchema>) => void,
    private readonly taskRequestId: string,
    private readonly participationId: string,
    private readonly signal: AbortSignal,
  ) {}

  request(command: ClassroomToolCommand): Promise<ClassroomReply> {
    if (this.signal.aborted) {
      return Promise.resolve({ kind: 'failed', code: ClassroomFailure.STALE });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (reply: ClassroomReply): void => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
        this.pending.delete(requestId);
        resolve(reply);
      };
      const abort = (): void => {
        finish({ kind: 'failed', code: ClassroomFailure.STALE });
      };
      const timer = setTimeout(() => {
        finish({ kind: 'failed', code: ClassroomFailure.UNAVAILABLE });
      }, 15_000);
      this.pending.set(requestId, finish);
      this.signal.addEventListener('abort', abort, { once: true });
      try {
        this.send(
          ClassroomToolRequestSchema.parse({
            kind: 'classroom-tool',
            requestId,
            taskRequestId: this.taskRequestId,
            participationId: this.participationId,
            command,
          }),
        );
      } catch {
        finish({ kind: 'failed', code: ClassroomFailure.UNAVAILABLE });
      }
    });
  }

  receive(response: z.infer<typeof ClassroomToolResponseSchema>): void {
    this.pending.get(response.requestId)?.(response.reply);
  }

  dispose(): void {
    for (const finish of this.pending.values()) {
      finish({ kind: 'failed', code: ClassroomFailure.STALE });
    }
  }
}
