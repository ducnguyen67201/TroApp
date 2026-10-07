import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { MaterialGenerationOutput } from '#contracts/MaterialContext.js';
import { buildMaterialPassages } from '../../../../src/server/features/materials/application/MaterialSourceSelection.js';
import type { MaterialStageInput } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import { MaterialPreparationReason } from '../../../../src/server/features/materials/application/MaterialPreparationError.js';
import {
  MaterialCitationRejection,
  buildMaterialCitationRepair,
  validateMaterialCitationRepair,
} from '../../../../src/server/features/materials/application/MaterialCitationRepair.js';

type Composition = Extract<MaterialGenerationOutput, { kind: 'composition' }>['composition'];

it('bounds original repair evidence and prioritizes the source implicated by the rejection', () => {
  const pages = Array.from({ length: 12 }, (_, index) => ({
    id: randomUUID(),
    materialId: randomUUID(),
    location: `Page ${String(index)}`,
    extractedText: `Original ${String(index)}`,
    teacherNote: null,
    preparedNote: '',
    warnings: [],
  }));
  const passages = buildMaterialPassages(pages);
  const target = passages[11];
  if (!target) {
    throw new Error('Missing passage.');
  }
  const input: Extract<MaterialStageInput, { kind: 'composition' }> = {
    kind: 'composition',
    locale: 'en',
    teacherInstructions: '',
    documents: [],
    sources: [],
    sourceUnits: pages.map(({ id, materialId, location }) => ({ id, materialId, location })),
    sourceMap: passages.map((passage) => ({
      passageId: passage.id,
      pageId: passage.sourceUnitId,
      materialId: passage.materialId,
    })),
  };
  const composition: Composition = {
    summary: '',
    questions: [],
    sections: [
      { title: 'Practice', instruction: 'Practice', sourcePageIds: [target.id], setup: [] },
    ],
  };
  const rejection = new MaterialCitationRejection(
    {
      reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
      referenceIssueCount: 20,
      referenceIssues: Array.from({ length: 20 }, () => ({
        path: 'composition.sections[0].sourcePageIds[0]',
        reason: 'wrong_reference_kind',
        expectedKind: 'page',
        actualKind: 'passage',
        sourceId: target.id,
        allowedReferenceCount: 12,
      })),
    },
    composition,
  );
  const repair = buildMaterialCitationRepair(input, rejection, passages);
  expect(repair.citationRepair?.issues).toHaveLength(10);
  expect(repair.citationRepair?.issueCount).toBe(20);
  expect(repair.citationRepair?.evidence).toHaveLength(8);
  expect(repair.citationRepair?.evidence[0]).toEqual(target);
  expect(repair.sourceMap).toEqual(input.sourceMap);
});

it('allows only citation array changes and rejects content or requirement changes', () => {
  const previous: Composition = {
    summary: 'Teacher summary',
    questions: ['Which editor?'],
    sections: [
      {
        title: 'Print',
        instruction: 'Print',
        sourcePageIds: [randomUUID()],
        setup: [{ text: 'Editor', origin: 'source', sourceIds: [randomUUID()] }],
        practiceSuggestions: [
          {
            title: 'Greeting',
            task: 'Print',
            origin: 'source',
            criteria: [
              {
                description: 'Greeting visible',
                required: true,
                evidenceNeeded: 'text',
                sourceIds: [randomUUID()],
              },
            ],
          },
        ],
      },
    ],
  };
  const repaired = structuredClone(previous);
  const section = repaired.sections[0];
  const note = section?.setup[0];
  const exercise = section?.practiceSuggestions?.[0];
  const criterion = exercise?.criteria[0];
  if (!section || !note || !exercise || !criterion) {
    throw new Error('Missing exercise.');
  }
  section.sourcePageIds = [randomUUID()];
  note.sourceIds = [randomUUID()];
  criterion.sourceIds = [randomUUID()];
  expect(() => {
    validateMaterialCitationRepair(previous, repaired);
  }).not.toThrow();
  exercise.origin = 'suggestion';
  expect(() => {
    validateMaterialCitationRepair(previous, repaired);
  }).toThrow();
  exercise.origin = 'source';
  criterion.required = false;
  expect(() => {
    validateMaterialCitationRepair(previous, repaired);
  }).toThrow();
  criterion.required = true;
  repaired.questions = [];
  expect(() => {
    validateMaterialCitationRepair(previous, repaired);
  }).toThrow();
});
