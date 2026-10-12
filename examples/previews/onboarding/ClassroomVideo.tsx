import { Series, useVideoConfig } from 'remotion';
import type { ReactElement } from 'react';
import { VideoAudio } from './VideoAudio.js';
import { WalkthroughShot } from './WalkthroughShot.js';
import { readShotDuration } from './VideoTiming.js';

export function ClassroomVideo(): ReactElement {
  const { fps } = useVideoConfig();
  return (
    <>
      <VideoAudio topic="classes" />
      <Series>
        <Series.Sequence
          name="Lớp học · Mở đầu"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="ClassesIntro" step={1} />
        </Series.Sequence>
        <Series.Sequence name="Chọn lớp" durationInFrames={readShotDuration(fps)} premountFor={fps}>
          <WalkthroughShot shotId="ClassesPick" step={2} />
        </Series.Sequence>
        <Series.Sequence
          name="Tham gia bằng mã"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="ClassesCode" step={3} />
        </Series.Sequence>
        <Series.Sequence
          name="Tài liệu và hoạt động"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="ClassesReady" step={4} />
        </Series.Sequence>
      </Series>
    </>
  );
}
