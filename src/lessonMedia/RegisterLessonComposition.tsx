import { Composition, registerRoot } from 'remotion';
import { z } from 'zod';
import { LearnerProjectionSchema } from '../contracts/GuidedLessons.js';
import { LessonComposition, readLessonDurationFrames } from './LessonComposition.js';

const LessonCompositionInputSchema = z.strictObject({
  projection: LearnerProjectionSchema,
  audioSources: z.record(z.string(), z.string()),
  sourceAssets: z.record(z.string(), z.string()),
});

/** Remotion passes JSON input props; validate them before entering the trusted presentation. */
function RenderLessonComposition(props: Record<string, unknown>) {
  return <LessonComposition {...LessonCompositionInputSchema.parse(props)} />;
}

function LessonRoot() {
  return (
    <Composition
      id="GuidedLesson"
      component={RenderLessonComposition}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={9000}
      calculateMetadata={({ props }) => ({
        durationInFrames: readLessonDurationFrames(LearnerProjectionSchema.parse(props.projection)),
      })}
    />
  );
}

registerRoot(LessonRoot);
