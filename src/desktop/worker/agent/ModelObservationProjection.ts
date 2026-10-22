/** The legacy projection is an internal benchmark control. Normal desktop tasks
 * use the adaptive projection; this is not a user or environment setting. */
export const ModelObservationProjection = {
  LEGACY_JSON: 'legacy-json',
  ADAPTIVE_TOON: 'adaptive-toon',
} as const;

export type ModelObservationProjection =
  (typeof ModelObservationProjection)[keyof typeof ModelObservationProjection];
