import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Group, Stack, Text, Textarea } from '@mantine/core';
import {
  InsightLimits,
  ReportStatus,
  type InsightWindow,
  type ParentReport,
} from '#contracts/ClassroomInsights.js';
import { formatInsightFailure } from './InsightLabels.js';
import { useInsightRequest } from './UseInsightRequest.js';
import { readInsightBridge } from './InsightBridge.js';

interface ParentReportReviewProps {
  userId: string;
  classId: string;
  studentId: string | null;
  studentName: string;
  window: InsightWindow;
}

/** A report stays pinned to its own child. Editing commentary requires another exact-revision approval. */
export function ParentReportReview({
  userId,
  classId,
  studentId,
  studentName,
  window: period,
}: ParentReportReviewProps): ReactElement {
  const scope = `${userId}:${classId}:${period.from}:${period.to}:${period.timezone}`;
  const request = useInsightRequest(scope);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [report, setReport] = useState<ParentReport | null>(null);
  const [commentary, setCommentary] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setReport(null);
    setCommentary('');
    setBusy(false);
    setMessage(null);
  }, [scope]);
  const dirty = report !== null && commentary !== report.commentary;

  async function saveReport(command: Parameters<typeof request>[0]): Promise<void> {
    setBusy(true);
    setMessage(null);
    const reply = await request(command, 'report');
    setBusy(false);
    if (reply.kind === 'failed') {
      setMessage(formatInsightFailure(reply));
    } else if (reply.kind === 'parent-report') {
      setReport(reply.report);
      setCommentary(reply.report.commentary);
    } else if (reply.kind === 'saved' && reply.record.kind === 'report') {
      setReport(reply.record.value);
      setCommentary(reply.record.value.commentary);
    }
  }

  return (
    <section aria-label="Parent report">
      <Stack gap="md">
        <div className="learning-heading">
          <div>
            <h3>Parent report</h3>
            <p>Review one child’s learning and next steps before saving a local copy.</p>
          </div>
          <Button
            variant="light"
            disabled={busy || !studentId}
            onClick={() => {
              if (!studentId) {
                return;
              }
              const id = crypto.randomUUID();
              void saveReport({
                kind: 'create-parent-report',
                classId,
                requestId: id,
                id,
                studentId,
                window: period,
              });
            }}
          >
            {report
              ? `Create new report for ${studentName}`
              : `Create report for ${studentName || 'selected student'}`}
          </Button>
        </div>
        {report && (
          <>
            <Text fw={600}>
              {report.studentName} · {new Date(report.identity.window.from).toLocaleDateString()}–
              {new Date(report.identity.window.to).toLocaleDateString()}
            </Text>
            <Text size="sm">
              Saved revision {report.version} ·{' '}
              {report.status === ReportStatus.APPROVED
                ? 'Approved by teacher'
                : report.status === ReportStatus.INVALIDATED
                  ? 'Needs a new review'
                  : 'Draft'}
            </Text>
            {report.invalidationReason && (
              <Text role="alert" c="red">
                {report.invalidationReason}
              </Text>
            )}
            <div className="learning-review-facts">
              <Text fw={600} size="sm">
                Learning facts from saved work
              </Text>
              {report.facts.map((fact) => (
                <p key={fact.id}>{fact.text}</p>
              ))}
              <details>
                <summary>Lesson counts and sources</summary>
                <table className="learning-count-table">
                  <thead>
                    <tr>
                      <th>Lesson</th>
                      <th>Met</th>
                      <th>Practice</th>
                      <th>No result</th>
                      <th>Review</th>
                      <th>Criteria</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sessions.map((session) => (
                      <tr key={session.classSessionId}>
                        <td>{new Date(session.observedAt).toLocaleDateString()}</td>
                        <td>{session.counts.met}</td>
                        <td>{session.counts.needsChanges}</td>
                        <td>{session.counts.notChecked + session.counts.insufficient}</td>
                        <td>{session.counts.conflict + session.counts.removed}</td>
                        <td>{session.counts.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Text size="xs">
                  Source cutoff {report.identity.sourceRevision}. Facts stay fixed in this report
                  revision; teacher commentary is separate.
                </Text>
              </details>
            </div>
            <Textarea
              label="Teacher’s note to parent"
              description="Your commentary is saved separately from the learning facts."
              value={commentary}
              maxLength={InsightLimits.MAX_COMMENTARY}
              autosize
              minRows={3}
              disabled={busy || report.status === ReportStatus.INVALIDATED}
              onChange={(event) => {
                setCommentary(event.currentTarget.value);
                setMessage(null);
              }}
            />
            {dirty && (
              <Text size="sm" role="status">
                Unsaved changes. Save and review the new revision before approving or exporting.
              </Text>
            )}
            <Group>
              <Button
                variant="default"
                disabled={busy || !dirty || report.status === ReportStatus.INVALIDATED}
                onClick={() => {
                  void saveReport({
                    kind: 'edit-parent-report',
                    classId,
                    requestId: crypto.randomUUID(),
                    id: report.id,
                    expectedVersion: report.version,
                    commentary,
                  });
                }}
              >
                Save note
              </Button>
              <Button
                disabled={busy || dirty || report.status !== ReportStatus.DRAFT}
                onClick={() => {
                  void saveReport({
                    kind: 'approve-parent-report',
                    classId,
                    requestId: crypto.randomUUID(),
                    id: report.id,
                    expectedVersion: report.version,
                  });
                }}
              >
                Approve revision {report.version}
              </Button>
              <Button
                variant="light"
                disabled={
                  busy ||
                  dirty ||
                  report.status !== ReportStatus.APPROVED ||
                  !readInsightBridge()?.exportParentReport
                }
                onClick={() => {
                  const exportReport = readInsightBridge()?.exportParentReport;
                  if (!exportReport) {
                    return;
                  }
                  const requestedScope = scope;
                  setBusy(true);
                  setMessage(null);
                  void exportReport({
                    classId,
                    reportId: report.id,
                    expectedVersion: report.version,
                  })
                    .then((reply) => {
                      if (currentScope.current !== requestedScope) {
                        return;
                      }
                      setBusy(false);
                      setMessage(
                        reply.saved
                          ? 'Approved report saved locally.'
                          : reply.code
                            ? formatInsightFailure({ kind: 'failed', code: reply.code })
                            : 'Export canceled.',
                      );
                    })
                    .catch(() => {
                      if (currentScope.current === requestedScope) {
                        setBusy(false);
                        setMessage('The local report could not be saved.');
                      }
                    });
                }}
              >
                Save approved report
              </Button>
              <Button
                variant="subtle"
                disabled={busy || dirty}
                onClick={() => {
                  void saveReport({ kind: 'read-parent-report', classId, id: report.id });
                }}
              >
                Refresh saved report
              </Button>
            </Group>
            <details>
              <summary>Report details</summary>
              <Text size="xs">
                Report {report.id} · teacher review {report.approvedAt ?? 'pending'}
              </Text>
            </details>
          </>
        )}
        {message && (
          <Text size="sm" role="status">
            {message}
          </Text>
        )}
      </Stack>
    </section>
  );
}
