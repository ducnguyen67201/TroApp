import { useRef, useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { LessonCommand, LessonVideoStatus } from '#contracts/LessonVideos.js';
import { useLessonVideo } from './UseLessonVideo.js';
import { describeLesson, describeLessonFailure } from './LessonVideoLabels.js';
import { LessonVideoStudio } from './LessonVideoStudio.js';
import './LessonVideos.css';

export function LessonVideosPage({ locale }: { locale: 'en' | 'vi' }): ReactElement {
  const view = useLessonVideo();
  const vi = locale === 'vi';
  const [classId, setClassId] = useState<string | null>(null);
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const selectedClass = view.options?.classes.find((item) => item.id === classId);
  return (
    <section className="lesson-workspace">
      <Group justify="space-between">
        <Title order={3}>{vi ? 'Video bài giảng' : 'Lesson videos'}</Title>
        <Button
          variant="subtle"
          disabled={view.busy}
          onClick={() => {
            void view.execute(
              view.selected
                ? { kind: LessonCommand.READ, id: view.selected.id }
                : { kind: LessonCommand.LIST },
            );
          }}
        >
          {vi ? 'Cập nhật' : 'Refresh'}
        </Button>
      </Group>
      {view.error && <Alert color="orange">{describeLessonFailure(view.error, vi)}</Alert>}
      {view.selected ? (
        <LessonVideoStudio
          lesson={view.selected}
          vi={vi}
          busy={view.busy}
          execute={view.execute}
          back={() => {
            view.select(null);
          }}
        />
      ) : (
        <>
          <form
            className="lesson-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (classId) {
                void view.execute({
                  kind: LessonCommand.CREATE,
                  requestId: requestId.current,
                  classId,
                  materialIds,
                  prompt,
                  locale,
                });
              }
            }}
          >
            <Title order={4}>
              {vi ? 'Bạn muốn giải thích điều gì?' : 'What would you like to explain?'}
            </Title>
            <Select
              label={vi ? 'Lớp học' : 'Class'}
              value={classId}
              data={
                view.options?.classes.map((item) => ({ value: item.id, label: item.name })) ?? []
              }
              onChange={(value) => {
                setClassId(value);
                setMaterialIds([]);
                requestId.current = crypto.randomUUID();
              }}
            />
            <Textarea
              required
              label={vi ? 'Yêu cầu của bạn' : 'Your instructions'}
              placeholder={
                vi
                  ? 'Giải thích Boolean cho học sinh mới học, kèm ví dụ đúng và sai.'
                  : 'Explain Boolean values to beginners using true and false examples.'
              }
              maxLength={2000}
              minRows={2}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                requestId.current = crypto.randomUUID();
              }}
            />
            <Stack gap="xs">
              <Text size="sm">
                {vi ? 'Tài liệu đã chuẩn bị của lớp' : 'Prepared class materials'}
              </Text>
              {selectedClass?.materials.map((material) => (
                <Checkbox
                  key={material.id}
                  label={material.name}
                  checked={materialIds.includes(material.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setMaterialIds((current) =>
                      checked
                        ? [...current, material.id]
                        : current.filter((id) => id !== material.id),
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
                loading={view.busy}
                disabled={
                  !view.options?.available || !classId || !materialIds.length || !prompt.trim()
                }
              >
                {vi ? 'Tạo video' : 'Create video'}
              </Button>
            </Group>
            {view.options && (
              <details>
                <summary>{vi ? 'Chi phí và giới hạn' : 'Cost and limits'}</summary>
                <Text size="sm">
                  {vi ? 'Ước tính nội dung' : 'Content estimate'}: $
                  {(view.options.estimatedMicroUsd / 1e6).toFixed(4)} ·{' '}
                  {vi ? 'Dự phòng tối đa' : 'Maximum reservation'}: $
                  {(view.options.maximumMicroUsd / 1e6).toFixed(3)} USD.{' '}
                  {vi ? 'Giọng đọc và máy chủ tính riêng.' : 'Narration and hosting are separate.'}
                </Text>
              </details>
            )}
            {view.options && !view.options.available && (
              <Alert color="orange">
                {vi
                  ? 'Dịch vụ tạo video chưa sẵn sàng. Kiểm tra API và Docker renderer.'
                  : 'Video creation is unavailable. Check the API and Docker renderer.'}
              </Alert>
            )}
          </form>
          <div className="lesson-library">
            {view.lessons.map((lesson) => (
              <article key={lesson.id}>
                <Text size="xs" c="dimmed">
                  {describeLesson(lesson, vi)}
                </Text>
                <h3>{lesson.title}</h3>
                <Group justify="space-between">
                  <Button
                    variant="subtle"
                    onClick={() => {
                      view.select(lesson);
                      void view.execute({ kind: LessonCommand.READ, id: lesson.id });
                    }}
                  >
                    {vi ? 'Mở bài giảng' : 'Open lesson'}
                  </Button>
                  {(lesson.status === LessonVideoStatus.RUNNING ||
                    lesson.status === LessonVideoStatus.QUEUED) && <Loader size="sm" />}
                </Group>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
