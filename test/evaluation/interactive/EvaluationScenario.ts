import { z } from 'zod';
import { DesktopLocaleSchema } from '../../../src/contracts/DesktopLocale.js';
import { ScratchFixtureBug } from './ScratchProject.js';
import { EvaluationApplication } from './EvaluationApplication.js';

export const EvaluationScenarioApplication = {
  VSCODE: EvaluationApplication.VSCODE,
  SCRATCH: EvaluationApplication.SCRATCH,
} as const;

export type EvaluationScenarioApplication =
  (typeof EvaluationScenarioApplication)[keyof typeof EvaluationScenarioApplication];

export const EvaluationScenarioLimits = {
  SCENARIOS: 32,
  INPUT_BYTES: 1024 * 1024,
  PYTHON_SOURCE_BYTES: 16 * 1024,
} as const;

export const EvaluationScenarioProvenanceKind = {
  CUSTOMER_RECONSTRUCTION: 'customer_reconstruction',
  AUTHORED: 'authored',
  GENERATED: 'generated',
} as const;

export const EvaluationScenarioGrader = {
  PYTHON_GUESSING_GAME: 'PythonGuessingGame',
  SCRATCH_SCORE: 'ScratchScore',
} as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const ProvenanceSchema = z
  .strictObject({
    kind: z.enum(EvaluationScenarioProvenanceKind),
    sourceId: IdentifierSchema,
    seed: z.number().int().min(0).max(0xffff_ffff).nullable(),
    mutation: IdentifierSchema.nullable(),
  })
  .superRefine((provenance, context) => {
    if (
      provenance.kind === EvaluationScenarioProvenanceKind.GENERATED &&
      (provenance.seed === null || provenance.mutation === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Generated scenarios require their seed and mutation.',
      });
    }
    if (
      provenance.kind !== EvaluationScenarioProvenanceKind.GENERATED &&
      (provenance.seed !== null || provenance.mutation !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Seed and mutation identify generated scenarios only.',
      });
    }
  });

const CommonFields = {
  schemaVersion: z.literal(1),
  version: z.number().int().min(1).max(10_000),
  id: IdentifierSchema,
  title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(1).max(1200),
  historyText: z.string().max(4000),
  locale: DesktopLocaleSchema,
  provenance: ProvenanceSchema,
};

const PythonFixtureSchema = z
  .strictObject({
    kind: z.literal('python'),
    source: z
      .string()
      .min(1)
      .max(EvaluationScenarioLimits.PYTHON_SOURCE_BYTES)
      .refine(
        (source) =>
          new TextEncoder().encode(source).byteLength <=
          EvaluationScenarioLimits.PYTHON_SOURCE_BYTES,
        'The Python fixture exceeds its byte limit.',
      ),
    cursor: z.strictObject({
      line: z.number().int().min(1).max(128),
      column: z.number().int().min(1).max(4000),
    }),
  })
  .superRefine((fixture, context) => {
    const line = fixture.source.split('\n')[fixture.cursor.line - 1];
    if (line === undefined || fixture.cursor.column > line.length + 1) {
      context.addIssue({
        code: 'custom',
        message: 'The starting cursor must identify a position in the fixture.',
      });
    }
  });

const PythonEvaluationScenarioSchema = z.strictObject({
  ...CommonFields,
  application: z.literal(EvaluationScenarioApplication.VSCODE),
  graderId: z.literal(EvaluationScenarioGrader.PYTHON_GUESSING_GAME),
  fixture: PythonFixtureSchema,
});

const ScratchEvaluationScenarioSchema = z.strictObject({
  ...CommonFields,
  application: z.literal(EvaluationScenarioApplication.SCRATCH),
  graderId: z.literal(EvaluationScenarioGrader.SCRATCH_SCORE),
  fixture: z.strictObject({ kind: z.literal('scratch'), bug: z.enum(ScratchFixtureBug) }),
});

/** Internal manifests describe data and registered graders, never arbitrary
 * executable setup/grading commands. Evaluator answers are not manifest fields. */
export const EvaluationScenarioSchema = z.discriminatedUnion('application', [
  PythonEvaluationScenarioSchema,
  ScratchEvaluationScenarioSchema,
]);

export type EvaluationScenario = z.infer<typeof EvaluationScenarioSchema>;

export type PythonEvaluationScenario = z.infer<typeof PythonEvaluationScenarioSchema>;

export type ScratchEvaluationScenario = z.infer<typeof ScratchEvaluationScenarioSchema>;

export const EvaluationScenarioCollectionSchema = z
  .array(EvaluationScenarioSchema)
  .min(1)
  .max(EvaluationScenarioLimits.SCENARIOS);
