import { useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Checkbox, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import {
  LessonCommand,
  type LessonVideoCommand,
  type LessonVideoReply,
  type LessonVideoFailure,
} from '#contracts/LessonVideos.js';
import { describeLessonFailure } from './LessonVideoLabels.js';

/** Keeps creation input and its idempotency key while the dialog is hidden. */
export function LessonVideoCreateForm({
  options,
  busy,
  error,
  locale,
  execute,
  onCreated,
}: {
  options: Extract<LessonVideoReply, { kind: 'options' }> | null;
  busy: boolean;
  error: (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure] | null;
  locale: 'en' | 'vi';
  execute: (
    command: LessonVideoCommand,
    onAcknowledged?: (reply: LessonVideoReply) => void,
  ) => Promise<void>;
  onCreated: () => void;
}): ReactElement {
  const vi = locale === 'vi';
  const [classId, setClassId] = useState<string | null>(null);
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const selectedClass = options?.classes.find((item) => item.id === classId);
  return (
    <form
      className="lesson-create"
      onSubmit={(event) => {
        event.preventDefault();
        if (classId && !busy && options?.available && materialIds.length && prompt.trim()) {
          const submittedRequestId = requestId.current;
          void execute(
            {
              kind: LessonCommand.CREATE,
              requestId: submittedRequestId,
              classId,
              materialIds,
              prompt,
              locale,
            },
            (reply) => {
              if (requestId.current === submittedRequestId) {
                requestId.current = crypto.randomUUID();
              }
              if (reply.kind === 'lesson') {
                onCreated();
              }
            },
          );
        }
      }}
    >
      <Text c="dimmed" size="sm">
        {vi
          ? 'Từ ý tưởng của bạn đến bài giảng của cả lớp.'
          : 'Turn your idea into a lesson for the whole class.'}
      </Text>
      {error && <Alert color="orange">{describeLessonFailure(error, vi)}</Alert>}
      {options?.classes.length === 0 && (
        <Text size="sm" c="dimmed">
          {vi
            ? 'Hãy tạo hoặc tham gia một lớp với quyền giáo viên trước.'
            : 'Create or join a class as a teacher first.'}
        </Text>
      )}
      <Select
        label={vi ? 'Lớp học' : 'Class'}
        value={classId}
        disabled={busy}
        data={options?.classes.map((item) => ({ value: item.id, label: item.name })) ?? []}
        onChange={(value) => {
          setClassId(value);
          setMaterialIds([]);
          requestId.current = crypto.randomUUID();
        }}
      />
      <Textarea
        required
        disabled={busy}
        label={vi ? 'Yêu cầu của bạn' : 'Your instructions'}
        placeholder={
          vi
            ? 'Giải thích Boolean cho học sinh mới học, kèm ví dụ đúng và sai.'
            : 'Explain Boolean values to beginners using true and false examples.'
        }
        maxLength={2000}
        minRows={4}
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          requestId.current = crypto.randomUUID();
        }}
      />
      <Stack gap="xs">
        <Text size="sm">{vi ? 'Tài liệu đã chuẩn bị của lớp' : 'Prepared class materials'}</Text>
        {selectedClass?.materials.map((material) => (
          <Checkbox
            key={material.id}
            disabled={busy}
            label={material.name}
            checked={materialIds.includes(material.id)}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setMaterialIds((current) =>
                checked ? [...current, material.id] : current.filter((id) => id !== material.id),
              );
              requestId.current = crypto.randomUUID();
            }}
          />
        ))}
        {selectedClass && !selectedClass.materials.length && (
          <Text c="dimmed">
            {vi
              ? 'Hãy chuẩn bị tài liệu trong mục Lớp học trước.'
              : 'Prepare class materials in Classroom first.'}
          </Text>
        )}
      </Stack>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {vi
            ? '3–6 cảnh · khoảng 1–2 phút · giọng đọc AI'
            : '3–6 screens · about 1–2 minutes · AI narration'}
        </Text>
        <Button
          type="submit"
          loading={busy}
          disabled={!options?.available || !classId || !materialIds.length || !prompt.trim()}
        >
          {vi ? 'Tạo video' : 'Create video'}
        </Button>
      </Group>
      {options && (
        <details>
          <summary>{vi ? 'Chi phí và giới hạn' : 'Cost and limits'}</summary>
          <Text size="sm">
            {vi
              ? 'Giới hạn lượt đầu (nội dung và hoạt ảnh)'
              : 'First-pass limit (content and animation)'}
            : ${(options.estimatedMicroUsd / 1e6).toFixed(4)} ·{' '}
            {vi ? 'Dự phòng tối đa' : 'Maximum reservation'}: $
            {(options.maximumMicroUsd / 1e6).toFixed(3)} USD.{' '}
            {vi ? 'Giọng đọc và máy chủ tính riêng.' : 'Narration and hosting are separate.'}
          </Text>
        </details>
      )}
      {options && !options.available && (
        <Alert color="orange">
          {vi
            ? 'Dịch vụ tạo video chưa sẵn sàng. Vui lòng thử lại sau.'
            : 'Video creation is unavailable. Please try again later.'}
        </Alert>
      )}
    </form>
  );
}
