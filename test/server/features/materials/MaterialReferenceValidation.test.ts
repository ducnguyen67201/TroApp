import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  MaterialEvidenceOrigin,
  type DocumentBriefContent,
  type MaterialGenerationOutput,
} from '#contracts/MaterialContext.js';
import type { MaterialStageInput } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
} from '../../../../src/server/features/materials/application/MaterialPreparationError.js';
import {
  validateBriefReferences,
  validateCompositionReferences,
} from '../../../../src/server/features/materials/application/MaterialReferenceValidation.js';

function fixture() {
  const pageId = randomUUID();
  const passageId = randomUUID();
  const materialId = randomUUID();
  const brief: DocumentBriefContent = {
    purpose: {
      text: 'PRIVATE SOURCE TEXT',
      origin: MaterialEvidenceOrigin.SOURCE,
      sourceIds: [passageId],
    },
    topics: [],
    setup: [],
    practice: [],
    examples: [],
    uncertainties: [],
  };
  const input: Extract<MaterialStageInput, { kind: 'composition' }> = {
    kind: 'composition',
    locale: 'en',
    teacherInstructions: 'PRIVATE TEACHER TEXT',
    documents: [{ materialId, brief, teacherNote: null }],
    sourceUnits: [{ id: pageId, materialId, location: 'PRIVATE LOCATION' }],
    sourceMap: [{ passageId, pageId, materialId }],
    sources: [],
  };
  const composition: Extract<MaterialGenerationOutput, { kind: 'composition' }>['composition'] = {
    summary: 'PRIVATE GENERATED TEXT',
    questions: [],
    sections: [
      {
        title: 'PRIVATE TITLE',
        instruction: 'PRIVATE INSTRUCTION',
        sourcePageIds: [pageId],
        setup: [],
      },
    ],
  };
  const section = composition.sections[0];
  if (!section) {
    throw new Error('Missing section.');
  }
  return { pageId, passageId, brief, input, composition, section };
}

function readDiagnostic(run: () => void) {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof MaterialPreparationError) {
      return error.diagnostic;
    }
    throw error;
  }
  throw new Error('Expected reference rejection.');
}

it('distinguishes page/passage confusion from references absent from the supplied input', () => {
  const { pageId, passageId, input, composition, section } = fixture();
  const unknownId = randomUUID();
  section.sourcePageIds = [passageId, unknownId];
  section.setup = [
    { text: 'PRIVATE NOTE', origin: MaterialEvidenceOrigin.SOURCE, sourceIds: [pageId] },
  ];
  const diagnostic = readDiagnostic(() => {
    validateCompositionReferences(composition, input);
  });
  expect(diagnostic).toMatchObject({
    reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
    generationStage: 'composition',
    referenceIssueCount: 3,
    allowedPageCount: 1,
    allowedPassageCount: 1,
    referenceIssuesTruncated: false,
    referenceIssues: [
      {
        path: 'composition.sections[0].sourcePageIds[0]',
        reason: 'wrong_reference_kind',
        expectedKind: 'page',
        actualKind: 'passage',
        sourceId: passageId,
      },
      {
        path: 'composition.sections[0].sourcePageIds[1]',
        reason: 'reference_not_in_allowed_set',
        expectedKind: 'page',
        sourceId: unknownId,
      },
      {
        path: 'composition.sections[0].setup[0].sourceIds[0]',
        reason: 'wrong_reference_kind',
        expectedKind: 'passage',
        actualKind: 'page',
        sourceId: pageId,
      },
    ],
  });
  expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
});

it('logs missing source-backed exercise and setup citations but accepts uncited suggestions', () => {
  const { input, composition, section } = fixture();
  section.setup = [{ text: 'Set up editor', origin: MaterialEvidenceOrigin.SOURCE, sourceIds: [] }];
  section.practiceSuggestions = [
    {
      title: 'Greeting',
      task: 'Print a greeting',
      origin: 'source',
      criteria: [
        { description: 'Greeting visible', required: true, evidenceNeeded: 'text', sourceIds: [] },
      ],
    },
  ];
  expect(
    readDiagnostic(() => {
      validateCompositionReferences(composition, input);
    }),
  ).toMatchObject({
    referenceIssueCount: 2,
    referenceIssues: [
      {
        path: 'composition.sections[0].practiceSuggestions[0].criteria[0].sourceIds',
        reason: 'missing_required_reference',
        expectedKind: 'page',
      },
      {
        path: 'composition.sections[0].setup[0].sourceIds',
        reason: 'missing_required_reference',
        expectedKind: 'passage',
      },
    ],
  });
  section.setup = [
    { text: 'Consider an editor', origin: MaterialEvidenceOrigin.SUGGESTION, sourceIds: [] },
  ];
  section.practiceSuggestions = [
    {
      title: 'Greeting',
      task: 'Print a greeting',
      origin: 'suggestion',
      criteria: [
        { description: 'Greeting visible', required: true, evidenceNeeded: 'text', sourceIds: [] },
      ],
    },
  ];
  expect(() => {
    validateCompositionReferences(composition, input);
  }).not.toThrow();
});

it('keeps issue lists bounded and excludes arbitrary strings from source ID diagnostics', () => {
  const { brief } = fixture();
  brief.purpose.sourceIds = [
    ...Array.from({ length: 14 }, () => randomUUID()),
    'PRIVATE INVALID ID',
  ];
  const diagnostic = readDiagnostic(() => {
    validateBriefReferences(brief, []);
  });
  expect(diagnostic.referenceIssueCount).toBe(15);
  expect(diagnostic.referenceIssues).toHaveLength(10);
  expect(diagnostic.referenceIssuesTruncated).toBe(true);
  brief.purpose.sourceIds = ['PRIVATE INVALID ID'];
  const unsafeIdDiagnostic = readDiagnostic(() => {
    validateBriefReferences(brief, []);
  });
  expect(unsafeIdDiagnostic.referenceIssues?.[0]).not.toHaveProperty('sourceId');
  expect(JSON.stringify(unsafeIdDiagnostic)).not.toContain('PRIVATE');
});

it('preserves valid brief and composition bindings and identifies brief page IDs', () => {
  const { brief, pageId, passageId, input, composition } = fixture();
  expect(() => {
    validateBriefReferences(brief, [passageId], [pageId]);
  }).not.toThrow();
  expect(() => {
    validateCompositionReferences(composition, input);
  }).not.toThrow();
  brief.purpose.sourceIds = [pageId];
  expect(
    readDiagnostic(() => {
      validateBriefReferences(brief, [passageId], [pageId]);
    }),
  ).toMatchObject({
    generationStage: 'brief',
    referenceIssues: [
      {
        path: 'brief.purpose.sourceIds[0]',
        expectedKind: 'passage',
        actualKind: 'page',
        sourceId: pageId,
      },
    ],
  });
});
