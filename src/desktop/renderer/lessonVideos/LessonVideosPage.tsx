import { useState, type ReactElement } from 'react';
import { Alert, Badge, Button, Group, Loader, Modal, Select, Text, Title } from '@mantine/core';
import { IconPlus, IconRefresh } from '@tabler/icons-react';
import { LessonCommand, type LessonVideo } from '#contracts/LessonVideos.js';
import { useLessonVideo } from './UseLessonVideo.js';
import { describeLessonFailure, isLessonGenerating } from './LessonVideoLabels.js';
import { LessonVideoStudio } from './LessonVideoStudio.js';
import { LessonVideoCreateForm } from './LessonVideoCreateForm.js';
import { LessonVideoCard } from './LessonVideoCard.js';
import { LessonVideoEmptyState } from './LessonVideoEmptyState.js';
import { LessonGenerationProgress } from './LessonGenerationProgress.js';
import './LessonVideos.css';

/** The library stays mounted behind dialogs; closing them never cancels a server job. */
export function LessonVideosPage({ locale }: { locale: 'en' | 'vi' }): ReactElement {
  const view = useLessonVideo();
  const vi = locale === 'vi';
  const [creating, setCreating] = useState(false);
  const [showStudio, setShowStudio] = useState(false);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const filteredLessons = view.lessons.filter(
    (lesson) => !classFilter || lesson.classId === classFilter,
  );

  function openLesson(lesson: LessonVideo): void {
    setShowStudio(!isLessonGenerating(lesson));
    view.select(lesson);
    void view.execute({ kind: LessonCommand.READ, id: lesson.id });
  }

  function closeLesson(): void {
    view.select(null);
  }

  return (
    <section className="lesson-workspace">
      <header className="lesson-library-heading">
        <div>
          <Group gap="sm">
            <Title order={2}>{vi ? 'Video bài giảng' : 'Lesson videos'}</Title>
            <Badge variant="light" color="gray">
              {vi ? 'Thử nghiệm' : 'Beta'}
            </Badge>
          </Group>
          <Text className="lesson-library-subtitle">
            {vi
              ? 'Biến kiến thức thành những bài giảng sinh động, dễ hiểu.'
              : 'Turn knowledge into vivid, easy-to-follow lessons.'}
          </Text>
        </div>
        <Button
          className="lesson-primary"
          leftSection={<IconPlus size={17} aria-hidden="true" />}
          disabled={view.loading || view.busy}
          onClick={() => {
            setCreating(true);
          }}
        >
          {vi ? 'Tạo video' : 'Create video'}
        </Button>
      </header>
      {!creating && !view.selected && view.error && (
        <Alert color="orange">{describeLessonFailure(view.error, vi)}</Alert>
      )}
      <div className="lesson-library-toolbar">
        <Group gap="xs">
          <Text fw={600} size="sm">
            {vi ? 'Thư viện của bạn' : 'Your library'}
          </Text>
          <Badge variant="light" color="gray">
            {filteredLessons.length} {vi ? 'video' : 'videos'}
          </Badge>
        </Group>
        <Group gap="xs">
          {view.lessons.length > 0 && (
            <Select
              aria-label={vi ? 'Lọc theo lớp học' : 'Filter by class'}
              placeholder={vi ? 'Tất cả lớp học' : 'All classes'}
              clearable
              value={classFilter}
              onChange={setClassFilter}
              data={
                view.options?.classes.map((item) => ({ value: item.id, label: item.name })) ?? []
              }
            />
          )}
          <Button
            variant="subtle"
            size="compact-sm"
            disabled={view.busy}
            leftSection={<IconRefresh size={15} aria-hidden="true" />}
            onClick={() => {
              void view.execute({ kind: LessonCommand.LIST });
            }}
          >
            {vi ? 'Cập nhật' : 'Refresh'}
          </Button>
        </Group>
      </div>
      {view.loading ? (
        <div className="lesson-loading" role="status">
          <Loader size="sm" />
          <Text>{vi ? 'Đang tải thư viện…' : 'Loading your library…'}</Text>
        </div>
      ) : view.lessons.length === 0 ? (
        <LessonVideoEmptyState
          vi={vi}
          disabled={view.busy}
          create={() => {
            setCreating(true);
          }}
        />
      ) : filteredLessons.length === 0 ? (
        <div className="lesson-empty">
          <Text>
            {vi ? 'Lớp này chưa có video bài giảng.' : 'This class has no lesson videos yet.'}
          </Text>
          <Button
            variant="subtle"
            onClick={() => {
              setClassFilter(null);
            }}
          >
            {vi ? 'Xem tất cả video' : 'Show all videos'}
          </Button>
        </div>
      ) : (
        <div
          className="lesson-library"
          aria-label={vi ? 'Các video bài giảng' : 'Lesson video library'}
        >
          {filteredLessons.map((lesson) => (
            <LessonVideoCard
              key={lesson.id}
              lesson={lesson}
              vi={vi}
              className={
                view.options?.classes.find((item) => item.id === lesson.classId)?.name ??
                (vi ? 'Lớp học' : 'Class')
              }
              open={() => {
                openLesson(lesson);
              }}
            />
          ))}
        </div>
      )}
      <Modal
        opened={creating}
        onClose={() => {
          if (!view.busy) {
            setCreating(false);
          }
        }}
        title={vi ? 'Bạn muốn giải thích điều gì?' : 'What would you like to explain?'}
        centered
        size="lg"
        keepMounted
        closeOnEscape={!view.busy}
        closeOnClickOutside={!view.busy}
        withCloseButton={!view.busy}
        closeButtonProps={{ 'aria-label': vi ? 'Đóng' : 'Close' }}
        classNames={{ content: 'lesson-dialog', title: 'lesson-dialog-title' }}
      >
        <LessonVideoCreateForm
          options={view.options}
          busy={view.busy}
          error={view.error}
          locale={locale}
          execute={view.execute}
          onCreated={() => {
            setCreating(false);
            setClassFilter(null);
            setShowStudio(false);
          }}
        />
      </Modal>
      <Modal
        opened={view.selected !== null}
        onClose={closeLesson}
        title={
          showStudio
            ? vi
              ? 'Bài giảng của bạn'
              : 'Your lesson'
            : vi
              ? 'Tạo video bài giảng'
              : 'Lesson video generation'
        }
        centered
        size={showStudio ? 'min(1200px, 95vw)' : 'lg'}
        closeButtonProps={{ 'aria-label': vi ? 'Đóng bài giảng' : 'Close lesson' }}
        classNames={{ content: 'lesson-dialog', title: 'lesson-dialog-title' }}
      >
        {view.error && (
          <Alert color="orange" mb="sm">
            {describeLessonFailure(view.error, vi)}
          </Alert>
        )}
        {view.selected &&
          (showStudio ? (
            <LessonVideoStudio
              key={view.selected.id}
              lesson={view.selected}
              vi={vi}
              busy={view.busy}
              execute={view.execute}
              back={closeLesson}
            />
          ) : (
            <LessonGenerationProgress
              lesson={view.selected}
              vi={vi}
              busy={view.busy}
              execute={view.execute}
              close={closeLesson}
              preview={() => {
                setShowStudio(true);
              }}
            />
          ))}
      </Modal>
    </section>
  );
}
