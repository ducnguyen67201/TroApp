import {
  ClassroomCommandSchema,
  ClassroomReplySchema,
  ClassroomFailure,
  type ClassroomCommand,
  type ClassroomReply,
  type TeachingContext,
} from '#contracts/Classroom.js';

/** Main alone attaches the session cookie; neither renderer nor model receives it. */
export class ClassroomApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  async watch(context: TeachingContext, signal: AbortSignal, refresh: () => void): Promise<void> {
    const cookie = this.readCookie();
    if (!cookie) {
      return;
    }
    const query = new URLSearchParams({
      participationId: context.participation.id,
      deviceId: context.participation.deviceId,
      activityId: context.activity.id,
    });
    const response = await this.request(
      `${this.baseUrl}/api/v1/classroom/updates?${query.toString()}`,
      { headers: { cookie }, signal },
    );
    if (!response.ok || !response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 4096) {
          throw new Error('Classroom update exceeds limits.');
        }
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event === 'data: refresh') {
            refresh();
          }
          end = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async execute(command: ClassroomCommand): Promise<ClassroomReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: ClassroomFailure.UNAUTHORIZED };
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/classroom/command`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(ClassroomCommandSchema.parse(command)),
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json();
      return ClassroomReplySchema.parse(body);
    } catch {
      return { kind: 'failed', code: ClassroomFailure.UNAVAILABLE };
    }
  }
}
