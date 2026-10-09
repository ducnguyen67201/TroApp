import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { PracticeEvidence, PracticeReply } from '#contracts/PracticeCheck.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import { formatPracticeFinding, PracticeEvidencePreview } from './PracticeCheckPanel.js';
export function PracticeTeacherResults({
  sessionId,
  t,
}: {
  sessionId: string;
  t: ClassroomTranslate;
}): ReactElement {
  const [history, setHistory] = useState<Extract<
      PracticeReply,
      { kind: 'teacher-history' }
    > | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [evidence, setEvidence] = useState<PracticeEvidence[] | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setHistory(null);
    setEvidence(null);
    setError(false);
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [sessionId]);

  async function load(checkId?: string): Promise<void> {
    const version = generation.current;
    setBusy(true);
    setError(false);
    try {
      const reply = await window.tro.controlPractice?.(
        checkId
          ? { kind: 'read-evidence', checkId }
          : { kind: 'teacher-history', classSessionId: sessionId },
      );
      if (version !== generation.current) {
        return;
      }
      if (reply?.kind === 'teacher-history') {
        setHistory(reply);
      } else if (reply?.kind === 'evidence') {
        setEvidence(reply.evidence);
      } else {
        setError(true);
      }
    } catch {
      if (version === generation.current) {
        setError(true);
      }
    } finally {
      if (version === generation.current) {
        setBusy(false);
      }
    }
  }

  return (
    <Stack mt="md">
      <Group justify="space-between">
        <Text fw={600}>{t('Practice feedback and hand-ins', 'Phản hồi thực hành và bài nộp')}</Text>
        <Button
          variant="default"
          size="xs"
          loading={busy}
          onClick={() => {
            void load();
          }}
        >
          {t('Refresh checks', 'Cập nhật kiểm tra')}
        </Button>
      </Group>
      {error && <Alert>{t('Could not load. Try again.', 'Chưa tải được. Hãy thử lại.')}</Alert>}
      {history?.students.map((student) => (
        <Stack className="practice-criterion-result" key={student.studentId} gap={5}>
          <Text fw={500}>{student.name}</Text>
          {student.checks.length === 0 && (
            <Text size="sm">{t('No checks yet', 'Chưa có lượt kiểm tra')}</Text>
          )}
          {student.checks.slice(0, 5).map((check) => (
            <Stack key={check.id} gap={4}>
              <Text size="sm">
                {check.rubric.title} ·{' '}
                {check.status === 'completed'
                  ? formatPracticeFinding(check.finding, t)
                  : check.status === 'running'
                    ? t('Checking', 'Đang kiểm tra')
                    : t('Could not check', 'Chưa kiểm tra được')}
              </Text>
              {check.assessment && (
                <details>
                  <summary>{t('Evaluation evidence', 'Bằng chứng đánh giá')}</summary>
                  <Text size="xs">
                    {check.assessment.evaluators.map((evaluator) => evaluator.id).join(', ')}
                  </Text>
                  {check.assessment.units.map((unit, index) => (
                    <Stack key={`${unit.evidenceId}:${String(index)}`} gap={2}>
                      <Text size="xs">{unit.location}</Text>
                      <pre className="practice-evidence-text">{unit.text}</pre>
                    </Stack>
                  ))}
                </details>
              )}
              {check.results
                .filter((result) => result.finding !== 'met')
                .map((result) => (
                  <Text key={result.criterionId} size="xs">
                    {result.feedback}
                  </Text>
                ))}
              <Button
                variant="subtle"
                size="xs"
                disabled={busy}
                onClick={() => {
                  void load(check.id);
                }}
              >
                {t('View evidence', 'Xem bằng chứng')}
              </Button>
            </Stack>
          ))}
          {student.submissions.map((submission) => (
            <Text size="xs" key={submission.id}>
              {t('Hand-in revision', 'Phiên bản bài nộp')} {submission.sequence} ·{' '}
              {new Date(submission.submittedAt).toLocaleString()}{' '}
              <Button
                variant="subtle"
                size="xs"
                disabled={busy}
                onClick={() => {
                  void load(submission.checkId);
                }}
              >
                {t('Open', 'Mở')}
              </Button>
            </Text>
          ))}
        </Stack>
      ))}
      <Modal
        opened={evidence !== null}
        onClose={() => {
          setEvidence(null);
        }}
        title={t('Student evidence', 'Bằng chứng của học sinh')}
        size="lg"
      >
        <PracticeEvidencePreview evidence={evidence ?? []} />
      </Modal>
    </Stack>
  );
}
