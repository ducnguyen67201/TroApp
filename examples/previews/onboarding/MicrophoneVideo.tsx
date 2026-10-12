import { Series, useVideoConfig } from 'remotion';
import type { ReactElement } from 'react';
import { VideoAudio } from './VideoAudio.js';
import { WalkthroughShot } from './WalkthroughShot.js';

export function MicrophoneVideo(): ReactElement {
  const { fps } = useVideoConfig();
  return (
    <>
      <VideoAudio topic="microphone" />
      <Series>
        <Series.Sequence name="Micrô · Mở đầu" durationInFrames={fps} premountFor={fps}>
          <WalkthroughShot shotId="MicrophoneIntro" step={1} stepCount={3} durationSeconds={1} />
        </Series.Sequence>
        <Series.Sequence name="Chọn thiết bị" durationInFrames={2 * fps} premountFor={fps}>
          <WalkthroughShot shotId="MicrophoneChoose" step={2} stepCount={3} durationSeconds={2} />
        </Series.Sequence>
        <Series.Sequence name="Giữ để nói, thả để gửi" durationInFrames={7 * fps} premountFor={fps}>
          <WalkthroughShot shotId="MicrophoneSpeak" step={3} stepCount={3} durationSeconds={7} />
        </Series.Sequence>
      </Series>
    </>
  );
}
