import type { ReactElement } from 'react';
import { Button, Text, Title } from '@mantine/core';
import { IconFileText, IconPlayerPlay, IconPlus, IconSparkles } from '@tabler/icons-react';

export function LessonVideoEmptyState({
  vi,
  disabled,
  create,
}: {
  vi: boolean;
  disabled: boolean;
  create: () => void;
}): ReactElement {
  return (
    <div>
      <div className="lesson-library-empty">
        <div className="lesson-empty-art" aria-hidden="true">
          <div className="lesson-art-sheet">
            <IconFileText />
            <i />
            <i />
            <i />
          </div>
          <div className="lesson-art-player">
            <IconPlayerPlay />
          </div>
          <IconSparkles className="lesson-art-spark" />
        </div>
        <Title order={3}>
          {vi
            ? 'Bài giảng đầu tiên bắt đầu từ một ý tưởng.'
            : 'Your first lesson starts with an idea.'}
        </Title>
        <Text>
          {vi
            ? 'Một khái niệm khó, một ví dụ hay, hay tài liệu của lớp. Tro giúp bạn kể lại bằng một video ngắn, dễ hiểu.'
            : 'A tricky concept, a great example, or your class materials. Turn it into a short video that makes learning easier.'}
        </Text>
        <Button
          className="lesson-primary"
          leftSection={<IconPlus size={17} aria-hidden="true" />}
          disabled={disabled}
          onClick={create}
        >
          {vi ? 'Tạo video đầu tiên' : 'Create your first video'}
        </Button>
        <Text size="xs">
          {vi
            ? '3–6 cảnh · Khoảng 1–2 phút · Giọng đọc AI'
            : '3–6 scenes · About 1–2 minutes · AI narration'}
        </Text>
      </div>
      <ol className="lesson-empty-steps">
        <li>{vi ? 'Chọn lớp & tài liệu' : 'Choose class & materials'}</li>
        <li>{vi ? 'Mô tả ý tưởng' : 'Describe your idea'}</li>
        <li>{vi ? 'Xem bài giảng' : 'Watch your lesson'}</li>
      </ol>
    </div>
  );
}
