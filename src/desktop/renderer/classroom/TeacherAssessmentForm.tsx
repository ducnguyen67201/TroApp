import { useState, type ReactElement } from 'react';
import { Button, Checkbox, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import {
  AssistanceContext,
  AssessmentPurpose,
  ClassroomInsightCommandSchema,
  type ClassroomInsightCommand,
  type ClassroomInsightReply,
  type InsightStudentProgress,
} from '#contracts/ClassroomInsights.js';
import { PracticeFinding } from '#contracts/PracticeCheck.js';
import { formatInsightFailure } from './InsightLabels.js';
import { selectLatestMappings } from './InsightDefinitions.js';

interface TeacherAssessmentFormProps {
  progress: InsightStudentProgress;
  status: Extract<ClassroomInsightReply, { kind: 'status' }>;
  classSessionId: string | null;
  send: (command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>;
  onSaved: () => void;
}

/** Captures teacher observations with explicit task, comparison and support context. */
export function TeacherAssessmentForm({
  progress,
  status,
  classSessionId,
  send,
  onSaved,
}: TeacherAssessmentFormProps): ReactElement {
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(
    classSessionId ?? progress.sessions.at(-1)?.classSessionId ?? null,
  );
  const [purpose, setPurpose] = useState<string>(AssessmentPurpose.PRACTICE);
  const [assistance, setAssistance] = useState<string>(AssistanceContext.UNKNOWN);
  const [individual, setIndividual] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [correctionId, setCorrectionId] = useState<string | null>(null);
  const [priorId, setPriorId] = useState<string | null>(null);
  const [findings, setFindings] = useState<Record<string, PracticeFinding>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [observationId, setObservationId] = useState(() => crypto.randomUUID());
  const [episodeId, setEpisodeId] = useState(() => crypto.randomUUID());
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString());
  const mappings = selectLatestMappings(status.mappings);
  const mapping = mappings.find((item) => item.id === mappingId);
  const variant = mapping?.variants.find((item) => item.id === variantId);
  const activity = status.activities.find((item) => item.id === activityId);
  const sessions = [
    ...new Set([
      ...(classSessionId ? [classSessionId] : []),
      ...progress.sessions.map((item) => item.classSessionId),
    ]),
  ];
  const correction = progress.assessments.find((item) => item.id === correctionId);
  const prior = progress.assessments.find((item) => item.id === priorId);
  const criteria = (correction?.criteria ?? activity?.criteria ?? []).filter((item) =>
    variant?.criterionIds.includes(item.id),
  );
  return (
    <details>
      <summary>Record a teacher check</summary>
      <Stack mt="md" gap="sm">
        <Text size="sm">
          Record what {progress.name} showed on a task. An unaided result requires your individual
          observation.
        </Text>
        <TextInput
          type="datetime-local"
          label="Observed at (UTC)"
          disabled={Boolean(correction)}
          value={observedAt.slice(0, 16)}
          onChange={(event) => {
            const date = new Date(`${event.currentTarget.value}:00.000Z`);
            if (!Number.isNaN(date.getTime())) {
              setObservedAt(date.toISOString());
            }
          }}
        />
        <Select
          label="Lesson"
          disabled={Boolean(correction)}
          value={sessionId}
          data={sessions.map((id) => ({
            value: id,
            label:
              id === classSessionId
                ? 'Current lesson'
                : new Date(
                    progress.sessions.find((item) => item.classSessionId === id)?.observedAt ?? '',
                  ).toLocaleDateString(),
          }))}
          onChange={setSessionId}
        />
        <Select
          label="Activity"
          disabled={Boolean(correction)}
          value={activityId}
          data={status.activities.map((item) => ({ value: item.id, label: item.title }))}
          onChange={(value) => {
            setActivityId(value);
            setFindings({});
          }}
        />
        <Select
          label="Approved skill"
          value={mappingId}
          data={mappings
            .filter((item) =>
              item.criterionIds.some((id) =>
                (correction?.criteria ?? activity?.criteria)?.some(
                  (criterion) => criterion.id === id,
                ),
              ),
            )
            .map((item) => ({ value: item.id, label: item.title }))}
          onChange={(value) => {
            setMappingId(value);
            setVariantId(null);
            setFindings({});
          }}
        />
        <Select
          label="Approved task variant"
          value={variantId}
          data={(mapping?.variants ?? []).map((item) => ({ value: item.id, label: item.title }))}
          onChange={(value) => {
            setVariantId(value);
            setFindings({});
          }}
        />
        {variant && <Text size="sm">{variant.task}</Text>}
        <Select
          label="Check purpose"
          value={purpose}
          data={Object.values(AssessmentPurpose).map((value) => ({
            value,
            label:
              value === 'fresh'
                ? 'Fresh task'
                : value === 'delayed'
                  ? 'Delayed check'
                  : value === 'transfer'
                    ? 'Different task family'
                    : value === 'baseline'
                      ? 'Starting check'
                      : 'Practice',
          }))}
          onChange={(value) => {
            setPurpose(value ?? AssessmentPurpose.PRACTICE);
          }}
        />
        <Select
          label="Support during the task"
          value={assistance}
          data={Object.values(AssistanceContext).map((value) => ({
            value,
            label:
              value === 'unknown'
                ? 'Support unknown'
                : value === 'unaided'
                  ? 'Unaided'
                  : value === 'hint'
                    ? 'Hint'
                    : value === 'group'
                      ? 'Group work'
                      : 'Demonstration',
          }))}
          onChange={(value) => {
            setAssistance(value ?? AssistanceContext.UNKNOWN);
            setConfirmed(false);
          }}
        />
        <Checkbox
          label="I observed this student individually"
          checked={individual}
          onChange={(event) => {
            setIndividual(event.currentTarget.checked);
            setConfirmed(false);
          }}
        />
        <Checkbox
          label="I confirm this task was completed without help"
          checked={confirmed}
          disabled={!individual || assistance !== AssistanceContext.UNAIDED}
          onChange={(event) => {
            setConfirmed(event.currentTarget.checked);
          }}
        />
        <Select
          clearable
          label="Earlier task for a delayed check"
          value={priorId}
          data={progress.assessments.map((item) => ({
            value: item.id,
            label: `${item.title} · ${new Date(item.observedAt).toLocaleDateString()}`,
          }))}
          onChange={setPriorId}
        />
        <Select
          clearable
          label="Correct an earlier observation"
          value={correctionId}
          data={progress.assessments.map((item) => ({
            value: item.id,
            label: `${item.title} · ${item.method === 'teacher' ? 'Teacher' : 'Practice check'}`,
          }))}
          onChange={(value) => {
            setCorrectionId(value);
            const target = progress.assessments.find((item) => item.id === value);
            if (!target) {
              setObservedAt(new Date().toISOString());
              return;
            }
            setObservedAt(target.observedAt);
            setSessionId(target.classSessionId);
            setActivityId(target.activityId);
            setPurpose(target.purpose);
            setAssistance(target.assistance);
            setIndividual(target.individual === true);
            setConfirmed(target.unaidedConfirmed);
            setPriorId(
              progress.assessments.find(
                (assessment) => assessment.episodeId === target.priorEpisodeId,
              )?.id ?? null,
            );
            const nextFindings: Record<string, PracticeFinding> = {};
            for (const result of target.results) {
              nextFindings[result.criterionId] = result.finding;
            }
            setFindings(nextFindings);
            const targetCriteria = target.criteria.map((criterion) => criterion.id);
            const selectedMapping =
              mappings.find((item) => item.id === target.mappingId) ??
              mappings.find((item) =>
                item.variants.some(
                  (itemVariant) =>
                    itemVariant.criterionIds.length === targetCriteria.length &&
                    targetCriteria.every((id) => itemVariant.criterionIds.includes(id)),
                ),
              );
            const selectedVariant =
              selectedMapping?.variants.find((item) => item.id === target.taskVariantId) ??
              selectedMapping?.variants.find(
                (item) =>
                  item.criterionIds.length === targetCriteria.length &&
                  targetCriteria.every((id) => item.criterionIds.includes(id)),
              );
            setMappingId(selectedMapping?.id ?? null);
            setVariantId(selectedVariant?.id ?? null);
          }}
        />
        {criteria.map((criterion) => (
          <Select
            key={criterion.id}
            label={criterion.description}
            value={findings[criterion.id] ?? null}
            data={[
              { value: PracticeFinding.MET, label: 'Met' },
              { value: PracticeFinding.NEEDS_CHANGES, label: 'Needs practice' },
              { value: PracticeFinding.INSUFFICIENT_EVIDENCE, label: 'More evidence needed' },
            ]}
            onChange={(value) => {
              if (
                value === PracticeFinding.MET ||
                value === PracticeFinding.NEEDS_CHANGES ||
                value === PracticeFinding.INSUFFICIENT_EVIDENCE
              ) {
                setFindings((current) => ({ ...current, [criterion.id]: value }));
              }
            }}
          />
        ))}
        <Textarea
          label="What you observed"
          value={note}
          maxLength={1000}
          onChange={(event) => {
            setNote(event.currentTarget.value);
          }}
        />
        <Button
          loading={busy}
          disabled={
            busy ||
            !sessionId ||
            !mapping ||
            !variant ||
            !activity ||
            !note.trim() ||
            criteria.length === 0 ||
            criteria.some((item) => !findings[item.id]) ||
            (purpose === AssessmentPurpose.DELAYED && !prior && !correction?.priorEpisodeId)
          }
          onClick={() => {
            if (!sessionId || !mapping || !variant || !activity) {
              return;
            }
            const results = criteria.flatMap((criterion) => {
              const finding = findings[criterion.id];
              return finding
                ? [{ criterionId: criterion.id, finding, feedback: note.trim(), evidenceIds: [] }]
                : [];
            });
            const id = observationId;
            setBusy(true);
            setMessage(null);
            const command = {
              kind: 'record-assessment',
              classId: progress.identity.classId,
              requestId: id,
              id,
              expectedVersion: 0,
              studentId: progress.studentId,
              classSessionId: sessionId,
              activityId: activity.id,
              episodeId: correction?.episodeId ?? episodeId,
              mappingId: mapping.id,
              mappingVersion: mapping.version,
              taskVariantId: variant.id,
              purpose,
              assistance,
              individual,
              unaidedConfirmed: confirmed,
              observedAt,
              checkId: correction?.checkId ?? null,
              priorEpisodeId: prior?.episodeId ?? correction?.priorEpisodeId ?? null,
              supersedesId: correction?.id ?? null,
              results,
            };
            if (
              !Object.values(AssessmentPurpose).some((value) => value === purpose) ||
              !Object.values(AssistanceContext).some((value) => value === assistance)
            ) {
              setBusy(false);
              return;
            }
            const parsed = ClassroomInsightCommandSchema.safeParse(command);
            if (!parsed.success) {
              setBusy(false);
              setMessage('Check the observation fields.');
              return;
            }
            void send(parsed.data).then((reply) => {
              setBusy(false);
              if (reply.kind === 'failed') {
                setMessage(formatInsightFailure(reply));
              } else if (reply.kind === 'saved') {
                setMessage('Teacher observation saved.');
                setObservationId(crypto.randomUUID());
                setEpisodeId(crypto.randomUUID());
                setObservedAt(new Date().toISOString());
                setCorrectionId(null);
                setPriorId(null);
                setFindings({});
                setConfirmed(false);
                setIndividual(false);
                setAssistance(AssistanceContext.UNKNOWN);
                setPurpose(AssessmentPurpose.PRACTICE);
                setNote('');
                onSaved();
              }
            });
          }}
        >
          Save teacher check
        </Button>
        {message && (
          <Text size="sm" role="status">
            {message}
          </Text>
        )}
      </Stack>
    </details>
  );
}
