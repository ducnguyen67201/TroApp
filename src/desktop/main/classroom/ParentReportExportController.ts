import { randomUUID } from 'node:crypto';
import {
  InsightFailure,
  ParentReportExportCommandSchema,
  ReportStatus,
  type ParentReportExportReply,
} from '#contracts/ClassroomInsights.js';
import type { AccountTransitionGate } from '../accounts/AccountTransitionGate.js';
import type { ClassroomInsightApiClient } from './ClassroomInsightApiClient.js';
import type { ReportFileWriter } from './AtomicReportFile.js';
import { formatParentReportHtml } from './FormatParentReportHtml.js';

export interface ParentReportDestination {
  choose(): Promise<string | null>;
}

/** Main owns the native destination and writes only a freshly authorized approved revision. */
export class ParentReportExportController {
  private generation = 0;
  private exporting = false;
  private requests = new AbortController();

  constructor(
    private readonly api: Pick<ClassroomInsightApiClient, 'execute'>,
    private readonly accounts: AccountTransitionGate,
    private readonly destination: ParentReportDestination,
    private readonly files: ReportFileWriter,
    private readonly readCookie: () => string | null,
  ) {}

  async export(raw: unknown, isTrusted: () => boolean): Promise<ParentReportExportReply> {
    if (!isTrusted()) {
      return { saved: false, code: InsightFailure.FORBIDDEN };
    }
    const parsed = ParentReportExportCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { saved: false, code: InsightFailure.INVALID };
    }
    if (this.exporting) {
      return { saved: false, code: InsightFailure.UNAVAILABLE };
    }
    const generation = this.generation;
    const cookie = this.readCookie();
    const signal = this.requests.signal;
    const canCommit = (): boolean =>
      Boolean(
        cookie &&
        cookie === this.readCookie() &&
        generation === this.generation &&
        !signal.aborted &&
        isTrusted(),
      );
    if (!canCommit()) {
      return { saved: false, code: InsightFailure.FORBIDDEN };
    }
    this.exporting = true;
    try {
      return await this.accounts.runRequest<ParentReportExportReply>(
        async () => {
          try {
            const path = await this.destination.choose();
            if (!path) {
              return { saved: false, code: null };
            }
            if (!canCommit()) {
              return { saved: false, code: InsightFailure.STALE };
            }
            const command = parsed.data;
            const reply = await this.api.execute(
              {
                kind: 'export-parent-report',
                classId: command.classId,
                id: command.reportId,
                expectedVersion: command.expectedVersion,
                requestId: randomUUID(),
              },
              signal,
            );
            if (!canCommit()) {
              return { saved: false, code: InsightFailure.STALE };
            }
            if (reply.kind === 'failed') {
              return { saved: false, code: reply.code };
            }
            if (
              reply.kind !== 'export' ||
              reply.report.id !== command.reportId ||
              reply.report.classId !== command.classId ||
              reply.report.version !== command.expectedVersion ||
              reply.report.status !== ReportStatus.APPROVED ||
              reply.report.invalidationReason !== null ||
              reply.report.identity.studentId !== reply.report.studentId ||
              reply.report.identity.classId !== command.classId
            ) {
              return { saved: false, code: InsightFailure.INVALID };
            }
            const saved = await this.files.save(
              path,
              formatParentReportHtml(reply.report),
              canCommit,
            );
            return {
              saved,
              code: saved ? null : canCommit() ? InsightFailure.UNAVAILABLE : InsightFailure.STALE,
            };
          } catch {
            return { saved: false, code: InsightFailure.UNAVAILABLE };
          }
        },
        { saved: false, code: InsightFailure.UNAVAILABLE },
      );
    } finally {
      this.exporting = false;
    }
  }

  dispose(): void {
    this.generation += 1;
    this.requests.abort();
    this.requests = new AbortController();
  }
}
