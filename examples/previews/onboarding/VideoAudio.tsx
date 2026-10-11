import type { ReactElement } from 'react';
import { Audio } from '@remotion/media';
import { staticFile, useVideoConfig } from 'remotion';
import type { VideoTopic } from './VideoContent.js';
import { videoNarration } from './VideoNarration.js';

export function VideoAudio({ topic }: { topic: VideoTopic }): ReactElement {
  const { fps } = useVideoConfig();
  return (
    <Audio
      name="Giọng AI · OpenAI Marin"
      src={staticFile(`Audio/${videoNarration[topic].file}`)}
      from={Math.round(fps * 0.15)}
      premountFor={fps}
    />
  );
}
