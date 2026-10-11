import { Series, useVideoConfig } from 'remotion';
import type { ReactElement } from 'react';
import { VideoAudio } from './VideoAudio.js';
import { WalkthroughShot } from './WalkthroughShot.js';
import { readShotDuration } from './VideoTiming.js';

export function PetsVideo(): ReactElement {
  const { fps } = useVideoConfig();
  return (
    <>
      <VideoAudio topic="pets" />
      <Series>
        <Series.Sequence
          name="Thú cưng · Mở đầu"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="PetsIntro" step={1} />
        </Series.Sequence>
        <Series.Sequence
          name="Chọn bạn và đặt tên"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="PetsChoose" step={2} />
        </Series.Sequence>
        <Series.Sequence
          name="Di chuyển và tương tác"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="PetsMove" step={3} />
        </Series.Sequence>
        <Series.Sequence
          name="Yên lặng và giảm chuyển động"
          durationInFrames={readShotDuration(fps)}
          premountFor={fps}
        >
          <WalkthroughShot shotId="PetsQuiet" step={4} />
        </Series.Sequence>
      </Series>
    </>
  );
}
