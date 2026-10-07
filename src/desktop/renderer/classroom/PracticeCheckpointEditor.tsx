import type { ReactElement } from 'react';
import { Button, Checkbox, Group, Stack, Text, TextInput, Textarea } from '@mantine/core';
import type { PracticeCheckpoint } from '#contracts/PracticeCheck.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
/** Editing a requirement revokes local approval; publication freezes a new rubric revision. */
export function PracticeCheckpointEditor({
  checkpoints,
  sourceIds,
  disabled,
  onChange,
  t,
}: {
  checkpoints: PracticeCheckpoint[];
  sourceIds: string[];
  disabled: boolean;
  onChange: (checkpoints: PracticeCheckpoint[]) => void;
  t: ClassroomTranslate;
}): ReactElement {
  function update(id: string, change: Partial<PracticeCheckpoint>): void {
    onChange(
      checkpoints.map((item) => (item.id === id ? { ...item, ...change, approved: false } : item)),
    );
  }

  return (
    <Stack gap="sm" mt="sm">
      <Text fw={600} size="sm">
        {t('Practice checks', 'Kiểm tra bài thực hành')}
      </Text>
      <Text size="xs" c="dimmed">
        {t(
          'Approve only observable requirements from this exercise. Lecture sections need no check.',
          'Chỉ duyệt yêu cầu có thể kiểm chứng cho bài tập này. Phần lý thuyết không cần kiểm tra.',
        )}
      </Text>
      {checkpoints.map((checkpoint) => (
        <Stack key={checkpoint.id} gap="xs" className="practice-rubric">
          <Text size="xs">
            {checkpoint.origin === 'source'
              ? t('From materials · review required', 'Từ tài liệu · cần duyệt')
              : t('Suggestion · review required', 'Gợi ý · cần duyệt')}
          </Text>
          <TextInput
            label={t('Check title', 'Tên bài kiểm tra')}
            value={checkpoint.title}
            maxLength={200}
            disabled={disabled}
            onChange={(event) => {
              update(checkpoint.id, { title: event.currentTarget.value });
            }}
          />
          <Textarea
            label={t('Practice task', 'Nhiệm vụ thực hành')}
            value={checkpoint.task}
            maxLength={2000}
            disabled={disabled}
            onChange={(event) => {
              update(checkpoint.id, { task: event.currentTarget.value });
            }}
          />
          {checkpoint.criteria.map((criterion) => (
            <Stack gap={5} key={criterion.id}>
              <TextInput
                label={t('Requirement', 'Yêu cầu')}
                value={criterion.description}
                maxLength={500}
                disabled={disabled}
                onChange={(event) => {
                  update(checkpoint.id, {
                    criteria: checkpoint.criteria.map((item) =>
                      item.id === criterion.id
                        ? { ...item, description: event.currentTarget.value }
                        : item,
                    ),
                  });
                }}
              />
              <TextInput
                label={t('Evidence needed', 'Bằng chứng cần kiểm tra')}
                value={criterion.evidenceNeeded}
                maxLength={500}
                disabled={disabled}
                onChange={(event) => {
                  update(checkpoint.id, {
                    criteria: checkpoint.criteria.map((item) =>
                      item.id === criterion.id
                        ? { ...item, evidenceNeeded: event.currentTarget.value }
                        : item,
                    ),
                  });
                }}
              />
              <Group>
                <Checkbox
                  label={t('Required', 'Bắt buộc')}
                  checked={criterion.required}
                  disabled={disabled}
                  onChange={(event) => {
                    update(checkpoint.id, {
                      criteria: checkpoint.criteria.map((item) =>
                        item.id === criterion.id
                          ? { ...item, required: event.currentTarget.checked }
                          : item,
                      ),
                    });
                  }}
                />
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={disabled || checkpoint.criteria.length <= 1}
                  onClick={() => {
                    update(checkpoint.id, {
                      criteria: checkpoint.criteria.filter((item) => item.id !== criterion.id),
                    });
                  }}
                >
                  {t('Remove criterion', 'Xóa tiêu chí')}
                </Button>
              </Group>
            </Stack>
          ))}
          <Button
            variant="default"
            size="xs"
            disabled={disabled || checkpoint.criteria.length >= 8}
            onClick={() => {
              update(checkpoint.id, {
                criteria: [
                  ...checkpoint.criteria,
                  {
                    id: crypto.randomUUID(),
                    description: '',
                    evidenceNeeded: '',
                    required: true,
                    sourceIds: sourceIds.slice(0, 8),
                  },
                ],
              });
            }}
          >
            {t('Add criterion', 'Thêm tiêu chí')}
          </Button>
          <Checkbox
            label={t(
              'I reviewed these requirements · enable student checks',
              'Tôi đã kiểm tra các yêu cầu · bật kiểm tra cho học sinh',
            )}
            checked={checkpoint.approved}
            disabled={
              disabled ||
              !checkpoint.title.trim() ||
              !checkpoint.task.trim() ||
              checkpoint.criteria.some(
                (item) => !item.description.trim() || !item.evidenceNeeded.trim(),
              ) ||
              !checkpoint.criteria.some((item) => item.required)
            }
            onChange={(event) => {
              onChange(
                checkpoints.map((item) =>
                  item.id === checkpoint.id
                    ? { ...item, approved: event.currentTarget.checked }
                    : item,
                ),
              );
            }}
          />
          <Button
            size="xs"
            variant="subtle"
            color="red"
            disabled={disabled}
            onClick={() => {
              onChange(checkpoints.filter((item) => item.id !== checkpoint.id));
            }}
          >
            {t('Remove checkpoint', 'Xóa bài kiểm tra')}
          </Button>
        </Stack>
      ))}
      <Button
        size="xs"
        variant="default"
        disabled={disabled || checkpoints.length >= 4}
        onClick={() => {
          onChange([
            ...checkpoints,
            {
              id: crypto.randomUUID(),
              rubricRevisionId: crypto.randomUUID(),
              title: t('Practice', 'Thực hành'),
              task: '',
              approved: false,
              origin: 'suggestion',
              criteria: [
                {
                  id: crypto.randomUUID(),
                  description: '',
                  evidenceNeeded: '',
                  required: true,
                  sourceIds: sourceIds.slice(0, 8),
                },
              ],
            },
          ]);
        }}
      >
        {t('Add practice checkpoint', 'Thêm bài thực hành')}
      </Button>
    </Stack>
  );
}
