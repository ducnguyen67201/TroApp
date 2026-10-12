import { Composition, registerRoot } from 'remotion';
import { LessonComposition } from './LessonComposition.js';
import { LessonLayout, LessonLimits } from '../contracts/LessonVideos.js';
import { LessonRenderPropsSchema } from '../contracts/LessonRenderProtocol.js';
import type { ReactElement } from 'react';

function LessonRoot(): ReactElement {
  return (
    <Composition
      id="LessonScreen"
      component={LessonComposition}
      width={LessonLimits.WIDTH}
      height={LessonLimits.HEIGHT}
      fps={LessonLimits.FPS}
      durationInFrames={180}
      defaultProps={{
        screen: {
          layout: LessonLayout.EXPLANATION,
          title: 'Lesson',
          points: ['Explanation'],
          narration: 'Explanation',
        },
        audioUrl: null,
        durationSeconds: 6,
      }}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.ceil(
          LessonRenderPropsSchema.parse(props).durationSeconds * LessonLimits.FPS,
        ),
      })}
    />
  );
}

registerRoot(LessonRoot);
