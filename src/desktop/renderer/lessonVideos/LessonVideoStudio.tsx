import { useState, type ReactElement } from 'react';
import { Player } from '@remotion/player';
import {
  Alert,
  Button,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import {
  LessonCommand,
  LessonLayout,
  LessonVideoStatus,
  LessonContentSchema,
  LessonLimits,
  type LessonContent,
  type LessonVideo,
  type LessonVideoCommand,
} from '#contracts/LessonVideos.js';
import { LessonComposition } from '../../../lessonVideoPresentation/LessonComposition.js';
import { LessonVideoPlayer } from './LessonVideoPlayer.js';
import {
  describeLesson,
  describeLessonFailure,
  describeScreenAnimation,
  describeScreenAnimationNote,
} from './LessonVideoLabels.js';

export function LessonVideoStudio({
  lesson,
  vi,
  busy,
  execute,
  back,
}: {
  lesson: LessonVideo;
  vi: boolean;
  busy: boolean;
  execute: (command: LessonVideoCommand) => Promise<void>;
  back: () => void;
}): ReactElement {
  const [index, setIndex] = useState(0);
  const active =
    lesson.status === LessonVideoStatus.RUNNING || lesson.status === LessonVideoStatus.QUEUED;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedIndex = lesson.screens[index] ? index : 0;
  const screen = lesson.screens[selectedIndex];
  const animationNote = screen ? describeScreenAnimationNote(screen, vi) : null;
  const downloadTranscript = (): void => {
    const text = [
      lesson.title,
      ...lesson.screens.map((item) => `${item.title}\n${item.narration}`),
    ].join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Lesson.txt';
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  };
  return (
    <>
      <Group justify="space-between">
        <Button variant="subtle" onClick={back}>
          ← {vi ? 'Thư viện' : 'Library'}
        </Button>
        <strong>{lesson.title}</strong>
      </Group>
      <Group gap="xs" role="status">
        {active && <Loader size="sm" />}
        <Text>{describeLesson(lesson, vi)}</Text>
      </Group>
      {lesson.error && <Alert color="orange">{describeLessonFailure(lesson.error, vi)}</Alert>}
      {lesson.videoId && lesson.videoRevision !== lesson.revision && (
        <Text size="sm" c="dimmed">
          {vi
            ? 'Đang hiển thị video đã lưu của phiên bản trước.'
            : 'Showing the saved video from the previous revision.'}
        </Text>
      )}
      <div className="lesson-studio">
        <div>
          {lesson.videoId ? (
            <LessonVideoPlayer lessonId={lesson.id} artifactId={lesson.videoId} vi={vi} />
          ) : screen ? (
            <div className="lesson-preview">
              <Player
                component={LessonComposition}
                inputProps={{
                  screen: {
                    layout: screen.layout,
                    title: screen.title,
                    points: screen.points,
                    narration: screen.narration,
                  },
                  durationSeconds: 12,
                  audioUrl: null,
                }}
                compositionWidth={LessonLimits.WIDTH}
                compositionHeight={LessonLimits.HEIGHT}
                fps={LessonLimits.FPS}
                durationInFrames={360}
                controls
                style={{ width: '100%' }}
              />
              <Text size="xs" c="dimmed">
                {vi
                  ? 'Xem nội dung với hoạt ảnh tiêu chuẩn · chưa phải video hoàn chỉnh'
                  : 'Content preview with standard animation · not the finished video'}
              </Text>
            </div>
          ) : (
            <div className="lesson-empty">
              {active && <Loader />}
              <Text>
                {active
                  ? vi
                    ? 'Bạn có thể rời trang. Bài giảng vẫn tiếp tục được tạo.'
                    : 'You can leave this page. Generation continues in the background.'
                  : vi
                    ? 'Chưa có kịch bản. Nhập nội dung bên cạnh hoặc tạo lượt mới từ thư viện.'
                    : 'No script yet. Enter content alongside or create a new lesson from the library.'}
              </Text>
            </div>
          )}
          <div className="lesson-screen-list">
            {lesson.screens.map((item, position) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selectedIndex === position}
                onClick={() => {
                  setIndex(position);
                }}
              >
                <strong>
                  {position + 1}. {item.title}
                </strong>
                <span>{describeScreenAnimation(item, vi)}</span>
              </button>
            ))}
          </div>
          {screen && (
            <div className="lesson-animation-note">
              <Text size="sm" fw={600}>
                {vi ? 'Cảnh' : 'Scene'} {selectedIndex + 1}: {describeScreenAnimation(screen, vi)}
              </Text>
              {animationNote && (
                <Text size="sm" c="dimmed">
                  {animationNote}
                </Text>
              )}
            </div>
          )}
          <Group mt="sm">
            <Button
              size="xs"
              variant="light"
              disabled={!lesson.screens.length}
              onClick={downloadTranscript}
            >
              {vi ? 'Tải lời giảng' : 'Download transcript'}
            </Button>
            {lesson.videoId && (
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  if (lesson.videoId) {
                    void window.tro.readLessonMedia?.({
                      id: lesson.id,
                      artifactId: lesson.videoId,
                      download: true,
                    });
                  }
                }}
              >
                {vi ? 'Tải video' : 'Download video'}
              </Button>
            )}
          </Group>
          <details className="lesson-details">
            <summary>{vi ? 'Lời giảng và chi tiết' : 'Transcript and details'}</summary>
            {lesson.screens.map((item) => (
              <p key={item.id}>
                <strong>{item.title}</strong>
                <br />
                {item.narration}
              </p>
            ))}
            <Text size="xs">
              {vi ? 'Token đã báo cáo' : 'Reported tokens'}: {lesson.inputTokens.toLocaleString()} /{' '}
              {lesson.outputTokens.toLocaleString()}.{' '}
              {lesson.usageUncertain &&
                (vi
                  ? 'Chi phí các yêu cầu bị gián đoạn có thể chưa được báo cáo.'
                  : 'Interrupted requests may have unreported usage.')}
            </Text>
          </details>
        </div>
        <aside>
          <LessonEditor
            key={`${lesson.id}:${String(lesson.revision)}:${String(lesson.screens.length)}`}
            lesson={lesson}
            active={active}
            busy={busy}
            vi={vi}
            execute={execute}
          />
          <Stack gap="xs" className="lesson-actions">
            {active ? (
              <Button
                color="red"
                variant="subtle"
                disabled={busy}
                onClick={() => {
                  void execute({
                    kind: LessonCommand.CANCEL,
                    id: lesson.id,
                    revision: lesson.revision,
                  });
                }}
              >
                {vi ? 'Hủy tạo video' : 'Cancel generation'}
              </Button>
            ) : (
              <>
                {lesson.canContinue && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void execute({
                        kind: LessonCommand.CONTINUE,
                        id: lesson.id,
                        revision: lesson.revision,
                      });
                    }}
                  >
                    {vi ? 'Tiếp tục dựng video' : 'Continue rendering'}
                  </Button>
                )}
                {lesson.canContinue && (
                  <Text size="xs" c="dimmed">
                    {vi
                      ? 'Tiếp tục dùng nội dung và hoạt ảnh đã lưu; không cấp thêm lượt gọi AI.'
                      : 'Continue reuses saved content and animation; it does not grant new AI attempts.'}
                  </Text>
                )}
                {lesson.screens.some((item) => item.silent && item.speechAttempts < 3) && (
                  <Button
                    variant="light"
                    disabled={busy}
                    onClick={() => {
                      void execute({
                        kind: LessonCommand.NARRATE,
                        id: lesson.id,
                        revision: lesson.revision,
                      });
                    }}
                  >
                    {vi ? 'Thêm giọng đọc còn thiếu' : 'Add missing narration'}
                  </Button>
                )}
              </>
            )}
            {!confirmDelete ? (
              <Button
                color="red"
                variant="subtle"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                {vi ? 'Xóa bài giảng' : 'Delete lesson'}
              </Button>
            ) : (
              <Alert color="red">
                <Text size="sm">
                  {vi
                    ? 'Xóa vĩnh viễn nội dung và video này?'
                    : 'Permanently delete this lesson and its videos?'}
                </Text>
                <Group>
                  <Button
                    color="red"
                    disabled={busy}
                    onClick={() => {
                      void execute({
                        kind: LessonCommand.DELETE,
                        id: lesson.id,
                        revision: lesson.revision,
                      });
                    }}
                  >
                    {vi ? 'Xóa vĩnh viễn' : 'Delete permanently'}
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => {
                      setConfirmDelete(false);
                    }}
                  >
                    {vi ? 'Giữ lại' : 'Keep'}
                  </Button>
                </Group>
              </Alert>
            )}
          </Stack>
        </aside>
      </div>
    </>
  );
}

function LessonEditor({
  lesson,
  active,
  busy,
  vi,
  execute,
}: {
  lesson: LessonVideo;
  active: boolean;
  busy: boolean;
  vi: boolean;
  execute: (command: LessonVideoCommand) => Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState<LessonContent>(() => ({
    title: lesson.title,
    screens: lesson.screens.length
      ? lesson.screens.map(({ layout, title, points, narration }) => ({
          layout,
          title,
          points,
          narration,
        }))
      : Array.from({ length: 3 }, () => ({
          layout: LessonLayout.EXPLANATION,
          title: '',
          points: [''],
          narration: '',
        })),
  }));
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(0);
  const screen = draft.screens[editing];
  const change = (update: Partial<LessonContent['screens'][number]>): void => {
    setDraft((current) => ({
      ...current,
      screens: current.screens.map((item, index) =>
        index === editing ? { ...item, ...update } : item,
      ),
    }));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = LessonContentSchema.safeParse(draft);
        setError(!parsed.success);
        if (parsed.success) {
          void execute({
            kind: LessonCommand.EDIT,
            id: lesson.id,
            revision: lesson.revision,
            content: parsed.data,
          });
        }
      }}
    >
      <Stack gap="sm">
        <TextInput
          label={vi ? 'Tiêu đề bài giảng' : 'Lesson title'}
          maxLength={120}
          value={draft.title}
          disabled={active}
          onChange={(event) => {
            setDraft({ ...draft, title: event.target.value });
          }}
        />
        <Select
          label={vi ? 'Chỉnh sửa cảnh' : 'Edit screen'}
          value={String(editing)}
          data={draft.screens.map((item, index) => ({
            value: String(index),
            label: `${String(index + 1)}. ${item.title}`,
          }))}
          onChange={(value) => {
            setEditing(Number(value));
          }}
        />
        {screen && (
          <>
            <TextInput
              label={vi ? 'Tiêu đề cảnh' : 'Screen title'}
              maxLength={80}
              value={screen.title}
              disabled={active}
              onChange={(event) => {
                change({ title: event.target.value });
              }}
            />
            <Select
              label={vi ? 'Bố cục' : 'Layout'}
              disabled={active}
              data={[
                { value: LessonLayout.EXPLANATION, label: vi ? 'Giải thích' : 'Explanation' },
                { value: LessonLayout.EXAMPLE, label: vi ? 'Ví dụ' : 'Example' },
                { value: LessonLayout.COMPARISON, label: vi ? 'So sánh' : 'Comparison' },
              ]}
              value={screen.layout}
              onChange={(value) => {
                if (
                  value === LessonLayout.EXPLANATION ||
                  value === LessonLayout.EXAMPLE ||
                  value === LessonLayout.COMPARISON
                ) {
                  change({ layout: value });
                }
              }}
            />
            <Textarea
              label={
                vi
                  ? 'Ý chính (1–3 dòng, tối đa 160 ký tự mỗi dòng)'
                  : 'Key points (1–3 lines, up to 160 characters each)'
              }
              value={screen.points.join('\n')}
              disabled={active}
              minRows={3}
              onChange={(event) => {
                change({ points: event.target.value.split('\n') });
              }}
            />
            <Textarea
              label={vi ? 'Lời giảng' : 'Narration'}
              value={screen.narration}
              maxLength={1000}
              minRows={4}
              disabled={active}
              onChange={(event) => {
                change({ narration: event.target.value });
              }}
            />
          </>
        )}
        {error && (
          <Text c="red" size="sm">
            {vi
              ? 'Kiểm tra nội dung và độ dài các trường.'
              : 'Check required fields and length limits.'}
          </Text>
        )}
        <Button type="submit" disabled={active || busy}>
          {vi ? 'Lưu và dựng video' : 'Save and render'}
        </Button>
        <Text size="xs" c="dimmed">
          {vi
            ? 'Chỉnh sửa không gọi lại AI viết nội dung. Lời giảng mới có thể hiển thị bằng chữ.'
            : 'Editing never reruns content generation. New narration may appear as text.'}
        </Text>
      </Stack>
    </form>
  );
}
