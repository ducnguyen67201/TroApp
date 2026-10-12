import { useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Group,
  MultiSelect,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  PetPointAmountSchema,
  PetRecognitionCategory,
  PetWorldCommandKind,
  PetWorldLimits,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import {
  describeRecognitionCategory,
  formatPoints,
  type PetWorldTranslate,
} from './PetWorldLabels.js';

type RecognitionView = Extract<PetWorldReply, { kind: 'class-recognition' }>;

interface TeacherRecognitionFormProps {
  recognition: RecognitionView;
  isSaving: boolean;
  locale: DesktopLocale;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
}

/** One class award form owns input only; authorization and issuance remain on the backend. */
export function TeacherRecognitionForm({
  recognition,
  isSaving,
  locale,
  t,
  sendCommand,
}: TeacherRecognitionFormProps): ReactElement {
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [points, setPoints] = useState('5');
  const [category, setCategory] = useState<PetRecognitionCategory>(
    PetRecognitionCategory.CURIOSITY,
  );
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const validPoints = PetPointAmountSchema.safeParse(points);
  const currentRecipients = studentIds.filter((studentId) =>
    recognition.roster.some((student) => student.studentId === studentId),
  );
  const total = validPoints.success
    ? BigInt(validPoints.data) * BigInt(currentRecipients.length)
    : 0n;

  const awardPoints = async (): Promise<void> => {
    if (!validPoints.success || !currentRecipients.length) {
      return;
    }
    setNotice(null);
    const saved = await sendCommand({
      kind: PetWorldCommandKind.GRANT_POINTS,
      requestId: crypto.randomUUID(),
      classId: recognition.classId,
      studentIds: currentRecipients,
      pointsPerStudent: validPoints.data,
      category,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (saved) {
      setNotice(
        t(
          `Recognized ${currentRecipients.length.toString()} students.`,
          `Đã ghi nhận ${currentRecipients.length.toString()} học sinh.`,
        ),
      );
      setNote('');
    }
  };

  return (
    <section className="pet-world-panel" aria-label={t('Give points', 'Tặng điểm')}>
      <h2>{t('Notice a good moment.', 'Ghi nhận một khoảnh khắc đẹp.')}</h2>
      <Text size="sm" c="dimmed" mb="lg">
        {t(
          'Your words make the recognition meaningful. Choose any positive whole-number amount.',
          'Lời nhận xét giúp sự ghi nhận có ý nghĩa. Bạn có thể chọn số điểm nguyên dương.',
        )}
      </Text>
      {notice && (
        <Alert color="green" mb="md" role="status">
          {notice}
        </Alert>
      )}
      <Stack gap="md">
        <Group justify="space-between" align="end">
          <Text size="sm" fw={600}>
            {t('Who would you like to recognize?', 'Bạn muốn ghi nhận ai?')}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={isSaving || recognition.roster.length > PetWorldLimits.RECIPIENTS}
            onClick={() => {
              setStudentIds(recognition.roster.map((student) => student.studentId));
            }}
          >
            {t('Select the whole class', 'Chọn cả lớp')}
          </Button>
        </Group>
        <MultiSelect
          aria-label={t('Students to recognize', 'Học sinh được ghi nhận')}
          placeholder={t('Choose one or more students', 'Chọn một hoặc nhiều học sinh')}
          searchable
          clearable
          data={recognition.roster.map((student) => ({
            value: student.studentId,
            label: student.displayName,
          }))}
          value={currentRecipients}
          onChange={setStudentIds}
          maxValues={PetWorldLimits.RECIPIENTS}
          disabled={isSaving}
          nothingFoundMessage={t('No matching students', 'Không tìm thấy học sinh')}
        />
        <div className="pet-world-form">
          <Select
            label={t('What did you notice?', 'Bạn nhận thấy điều gì?')}
            value={category}
            data={Object.values(PetRecognitionCategory).map((value) => ({
              value,
              label: describeRecognitionCategory(value, t),
            }))}
            disabled={isSaving}
            onChange={(value) => {
              const selected = Object.values(PetRecognitionCategory).find(
                (candidate) => candidate === value,
              );
              if (selected) {
                setCategory(selected);
              }
            }}
          />
          <TextInput
            label={t('Points per student', 'Điểm mỗi học sinh')}
            value={points}
            inputMode="numeric"
            maxLength={19}
            onChange={(event) => {
              setPoints(event.currentTarget.value);
            }}
            disabled={isSaving}
            error={
              points && !validPoints.success
                ? t('Enter a positive whole number.', 'Nhập số nguyên dương.')
                : undefined
            }
          />
        </div>
        <Textarea
          label={t('A small, specific note', 'Một lời nhận xét cụ thể')}
          placeholder={t(
            'You tried a different approach and explained what changed.',
            'Em đã thử cách khác và giải thích điều gì thay đổi.',
          )}
          maxLength={PetWorldLimits.NOTE_LENGTH}
          value={note}
          onChange={(event) => {
            setNote(event.currentTarget.value);
          }}
          disabled={isSaving}
          minRows={2}
        />
        <Group justify="space-between" align="center">
          <Text size="sm" c="dimmed">
            {t(
              `${currentRecipients.length.toString()} students · ${formatPoints(total.toString(), locale)} points in total`,
              `${currentRecipients.length.toString()} học sinh · tổng ${formatPoints(total.toString(), locale)} điểm`,
            )}
          </Text>
          <Button
            disabled={isSaving || !validPoints.success || !currentRecipients.length}
            onClick={() => {
              void awardPoints();
            }}
          >
            {t('Recognize and give points', 'Ghi nhận và tặng điểm')}
          </Button>
        </Group>
      </Stack>
    </section>
  );
}
