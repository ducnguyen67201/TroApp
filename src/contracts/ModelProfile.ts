import { ModelConfig } from './config/ModelConfig.js';

/** Canonical model vocabulary shared by the desktop actor and authenticated gateway. */
export const ModelProfile = { MAIN: ModelConfig.textModel } as const;

export const ModelReasoningEffort = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
  MAX: 'max',
} as const;
