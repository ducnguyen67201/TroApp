import { Series, useVideoConfig } from 'remotion';
import type { ReactElement } from 'react';
import { VideoAudio } from './VideoAudio.js';
import { WalkthroughShot } from './WalkthroughShot.js';
import { readShotDuration } from './VideoTiming.js';

export function InsightsVideo(): ReactElement {
  const { fps } = useVideoConfig();
  return (
    <>
      <VideoAudio topic="insights" />
      <Series>
        <Series.Sequence
          name="Tiến độ · Mở đầu"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="InsightsIntro" step={1} />
        </Series.Sequence>
        <Series.Sequence
          name="Chọn lớp và khoảng thời gian"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="InsightsChoose" step={2} />
        </Series.Sequence>
        <Series.Sequence
          name="Đọc kết quả trong ngữ cảnh"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="InsightsRead" step={3} />
        </Series.Sequence>
        <Series.Sequence
          name="Bước học tiếp theo"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="InsightsNext" step={4} />
        </Series.Sequence>
      </Series>
    </>
  );
}
