import { Series, useVideoConfig } from 'remotion';
import type { ReactElement } from 'react';
import { VideoAudio } from './VideoAudio.js';
import { WalkthroughShot } from './WalkthroughShot.js';
import { readShotDuration } from './VideoTiming.js';

export function GuidedLessonsVideo(): ReactElement {
  const { fps } = useVideoConfig();
  return (
    <>
      <VideoAudio topic="lessons" />
      <Series>
        <Series.Sequence
          name="Bài giảng · Mở đầu"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="LessonsIntro" step={1} />
        </Series.Sequence>
        <Series.Sequence
          name="Chọn bài đã phát hành"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="LessonsPick" step={2} />
        </Series.Sequence>
        <Series.Sequence
          name="Hỏi phần chưa rõ"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="LessonsPace" step={3} />
        </Series.Sequence>
        <Series.Sequence
          name="Xem lại trước khi gửi"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="LessonsHelp" step={4} />
        </Series.Sequence>
      </Series>
    </>
  );
}
