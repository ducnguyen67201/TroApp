import { Composition, registerRoot } from 'remotion';
import type { ReactElement } from 'react';
import { ClassroomVideo } from './ClassroomVideo.js';
import { InsightsVideo } from './InsightsVideo.js';
import { GuidedLessonsVideo } from './GuidedLessonsVideo.js';
import { MicrophoneVideo } from './MicrophoneVideo.js';
import { PetsVideo } from './PetsVideo.js';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';
import '@fontsource/noto-sans/vietnamese-400.css';
import '@fontsource/noto-sans/vietnamese-700.css';

function Root(): ReactElement {
  return (
    <>
      <Composition
        id="TroClassesVi"
        component={ClassroomVideo}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="TroInsightsVi"
        component={InsightsVideo}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="TroGuidedLessonsVi"
        component={GuidedLessonsVideo}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="TroMicrophoneVi"
        component={MicrophoneVideo}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="TroPetsVi"
        component={PetsVideo}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
}

registerRoot(Root);
