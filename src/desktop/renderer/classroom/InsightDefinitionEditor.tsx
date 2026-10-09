import { useState, type ReactElement } from 'react';
import {
  Button,
  Checkbox,
  MultiSelect,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import type {
  ClassroomInsightCommand,
  ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import { formatInsightFailure } from './InsightLabels.js';
import { selectLatestMappings, selectLatestPlans } from './InsightDefinitions.js';

type InsightStatus = Extract<ClassroomInsightReply, { kind: 'status' }>;
interface InsightDefinitionEditorProps {
  classId: string;
  classSessionId: string | null;
  status: InsightStatus;
  send: (command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>;
  onSaved: () => void;
}

/** Teachers explicitly approve assignments and comparable tasks; no performance-derived prerequisites. */
export function InsightDefinitionEditor({
  classId,
  classSessionId,
  status,
  send,
  onSaved,
}: InsightDefinitionEditorProps): ReactElement {
  const [title, setTitle] = useState('Lesson learning plan');
  const [activityIds, setActivityIds] = useState<string[]>([]);
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [skillTitle, setSkillTitle] = useState('');
  const [task, setTask] = useState('');
  const [criterionIds, setCriterionIds] = useState<string[]>([]);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [standardVariantId, setStandardVariantId] = useState<string | null>(null);
  const [variantTitle, setVariantTitle] = useState('');
  const [comparisonConfirmed, setComparisonConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [planId] = useState(() => crypto.randomUUID());
  const [mappingId] = useState(() => crypto.randomUUID());
  const [skillId] = useState(() => crypto.randomUUID());
  const [standardRevisionId] = useState(() => crypto.randomUUID());
  const [variantId, setVariantId] = useState(() => crypto.randomUUID());
  const [comparisonGroupId] = useState(() => crypto.randomUUID());
  const [scoringRevisionId] = useState(() => crypto.randomUUID());
  const activity = status.activities.find((item) => item.id === activityId);
  const mappings = selectLatestMappings(status.mappings);
  const existing = mappings.find((mapping) => mapping.id === existingId);
  const referenceVariant = existing?.variants.find((variant) => variant.id === standardVariantId);

  async function save(command: ClassroomInsightCommand): Promise<void> {
    setBusy(true);
    setMessage(null);
    const reply = await send(command);
    setBusy(false);
    if (reply.kind === 'failed') {
      setMessage(formatInsightFailure(reply));
    } else if (reply.kind === 'saved') {
      setMessage('Teacher-approved definition saved.');
      if (reply.record.kind === 'mapping') {
        setExistingId(reply.record.value.id);
        setSkillTitle(reply.record.value.title);
        setVariantId(crypto.randomUUID());
        setVariantTitle('');
        setTask('');
        setCriterionIds([]);
        setStandardVariantId(null);
        setComparisonConfirmed(false);
      }
      onSaved();
    }
  }

  return (
    <details>
      <summary>Teacher learning definitions</summary>
      <Stack mt="md" gap="md">
        <Text size="sm">
          Approve the lesson’s assigned tasks and who they apply to. This defines the denominator
          used for hand-ins.
        </Text>
        <TextInput
          label="Plan title"
          value={title}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
          }}
        />
        <MultiSelect
          label="Assigned tasks"
          value={activityIds}
          data={status.activities.map((item) => ({ value: item.id, label: item.title }))}
          onChange={setActivityIds}
        />
        <MultiSelect
          label="Assigned students"
          value={studentIds}
          data={status.students.map((item) => ({ value: item.id, label: item.name }))}
          onChange={setStudentIds}
        />
        <Button
          disabled={busy || !title.trim() || activityIds.length === 0 || studentIds.length === 0}
          onClick={() => {
            const first = status.activities.find((item) => item.id === activityIds[0]);
            if (
              !first ||
              activityIds.some(
                (id) =>
                  status.activities.find((item) => item.id === id)?.courseRevisionId !==
                  first.courseRevisionId,
              )
            ) {
              setMessage('Choose tasks from one approved course revision.');
              return;
            }
            const previous = selectLatestPlans(status.plans)
              .filter(
                (plan) =>
                  plan.classSessionId === classSessionId &&
                  plan.courseRevisionId === first.courseRevisionId,
              )
              .at(-1);
            const id = previous?.id ?? planId;
            void save({
              kind: 'approve-plan',
              classId,
              classSessionId,
              requestId: crypto.randomUUID(),
              id,
              expectedVersion: previous?.version ?? 0,
              courseRevisionId: first.courseRevisionId,
              title: title.trim(),
              activityIds,
              studentIds,
            });
          }}
        >
          Approve lesson plan
        </Button>
        <Text size="sm">
          Define a skill and an approved task variant before recording fresh, delayed or transfer
          checks. Future variants must be reviewed against the same scoring standard.
        </Text>
        <Select
          clearable
          label="Add a task to an existing skill"
          value={existingId}
          data={mappings.map((mapping) => ({ value: mapping.id, label: mapping.title }))}
          onChange={(value) => {
            setExistingId(value);
            setStandardVariantId(null);
            setComparisonConfirmed(false);
            const selected = mappings.find((mapping) => mapping.id === value);
            setSkillTitle(selected?.title ?? '');
          }}
        />
        <Select
          label="Task for this skill"
          value={activityId}
          data={status.activities.map((item) => ({ value: item.id, label: item.title }))}
          onChange={(value) => {
            setActivityId(value);
            setCriterionIds([]);
          }}
        />
        <TextInput
          label="Skill name"
          value={skillTitle}
          disabled={Boolean(existing)}
          maxLength={200}
          onChange={(event) => {
            setSkillTitle(event.currentTarget.value);
          }}
        />
        <TextInput
          label="New task variant name"
          value={variantTitle}
          maxLength={200}
          onChange={(event) => {
            setVariantTitle(event.currentTarget.value);
          }}
        />
        <Textarea
          label="Approved task instructions"
          value={task}
          maxLength={2000}
          onChange={(event) => {
            setTask(event.currentTarget.value);
          }}
        />
        <MultiSelect
          label="Comparable criteria"
          value={criterionIds}
          data={(activity?.criteria ?? []).map((item) => ({
            value: item.id,
            label: item.description,
          }))}
          onChange={setCriterionIds}
        />
        {existing && (
          <>
            <Select
              label="Task with the same scoring standard"
              value={standardVariantId}
              data={existing.variants.map((variant) => ({
                value: variant.id,
                label: variant.title,
              }))}
              onChange={(value) => {
                setStandardVariantId(value);
                setComparisonConfirmed(false);
              }}
            />
            <Checkbox
              label="I reviewed these tasks and confirm the same comparison and scoring standard applies"
              checked={comparisonConfirmed}
              onChange={(event) => {
                setComparisonConfirmed(event.currentTarget.checked);
              }}
            />
          </>
        )}
        <Button
          disabled={
            busy ||
            !activity ||
            !skillTitle.trim() ||
            !variantTitle.trim() ||
            !task.trim() ||
            criterionIds.length === 0 ||
            Boolean(existing && (!referenceVariant || !comparisonConfirmed))
          }
          onClick={() => {
            const previous = existing ?? mappings.find((mapping) => mapping.id === mappingId);
            const nextVariant = {
              id: variantId,
              title: variantTitle.trim(),
              task: task.trim(),
              criterionIds,
              comparisonGroupId: referenceVariant?.comparisonGroupId ?? comparisonGroupId,
              scoringRevisionId: referenceVariant?.scoringRevisionId ?? scoringRevisionId,
            };
            const variants = previous?.variants.some((variant) => variant.id === variantId)
              ? previous.variants
              : [...(previous?.variants ?? []), nextVariant];
            void save({
              kind: 'approve-mapping',
              classId,
              requestId: crypto.randomUUID(),
              id: previous?.id ?? mappingId,
              expectedVersion: previous?.version ?? 0,
              skillId: previous?.skillId ?? skillId,
              standardRevisionId: previous?.standardRevisionId ?? standardRevisionId,
              title: previous?.title ?? skillTitle.trim(),
              criterionIds: [...new Set([...(previous?.criterionIds ?? []), ...criterionIds])],
              variants,
            });
          }}
        >
          {existing ? 'Approve comparable task variant' : 'Approve skill and task'}
        </Button>
        {message && (
          <Text role="status" size="sm">
            {message}
          </Text>
        )}
      </Stack>
    </details>
  );
}
