import { MaterialFailure } from '#contracts/ClassroomMaterials.js';
import {
  MaterialCommandSchema,
  MaterialReplySchema,
  type MaterialCommand,
  type MaterialReply,
} from '#contracts/ClassroomMaterials.js';

const MaterialRequestFailure = {
  REQUEST: 'request_failed',
  INVALID_REPLY: 'invalid_reply',
  REFUSED: 'refused',
} as const;

/** Only main attaches cookies. Downloads expose file IDs, never backend credentials or paths. */
export class MaterialApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
    private readonly reportFailure: (event: {
      operation: MaterialCommand['kind'];
      classId: string;
      reason: (typeof MaterialRequestFailure)[keyof typeof MaterialRequestFailure];
      httpStatus: number | null;
      validationIssueCount?: number;
      code: MaterialFailure;
    }) => void = () => {},
  ) {}
  async execute(command: MaterialCommand): Promise<MaterialReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: MaterialFailure.FORBIDDEN };
    }
    let httpStatus: number | null = null;
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/classroom/materials`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(MaterialCommandSchema.parse({ ...command, materialSchemaVersion: 2 })),
        signal: AbortSignal.timeout(30_000),
      });
      httpStatus = response.status;
      const raw: unknown = await response.json();
      if (this.readCookie() !== cookie) {
        return { kind: 'failed', code: MaterialFailure.FORBIDDEN };
      }
      const parsed = MaterialReplySchema.safeParse(raw);
      if (!parsed.success) {
        this.reportFailure({
          operation: command.kind,
          classId: command.classId,
          reason: MaterialRequestFailure.INVALID_REPLY,
          httpStatus,
          validationIssueCount: parsed.error.issues.length,
          code: MaterialFailure.UNAVAILABLE,
        });
        return { kind: 'failed', code: MaterialFailure.UNAVAILABLE };
      }
      if (parsed.data.kind === 'failed') {
        this.reportFailure({
          operation: command.kind,
          classId: command.classId,
          reason: MaterialRequestFailure.REFUSED,
          httpStatus,
          code: parsed.data.code,
        });
      }
      return parsed.data;
    } catch {
      this.reportFailure({
        operation: command.kind,
        classId: command.classId,
        reason: MaterialRequestFailure.REQUEST,
        httpStatus,
        code: MaterialFailure.UNAVAILABLE,
      });
      return { kind: 'failed', code: MaterialFailure.UNAVAILABLE };
    }
  }
}
