import { z } from 'zod';

import { MicrophoneTestPhase, speechTestSeconds } from './MicrophoneTestTiming.js';

export {
  MicrophoneTestPhase,
  quietTestSeconds,
  speechTestSeconds,
} from './MicrophoneTestTiming.js';

const LevelSchema = z.number().min(-120).max(0);

export const MicrophoneMeasurementSchema = z.strictObject({
  version: z.literal(1),
  noiseDb: LevelSchema,
  speechDb: LevelSchema,
  clippedFraction: z.number().min(0).max(1),
});

export type MicrophoneMeasurement = z.infer<typeof MicrophoneMeasurementSchema>;

export interface MicrophoneTestResult extends MicrophoneMeasurement {
  deviceId: string;
  startupMs: number;
}

export const MicrophoneMeasurementEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('progress'),
    phase: z.enum([MicrophoneTestPhase.QUIET, MicrophoneTestPhase.SPEAKING]),
    secondsRemaining: z.number().int().min(0).max(speechTestSeconds),
  }),
  z.strictObject({ kind: z.literal('result'), measurement: MicrophoneMeasurementSchema }),
]);

export type MicrophoneMeasurementEvent = z.infer<typeof MicrophoneMeasurementEventSchema>;
