import { VideoTopic } from './VideoContent.js';

/** Approved compositions map to the desktop's recording stems without importing runtime code. */
export const onboardingVideoExports = [
  { compositionId: 'TroClassesVi', stem: 'StudentClasses', topic: VideoTopic.CLASSES },
  { compositionId: 'TroInsightsVi', stem: 'StudentInsights', topic: VideoTopic.INSIGHTS },
  { compositionId: 'TroGuidedLessonsVi', stem: 'StudentGuidedLessons', topic: VideoTopic.LESSONS },
  { compositionId: 'TroMicrophoneVi', stem: 'Microphone', topic: VideoTopic.MICROPHONE },
  { compositionId: 'TroPetsVi', stem: 'Pets', topic: VideoTopic.PETS },
] as const;
