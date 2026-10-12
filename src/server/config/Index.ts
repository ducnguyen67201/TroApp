/** Backend feature configuration entry point. Secrets remain in ../Env.ts. */
export {
  PracticeCheckConfig,
  readPracticeCheckConfig,
  type PracticeCheckSettings,
} from './PracticeCheckConfig.js';

export {
  ClassroomInsightConfig,
  readClassroomInsightConfig,
  type ClassroomInsightSettings,
} from './ClassroomInsightConfig.js';

export { MaterialConfig, readMaterialConfig, type MaterialSettings } from './MaterialConfig.js';

export {
  VoiceoverConfig,
  readVoiceoverAllowanceConfig,
  type VoiceoverAllowanceSettings,
} from './VoiceoverConfig.js';
