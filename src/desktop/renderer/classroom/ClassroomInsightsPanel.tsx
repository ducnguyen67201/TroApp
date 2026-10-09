import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button, Group, Select, Stack, Tabs, Text, TextInput } from '@mantine/core';
import {
  InsightWindowSchema,
  type ClassroomInsightReply,
  type InsightClassSummary,
  type InsightStudentProgress,
  type InsightWindow,
} from '#contracts/ClassroomInsights.js';
import type { TeachingContext } from '#contracts/Classroom.js';
import { useInsightRequest } from './UseInsightRequest.js';
import { formatInsightFailure } from './InsightLabels.js';
import { StudentLearningProgress } from './StudentLearningProgress.js';
import { InsightDefinitionEditor } from './InsightDefinitionEditor.js';
import { TeacherHelpQueue } from './TeacherHelpQueue.js';
import { StudentHelpRequest } from './StudentHelpRequest.js';
import { ParentReportReview } from './ParentReportReview.js';
import { readInsightBridge } from './InsightBridge.js';
import './ClassroomInsights.css';

interface ClassroomInsightsPanelProps {
  userId: string;
  classId: string;
  teacher: boolean;
  classSessionId?: string | null;
  context?: TeachingContext | null;
}

function formatDateInput(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createDefaultWindow(): InsightWindow {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setDate(start.getDate() - 30);
  start.setHours(0, 0, 0, 0);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** Production insight views use authorized server summaries. Collection policy remains backend-owned. */
export function ClassroomInsightsPanel({
  userId,
  classId,
  teacher,
  classSessionId = null,
  context = null,
}: ClassroomInsightsPanelProps): ReactElement {
  const [period, setPeriod] = useState(createDefaultWindow);
  const [from, setFrom] = useState(() => formatDateInput(new Date(period.from)));
  const [to, setTo] = useState(() => formatDateInput(new Date(period.to)));
  const [status, setStatus] = useState<Extract<ClassroomInsightReply, { kind: 'status' }> | null>(
    null,
  );
  const [statusScope, setStatusScope] = useState('');
  const [summary, setSummary] = useState<InsightClassSummary | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [progress, setProgress] = useState<InsightStudentProgress | null>(null);
  const [progressScope, setProgressScope] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const classScope = `${userId}:${classId}:${period.from}:${period.to}:${period.timezone}:${classSessionId ?? ''}`;
  const request = useInsightRequest(classScope);
  const studentScope = `${classScope}:${studentId ?? ''}`;
  const studentRequest = useInsightRequest(studentScope);
  const refresh = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    setStatus(null);
    setSummary(null);
    setProgress(null);
    setStudentId(null);
    setMessage(null);
  }, [classScope]);
  useEffect(() => {
    const lifetime = new AbortController();

    function isCurrent(): boolean {
      return !lifetime.signal.aborted;
    }

    setMessage(null);
    setBusy(true);
    void request({ kind: 'status', classId }, 'status').then(async (reply) => {
      if (!isCurrent()) {
        return;
      }
      if (reply.kind === 'failed') {
        setMessage(formatInsightFailure(reply));
        setBusy(false);
        return;
      }
      if (reply.kind !== 'status') {
        setMessage('Learning insights could not be loaded.');
        setBusy(false);
        return;
      }
      setStatus(reply);
      setStatusScope(classScope);
      setStudentId((current) =>
        reply.students.some((student) => student.id === current)
          ? current
          : teacher
            ? (reply.students[0]?.id ?? null)
            : userId,
      );
      if (reply.enabled && teacher && reply.teacher) {
        const classReply = await request(
          {
            kind: 'read-class-insights',
            classId,
            window: period,
            ...(classSessionId ? { classSessionId } : {}),
          },
          'class-summary',
        );
        if (!isCurrent()) {
          return;
        }
        if (classReply.kind === 'class-insights') {
          setSummary(classReply.summary);
        } else if (classReply.kind === 'failed') {
          setMessage(formatInsightFailure(classReply));
        }
      }
      if (isCurrent()) {
        setBusy(false);
      }
    });
    return () => {
      lifetime.abort();
    };
  }, [request, classId, teacher, userId, period, classSessionId, version]);
  useEffect(() => {
    const lifetime = new AbortController();

    function isCurrent(): boolean {
      return !lifetime.signal.aborted;
    }

    setProgress(null);
    if (!status?.enabled || !studentId) {
      return;
    }
    void studentRequest(
      { kind: 'read-student-progress', classId, studentId, window: period },
      'progress',
    ).then((reply) => {
      if (!isCurrent()) {
        return;
      }
      if (reply.kind === 'student-progress') {
        setProgress(reply.progress);
        setProgressScope(studentScope);
      } else if (reply.kind === 'failed') {
        setMessage(formatInsightFailure(reply));
      }
    });
    return () => {
      lifetime.abort();
    };
  }, [status?.enabled, classId, studentId, period, studentRequest, version]);
  const visibleStatus = statusScope === classScope ? status : null;
  const visibleProgress = progressScope === studentScope ? progress : null;
  const isTeacher = teacher && visibleStatus?.teacher === true;
  const selectedName =
    visibleStatus?.students.find((student) => student.id === studentId)?.name ??
    visibleProgress?.name ??
    '';
  const hasControls = Boolean(readInsightBridge()?.controlClassroomInsights);
  return (
    <section className="learning-insights" aria-label="Learning insights">
      <Group justify="space-between">
        <h2>Learning insights</h2>
        <Button variant="default" size="xs" disabled={busy || !hasControls} onClick={refresh}>
          Refresh
        </Button>
      </Group>
      {!hasControls ? (
        <Text size="sm" c="dimmed">
          Learning insights are unavailable in this app version.
        </Text>
      ) : (
        <>
          {busy && (
            <Text size="sm" role="status">
              Loading learning insights…
            </Text>
          )}
          {message && (
            <Text size="sm" role="alert">
              {message}
            </Text>
          )}
          {visibleStatus && !visibleStatus.enabled && (
            <Text size="sm" c="dimmed">
              Learning insights are unavailable for this class. Collection permissions must be in
              place before the feature is enabled.
            </Text>
          )}
          {visibleStatus?.enabled && (
            <>
              <Group align="end">
                <TextInput
                  type="date"
                  label="From"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.currentTarget.value);
                  }}
                />
                <TextInput
                  type="date"
                  label="Through"
                  value={to}
                  onChange={(event) => {
                    setTo(event.currentTarget.value);
                  }}
                />
                <Button
                  variant="light"
                  onClick={() => {
                    const start = new Date(`${from}T00:00:00`);
                    const end = new Date(`${to}T23:59:59.999`);
                    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
                      setMessage('Choose valid dates.');
                      return;
                    }
                    const parsed = InsightWindowSchema.safeParse({
                      from: start.toISOString(),
                      to: end.toISOString(),
                      timezone: period.timezone,
                    });
                    if (!parsed.success) {
                      setMessage('Choose an ordered reporting period of at most 186 days.');
                      return;
                    }
                    setPeriod(parsed.data);
                  }}
                >
                  Apply period
                </Button>
                {isTeacher && (
                  <Select
                    label="Student"
                    value={studentId}
                    data={visibleStatus.students.map((student) => ({
                      value: student.id,
                      label: student.name,
                    }))}
                    onChange={setStudentId}
                    searchable
                  />
                )}
              </Group>
              {isTeacher ? (
                <Tabs defaultValue="journey" keepMounted>
                  <Tabs.List>
                    <Tabs.Tab value="journey">Student journey</Tabs.Tab>
                    <Tabs.Tab value="class">Class insights</Tabs.Tab>
                    <Tabs.Tab value="parent">Parent report</Tabs.Tab>
                    <Tabs.Tab value="definitions">Learning definitions</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="journey" pt="lg">
                    {visibleProgress ? (
                      <StudentLearningProgress
                        key={studentScope}
                        userId={userId}
                        progress={visibleProgress}
                        status={visibleStatus}
                        teacher
                        classSessionId={classSessionId}
                        send={studentRequest}
                        onSaved={refresh}
                      />
                    ) : (
                      <Text size="sm">Choose a student to see saved work.</Text>
                    )}
                  </Tabs.Panel>
                  <Tabs.Panel value="class" pt="lg">
                    <Stack gap="lg">
                      {summary && (
                        <>
                          <div className="learning-stat-grid">
                            <div className="learning-stat">
                              <span>Assigned students</span>
                              <strong>{summary.eligible ?? '—'}</strong>
                              <small>From this lesson’s approved assignment</small>
                            </div>
                            <div className="learning-stat">
                              <span>Students with checked work</span>
                              <strong>{summary.checked}</strong>
                              <small>Results within the selected period</small>
                            </div>
                            <div className="learning-stat">
                              <span>No checked result shown</span>
                              <strong>{summary.unknown ?? '—'}</strong>
                              <small>Unknown when assignment coverage is missing</small>
                            </div>
                          </div>
                          {summary.criteria.map((criterion) => (
                            <article key={criterion.criterionId} className="learning-work-card">
                              <h3>{criterion.description}</h3>
                              <p>
                                {criterion.counts.needsChanges} need practice ·{' '}
                                {criterion.counts.met} met ·{' '}
                                {criterion.counts.insufficient + criterion.counts.notChecked} no
                                result shown ·{' '}
                                {criterion.counts.conflict + criterion.counts.removed} need review
                              </p>
                            </article>
                          ))}
                          <Text size="xs" c="dimmed">
                            Latest saved findings through revision {summary.identity.sourceRevision}
                            . A past result does not show who needs help right now.
                          </Text>
                          <TeacherHelpQueue
                            classId={classId}
                            requests={summary.openSupport}
                            students={visibleStatus.students}
                            send={request}
                            onSaved={refresh}
                          />
                        </>
                      )}
                    </Stack>
                  </Tabs.Panel>
                  <Tabs.Panel value="parent" pt="lg">
                    <ParentReportReview
                      key={classScope}
                      userId={userId}
                      classId={classId}
                      studentId={studentId}
                      studentName={selectedName}
                      window={period}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="definitions" pt="lg">
                    <InsightDefinitionEditor
                      key={classScope}
                      classId={classId}
                      classSessionId={classSessionId}
                      status={visibleStatus}
                      send={request}
                      onSaved={refresh}
                    />
                  </Tabs.Panel>
                </Tabs>
              ) : (
                <Stack gap="lg">
                  {visibleProgress && (
                    <StudentLearningProgress
                      key={studentScope}
                      userId={userId}
                      progress={visibleProgress}
                      status={visibleStatus}
                      teacher={false}
                      classSessionId={classSessionId}
                      send={studentRequest}
                      onSaved={refresh}
                    />
                  )}
                  {context && (
                    <StudentHelpRequest
                      key={`${context.participation.id}:${context.activity.id}:${String(context.meeting.contextVersion)}`}
                      context={context}
                      send={studentRequest}
                      onSaved={refresh}
                    />
                  )}
                </Stack>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
