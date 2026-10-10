import { Button, Checkbox, Group, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState, type ReactElement } from 'react';
import {
  SourcePassageKind,
  type GuidedLessonCommand,
  type GuidedLessonReply,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';

type TeacherInput = Extract<GuidedLessonReply, { kind: 'teacherInput' }>;
type CreateLesson = Extract<GuidedLessonCommand, { action: 'create' }>;

interface GuidedLessonPreparationProps {
  input: TeacherInput;
  busy: boolean;
  onChooseRevision: (revisionId: string) => void;
  onCreate: (command: CreateLesson) => Promise<void>;
}

/** A teacher chooses the exact approved passages and confirms code before any generation. */
export function GuidedLessonPreparation({
  input,
  busy,
  onChooseRevision,
  onCreate,
}: GuidedLessonPreparationProps): ReactElement {
  const { messages, locale } = useLocale();
  const translate = messages.translateGuidedLesson;
  const [revisionId, setRevisionId] = useState(input.revisions[0]?.id ?? '');
  const [sectionId, setSectionId] = useState('');
  const [passageIds, setPassageIds] = useState<string[]>([]);
  const [objective, setObjective] = useState('');
  const [audience, setAudience] = useState(translate('Beginning Python learner'));
  const [language, setLanguage] = useState<'en' | 'vi'>(locale);
  const [duration, setDuration] = useState('180');
  const [instructions, setInstructions] = useState('');
  const [code, setCode] = useState('');
  const [approvedCode, setApprovedCode] = useState(false);
  const [practiceCode, setPracticeCode] = useState('');
  const [approvedPractice, setApprovedPractice] = useState(false);
  const revision = input.revisions.find((item) => item.id === revisionId);
  const section = revision?.sections.find((item) => item.id === sectionId);

  useEffect(() => {
    if (!input.revisions.some((item) => item.id === revisionId)) {
      setRevisionId(input.revisions[0]?.id ?? '');
      setSectionId('');
      setPassageIds([]);
    }
  }, [input, revisionId]);

  const selectedPassages = input.passages.filter((passage) =>
    passageIds.includes(passage.passageId),
  );
  const needsPractice = Number(duration) > 60;
  const canSubmit = Boolean(
    revisionId &&
    sectionId &&
    objective.trim() &&
    audience.trim() &&
    selectedPassages.length &&
    code.trim() &&
    approvedCode &&
    (!needsPractice || (practiceCode.trim() && approvedPractice)) &&
    !busy,
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) {
          return;
        }
        void onCreate({
          action: 'create',
          commandId: crypto.randomUUID(),
          classId: input.classId,
          courseRevisionId: revisionId,
          conceptId: sectionId,
          objective: objective.trim(),
          audience: audience.trim(),
          language,
          targetDurationSeconds: Number(duration),
          passageIds,
          teacherInstructions: instructions.trim(),
          codeApproval: {
            code,
            sourceRefs: selectedPassages.map((passage) => ({
              passageId: passage.passageId,
              startOffset: 0,
              endOffset: passage.text.length,
            })),
            variantOfCodeBlockId: null,
          },
          practiceCodeApproval: needsPractice
            ? {
                code: practiceCode,
                sourceRefs: selectedPassages.map((passage) => ({
                  passageId: passage.passageId,
                  startOffset: 0,
                  endOffset: passage.text.length,
                })),
                variantOfCodeBlockId: null,
              }
            : null,
        });
      }}
    >
      <Stack gap="md">
        <Select
          label={translate('Approved source')}
          placeholder={translate('Choose approved material')}
          value={revisionId || null}
          data={input.revisions.map((item) => ({ value: item.id, label: item.title }))}
          onChange={(value) => {
            setRevisionId(value ?? '');
            setSectionId('');
            setPassageIds([]);
            setApprovedCode(false);
            setApprovedPractice(false);
            if (value) {
              onChooseRevision(value);
            }
          }}
          disabled={busy}
          required
        />
        <Select
          label={translate('Concept or section')}
          placeholder={translate('Choose a section')}
          value={sectionId || null}
          data={revision?.sections.map((item) => ({ value: item.id, label: item.title })) ?? []}
          onChange={(value) => {
            setSectionId(value ?? '');
            const selected = revision?.sections.find((item) => item.id === value);
            setPassageIds(selected && selected.passageIds.length <= 8 ? selected.passageIds : []);
            setApprovedCode(false);
            setApprovedPractice(false);
          }}
          disabled={busy || !revisionId}
          required
        />
        <TextInput
          label={translate('Learning objective')}
          placeholder={translate('What should students understand after this explanation?')}
          value={objective}
          onChange={(event) => {
            setObjective(event.currentTarget.value);
          }}
          maxLength={500}
          required
          disabled={busy}
        />
        <TextInput
          label={translate('Audience')}
          value={audience}
          onChange={(event) => {
            setAudience(event.currentTarget.value);
          }}
          maxLength={400}
          required
          disabled={busy}
        />
        <Group grow align="start">
          <Select
            label={translate('Language')}
            value={language}
            data={[
              { value: 'en', label: translate('English') },
              { value: 'vi', label: translate('Vietnamese') },
            ]}
            onChange={(value) => {
              if (value === 'en' || value === 'vi') {
                setLanguage(value);
              }
            }}
            disabled={busy}
          />
          <Select
            label={translate('Length')}
            value={duration}
            data={[
              { value: '60', label: translate('1 minute') },
              { value: '180', label: translate('3 minutes') },
              { value: '300', label: translate('5 minutes') },
            ]}
            onChange={(value) => {
              setDuration(value ?? '180');
            }}
            disabled={busy}
          />
        </Group>
        {section && (
          <Stack gap="xs" className="guided-source-selection">
            <Text fw={600} size="sm">
              {translate('Exact passages used')}
            </Text>
            <Text size="xs" c="dimmed">
              {translate(
                'Choose up to eight exact passages, including relevant corrections. Narrow the source selection if more are needed.',
              )}
            </Text>
            {input.passages
              .filter((passage) => section.passageIds.includes(passage.passageId))
              .map((passage) => (
                <Checkbox
                  key={passage.passageId}
                  label={
                    <span>
                      {passage.kind !== SourcePassageKind.SOURCE_TEXT && (
                        <strong>{translate('Correction')}: </strong>
                      )}
                      {passage.text}
                    </span>
                  }
                  checked={passageIds.includes(passage.passageId)}
                  disabled={
                    busy || (passageIds.length >= 8 && !passageIds.includes(passage.passageId))
                  }
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setPassageIds((current) =>
                      checked && current.length < 8
                        ? [...current, passage.passageId]
                        : current.filter((id) => id !== passage.passageId),
                    );
                    setApprovedCode(false);
                    setApprovedPractice(false);
                  }}
                />
              ))}
            {!selectedPassages.length && (
              <Text size="xs" c="dimmed">
                {translate('Select at least one approved passage.')}
              </Text>
            )}
          </Stack>
        )}
        <Textarea
          label={translate('Approved Python example')}
          description={translate('Use the exact integer running-total example from these sources.')}
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value);
            setApprovedCode(false);
          }}
          minRows={6}
          maxLength={4000}
          className="guided-code-input"
          disabled={busy}
          required
        />
        <Checkbox
          label={translate('I checked this code against the selected source.')}
          checked={approvedCode}
          onChange={(event) => {
            setApprovedCode(event.currentTarget.checked);
          }}
          disabled={busy || !code.trim()}
        />
        {needsPractice && (
          <>
            <Textarea
              label={translate('Practice variant with a different input')}
              description={translate(
                'Use the same mechanism with new numbers so students can try it independently.',
              )}
              value={practiceCode}
              onChange={(event) => {
                setPracticeCode(event.currentTarget.value);
                setApprovedPractice(false);
              }}
              minRows={6}
              maxLength={4000}
              className="guided-code-input"
              disabled={busy}
              required
            />
            <Checkbox
              label={translate('I approve this practice variant and its source relationship.')}
              checked={approvedPractice}
              onChange={(event) => {
                setApprovedPractice(event.currentTarget.checked);
              }}
              disabled={busy || !practiceCode.trim()}
            />
          </>
        )}
        <Textarea
          label={translate('Teacher instructions')}
          placeholder={translate('Optional guidance for this explanation')}
          value={instructions}
          onChange={(event) => {
            setInstructions(event.currentTarget.value);
          }}
          maxLength={2000}
          disabled={busy}
        />
        <Text size="xs" c="dimmed">
          {translate(
            'Generation uses an allowance only after you confirm. Students cannot start generation.',
          )}
        </Text>
        <Text size="sm">
          {translate(
            'Estimated clean run: 20–40k text tokens. Image inputs are counted separately.',
          )}
        </Text>
        <Text size="xs" c="dimmed">
          {translate(
            'Run limits: 90k input and 30k output tokens. Reviewing later edits uses a separate run allowance. These are limits, not actual usage.',
          )}
        </Text>
        <Button type="submit" loading={busy} disabled={!canSubmit}>
          {translate('Create and generate')}
        </Button>
      </Stack>
    </form>
  );
}
