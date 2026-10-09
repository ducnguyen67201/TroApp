import { useLocale } from '../localization/UseLocale.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Modal, Stack, Text } from '@mantine/core';
import { AssessmentMethod, type InsightStudentProgress } from '#contracts/ClassroomInsights.js';
import { PracticeFinding, type PracticeEvidence } from '#contracts/PracticeCheck.js';
import { formatAssistance, formatInsightFailure } from './InsightLabels.js';
import { useInsightRequest } from './UseInsightRequest.js';

interface StudentWorkGalleryProps {
  userId: string;
  progress: InsightStudentProgress;
  selectedSessionId: string | null;
}

/** One card per saved task episode; evidence is fetched privately only when requested. */
export function StudentWorkGallery({
  userId,
  progress,
  selectedSessionId,
}: StudentWorkGalleryProps): ReactElement {
  const { locale, messages } = useLocale();
  const t = messages.translateInsight;
  const scope = `${userId}:${progress.identity.classId}:${progress.studentId}:${progress.identity.window.from}:${progress.identity.window.to}:${selectedSessionId ?? ''}`;
  const request = useInsightRequest(scope);
  const currentScope = useRef({ scope, sequence: 0 });
  if (currentScope.current.scope !== scope) {
    currentScope.current = { scope, sequence: 0 };
  }
  const [opened, setOpened] = useState(false);
  const [evidence, setEvidence] = useState<PracticeEvidence[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    setOpened(false);
    setEvidence([]);
    setMessage(null);
    setBusy(false);
  }, [scope]);
  const tasks = new Map<string, InsightStudentProgress['assessments']>();
  const supersededIds = new Set(
    progress.assessments.flatMap((assessment) =>
      assessment.supersedesId ? [assessment.supersedesId] : [],
    ),
  );
  for (const assessment of progress.assessments) {
    if (
      supersededIds.has(assessment.id) ||
      (selectedSessionId && assessment.classSessionId !== selectedSessionId)
    ) {
      continue;
    }
    const checks = tasks.get(assessment.episodeId) ?? [];
    const current = checks.find((check) => check.id === assessment.id);
    if (!current || current.version < assessment.version) {
      tasks.set(assessment.episodeId, [
        ...checks.filter((check) => check.id !== assessment.id),
        assessment,
      ]);
    }
  }
  const work = [...tasks.entries()].sort((left, right) =>
    (right[1][0]?.observedAt ?? '').localeCompare(left[1][0]?.observedAt ?? ''),
  );
  return (
    <section aria-label={t('Recent work')}>
      <div className="learning-work-heading">
        <h3>{t('Recent work')}</h3>
        <p>{t('Tasks and submitted work from the selected lesson.')}</p>
      </div>
      <div className="learning-work-grid">
        {work.map(([episodeId, checks]) => (
          <article key={episodeId} className="learning-work-card">
            <h3>{checks[0]?.title}</h3>
            <p>{checks[0]?.task}</p>
            {checks.length > 1 && (
              <p>
                {t(
                  '{count} observations of this task. Review their results and support separately.',
                  { count: checks.length },
                )}
              </p>
            )}
            {checks.map((assessment) => (
              <div key={assessment.id}>
                <Text size="xs">
                  {t(formatAssistance(assessment.assistance, assessment.unaidedConfirmed))} ·{' '}
                  {assessment.method === AssessmentMethod.TEACHER
                    ? t('Teacher observation')
                    : t('Practice check')}
                </Text>
                <ul>
                  {assessment.results.map((result) => (
                    <li key={result.criterionId}>
                      {
                        assessment.criteria.find((criterion) => criterion.id === result.criterionId)
                          ?.description
                      }
                      :{' '}
                      {result.finding === PracticeFinding.MET
                        ? t('Met')
                        : result.finding === PracticeFinding.NEEDS_CHANGES
                          ? t('Needs practice')
                          : t('More evidence needed')}
                      <p>{result.feedback}</p>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="light"
                  size="xs"
                  disabled={busy || (!assessment.snapshotId && !assessment.checkId)}
                  onClick={() => {
                    setOpened(true);
                    setTitle(assessment.title);
                    setEvidence([]);
                    setMessage(null);
                    setBusy(true);
                    const requestedScope = currentScope.current;
                    const sequence = requestedScope.sequence + 1;
                    requestedScope.sequence = sequence;
                    void request(
                      {
                        kind: 'read-evidence',
                        classId: progress.identity.classId,
                        studentId: progress.studentId,
                        assessmentId: assessment.id,
                      },
                      'evidence',
                    ).then((reply) => {
                      if (
                        currentScope.current !== requestedScope ||
                        requestedScope.sequence !== sequence
                      ) {
                        return;
                      }
                      setBusy(false);
                      if (reply.kind === 'evidence') {
                        setEvidence(reply.evidence);
                      } else if (reply.kind === 'failed') {
                        setMessage(formatInsightFailure(reply));
                      }
                    });
                  }}
                >
                  {t('View saved work')}
                </Button>
                {!assessment.snapshotId && !assessment.checkId && (
                  <p>{t('Teacher observation; no saved artifact attached.')}</p>
                )}
                <details>
                  <summary>{t('Check details')}</summary>
                  <Text size="xs">
                    {t('Observed')} {new Date(assessment.observedAt).toLocaleString(locale)} ·{' '}
                    {t('saved')} {new Date(assessment.recordedAt).toLocaleString(locale)}
                    <br />
                    {t(assessment.purpose)} · {t(assessment.status)}
                    <br />
                    {t('Source')} {assessment.id} · {t('version')} {assessment.version} ·{' '}
                    {t('cutoff')} {assessment.sourceRevision}
                    <br />
                    {assessment.mappingId
                      ? t('Approved skill definition version {version}', {
                          version: assessment.mappingVersion ?? t('unknown'),
                        })
                      : t('No approved comparable skill mapping attached')}
                  </Text>
                </details>
              </div>
            ))}
          </article>
        ))}
        {progress.submissions
          .filter(
            (submission) =>
              (!selectedSessionId || submission.classSessionId === selectedSessionId) &&
              submission.sourceKind === 'link',
          )
          .map((submission) => (
            <article key={submission.id} className="learning-work-card">
              <h3>{t('Submitted link')}</h3>
              <p>{new Date(submission.submittedAt).toLocaleString(locale)}</p>
              <p>{t('A link was handed in. Its contents were not captured as checked work.')}</p>
            </article>
          ))}
      </div>
      {work.length === 0 && <p>{t('No checked tasks shown for this lesson.')}</p>}
      <Modal
        opened={opened}
        title={title ?? t('Saved work')}
        onClose={() => {
          setOpened(false);
        }}
        size="lg"
      >
        <Stack>
          {busy && <Text>{t('Loading saved work…')}</Text>}
          {message && <Text role="alert">{t(message)}</Text>}
          {!busy && !message && evidence.length === 0 && (
            <Text>{t('No saved artifact is available for this observation.')}</Text>
          )}
          {evidence.map((item) => (
            <div key={item.id}>
              <Text fw={600}>{item.name}</Text>
              {item.kind === 'text' ? (
                <pre className="learning-evidence-text">{item.text}</pre>
              ) : (
                <img
                  className="learning-evidence-image"
                  alt={item.name}
                  src={`data:${item.mediaType};base64,${item.base64}`}
                />
              )}
            </div>
          ))}
        </Stack>
      </Modal>
    </section>
  );
}
