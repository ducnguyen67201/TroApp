import { defaultMaterialGenerationPolicy } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import { PrepareMaterialCollection } from '../../../../src/server/features/materials/application/PrepareMaterialCollection.js';
import { MaterialService } from '../../../../src/server/features/materials/application/MaterialService.js';
import { ExtractMaterial } from '../../../../src/server/features/materials/infrastructure/ExtractMaterial.js';
import { expect, it, vi } from 'vitest';
import {
  MaterialState,
  MaterialIssue,
  MaterialPreparationPhase,
} from '#contracts/ClassroomMaterials.js';
import { MaterialDerivationState } from '#contracts/MaterialContext.js';
import {
  createCompactFixture,
  readCompactCollection,
  readStageInputs,
} from './CompactMaterialFixtures.js';
import { randomUUID } from 'node:crypto';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
} from '../../../../src/server/features/materials/application/MaterialPreparationError.js';

it('generates one brief per document and composes from briefs, retaining unassigned original material', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const collection = await fixture.read();
  expect(collection.state).toBe(MaterialState.REVIEW);
  const draft = collection.draft;
  if (!draft || !('schemaVersion' in draft)) {
    throw new Error('V2 draft missing.');
  }
  expect(draft.documents).toHaveLength(2);
  expect(draft.pages).toHaveLength(2);
  expect(draft.sections[0]?.sourcePageIds).toHaveLength(1);
  expect(draft.pages.map((page) => page.extractedText).join(' ')).toContain('setup_editor');
  const composition = readStageInputs(fixture.generation).find(
    (input) => input.kind === 'composition',
  );
  expect(JSON.stringify(composition)).not.toContain('setup_editor');
  expect(collection.preparationProgress).toEqual({
    completed: 3,
    total: 3,
    phase: MaterialPreparationPhase.READY,
  });
});
it('reuses completed document briefs and changes only composition when teacher instructions change', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
  await fixture.queue('Practice independently.');
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(4);
  expect(fixture.generation.countInput).toHaveBeenCalledTimes(4);
});
it('does not silently replay an uncertain paid stage, and explicit retry retains successful briefs', async () => {
  const fixture = await createCompactFixture();
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generation.');
  }
  let fail = true;
  fixture.generation.generate.mockImplementation((input, signal) => {
    if (input.kind === 'composition' && fail) {
      return Promise.reject(new Error('Unknown provider outcome'));
    }
    return original(input, signal);
  });
  await fixture.service.prepareNextCollection();
  expect((await fixture.read()).state).toBe(MaterialState.FAILED);
  expect(
    [...fixture.store.materialDerivations.values()].some(
      (record) => record.state === MaterialDerivationState.UNCERTAIN,
    ),
  ).toBe(true);
  expect(await fixture.service.prepareNextCollection()).toBe(false);
  fail = false;
  await fixture.queue();
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(4);
  expect((await fixture.read()).state).toBe(MaterialState.REVIEW);
});
it('checks stage input limits before invoking generation', async () => {
  const fixture = await createCompactFixture();
  fixture.generation.countInput.mockResolvedValue(100001);
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).not.toHaveBeenCalled();
  expect((await fixture.read()).state).toBe(MaterialState.FAILED);
});
it('blocks unknown citations before caching a completed stage', async () => {
  const fixture = await createCompactFixture();
  fixture.generation.generate.mockResolvedValue({
    output: {
      kind: 'brief',
      brief: {
        purpose: { text: 'Wrong source', origin: 'source', sourceIds: [randomUUID()] },
        topics: [],
        setup: [],
        practice: [],
        examples: [],
        uncertainties: [],
      },
    },
    usedInput: 100,
    usedOutput: 10,
  });
  await fixture.service.prepareNextCollection();
  expect((await fixture.read()).state).toBe(MaterialState.FAILED);
  expect(
    [...fixture.store.materialDerivations.values()].every(
      (record) => record.state !== MaterialDerivationState.COMPLETED,
    ),
  ).toBe(true);
  expect(fixture.reportFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      generationStage: 'brief',
      referenceIssueCount: 1,
      referenceIssues: [
        expect.objectContaining({
          path: 'brief.purpose.sourceIds[0]',
          reason: 'reference_not_in_allowed_set',
          expectedKind: 'passage',
        }),
      ],
    }),
  );
  expect(fixture.reportFailure.mock.calls[0]?.[0].materialId).toMatch(/^[a-f0-9-]{36}$/);
  expect(fixture.reportFailure.mock.calls[0]?.[0].stageKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(fixture.reportFailure.mock.calls)).not.toContain('Wrong source');
});

it('logs the exact composition citation field after successful generation without publishing invalid output', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const previousDraft = (await fixture.read()).draft;
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generation.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const generated = await original(input, signal, context);
    if (input.kind !== 'composition' || generated.output.kind !== 'composition') {
      return generated;
    }
    const wrongId = input.documents[0]?.brief.purpose.sourceIds[0];
    if (!wrongId) {
      throw new Error('Missing passage ID.');
    }
    return {
      ...generated,
      output: {
        kind: 'composition',
        composition: {
          ...generated.output.composition,
          sections: generated.output.composition.sections.map((section) => ({
            ...section,
            sourcePageIds: [wrongId],
          })),
        },
      },
    };
  });
  await fixture.queue('Use current citations.');
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(5);
  expect(fixture.reportFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      generationStage: 'composition',
      referenceIssueCount: 1,
      referenceIssues: [
        expect.objectContaining({
          path: 'composition.sections[0].sourcePageIds[0]',
          reason: 'wrong_reference_kind',
          expectedKind: 'page',
          actualKind: 'passage',
        }),
      ],
    }),
  );
  expect(fixture.reportFailure.mock.calls[0]?.[0].stageKey).toMatch(/^[a-f0-9]{64}$/);
  expect(fixture.reportFailure.mock.calls[0]?.[0].failureSummary).toContain(
    'This field requires page IDs; it received a passage ID.',
  );
  const failed = await fixture.read();
  expect(failed.state).toBe(MaterialState.FAILED);
  expect(failed.draft).toEqual(previousDraft);
  expect(
    [...fixture.store.materialDerivations.values()].filter(
      (record) => record.state === MaterialDerivationState.REJECTED,
    ),
  ).toHaveLength(2);
  expect(await fixture.service.prepareNextCollection()).toBe(false);
});
it('protects V2 review edits from legacy saves and preserves separate teacher corrections', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const collection = await fixture.read();
  const draft = collection.draft;
  if (!draft || !('schemaVersion' in draft)) {
    throw new Error('Draft missing.');
  }
  const command = {
    kind: 'save-review' as const,
    classId: fixture.classId,
    version: collection.version,
    teacherInstructions: '',
    summary: draft.summary,
    sections: draft.sections,
    notes: draft.pages.map((page) => ({ pageId: page.id, text: page.teacherNote })),
    resolvedQuestions: true,
  };
  await expect(fixture.service.execute('teacher', command)).rejects.toMatchObject({
    code: 'stale',
  });
  const saved = readCompactCollection(
    await fixture.service.execute('teacher', {
      ...command,
      materialSchemaVersion: 2,
      documentNotes: draft.documents.map((document) => ({
        materialId: document.materialId,
        text: 'Teacher: use IDLE.',
      })),
    }),
  );
  if (!saved.draft || !('schemaVersion' in saved.draft)) {
    throw new Error('Draft missing.');
  }
  expect(saved.draft.documents[0]?.teacherNote).toBe('Teacher: use IDLE.');
  expect(saved.draft.documents[0]?.purpose.text).toBe('Practice Python.');
  await fixture.queue();
  await fixture.service.prepareNextCollection();
  const composition = readStageInputs(fixture.generation).at(-1);
  if (composition?.kind !== 'composition') {
    throw new Error('Composition missing.');
  }
  expect(
    composition.documents.some((document) => document.teacherNote === 'Teacher: use IDLE.'),
  ).toBe(true);
  const legacy = readCompactCollection(
    await fixture.service.execute('teacher', { kind: 'read', classId: fixture.classId }),
  );
  expect(legacy.draft).not.toHaveProperty('schemaVersion');
});

it('retains teacher page corrections when an extractor version refreshes unchanged source units', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const collection = await fixture.read();
  if (!collection.draft) {
    throw new Error('Missing draft.');
  }
  await fixture.service.execute('teacher', {
    kind: 'save-review',
    classId: fixture.classId,
    version: collection.version,
    materialSchemaVersion: 2,
    teacherInstructions: '',
    summary: collection.draft.summary,
    sections: collection.draft.sections,
    notes: collection.draft.pages.map((page) => ({ pageId: page.id, text: 'Teacher: use IDLE.' })),
    resolvedQuestions: true,
  });
  const stored = await fixture.store.readMaterialCollection(fixture.classId);
  if (!stored) {
    throw new Error('Missing stored collection.');
  }
  fixture.store.materialCollections.set(fixture.classId, {
    ...stored,
    extractionVersion: 'old-parser',
  });
  await fixture.queue();
  await fixture.service.prepareNextCollection();
  const refreshed = await fixture.read();
  expect(refreshed.draft?.pages[0]?.id).not.toBe(collection.draft.pages[0]?.id);
  expect(refreshed.draft?.pages[0]?.teacherNote).toBe('Teacher: use IDLE.');
});

it('revises the saved suggestions using cached briefs, preserving published content until approval', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const collection = await fixture.read();
  if (!collection.draft) {
    throw new Error('Draft missing.');
  }
  const saved = readCompactCollection(
    await fixture.service.execute('teacher', {
      kind: 'save-review',
      classId: fixture.classId,
      version: collection.version,
      materialSchemaVersion: 2,
      teacherInstructions: 'Use IDLE.',
      summary: 'Teacher wording to keep.',
      sections: collection.draft.sections.map((section) => ({
        ...section,
        title: 'Teacher section title',
      })),
      notes: collection.draft.pages.map((page) => ({
        pageId: page.id,
        text: 'Teacher: students run the whole file.',
      })),
      resolvedQuestions: true,
    }),
  );
  const approved = readCompactCollection(
    await fixture.service.execute('teacher', {
      kind: 'approve',
      classId: fixture.classId,
      version: saved.version,
      materialSchemaVersion: 2,
    }),
  );
  const publishedClass = await fixture.store.readClass(fixture.classId);
  if (!publishedClass) {
    throw new Error('Class missing.');
  }
  const publication = await fixture.store.readMaterialPublication(publishedClass.courseRevisionId);
  const queued = readCompactCollection(
    await fixture.service.execute('teacher', {
      kind: 'prepare',
      classId: fixture.classId,
      version: approved.version,
      materialSchemaVersion: 2,
      teacherInstructions: 'Use IDLE.',
      locale: 'en',
      revisionRequest: 'Combine the first sections and add input practice.',
    }),
  );
  expect(queued.sources).toEqual(approved.sources);
  expect(queued.draft).toEqual(approved.draft);
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(4);
  const composition = readStageInputs(fixture.generation).at(-1);
  expect(composition).toMatchObject({
    kind: 'composition',
    teacherInstructions: 'Use IDLE.',
    revision: {
      request: 'Combine the first sections and add input practice.',
      previousSummary: 'Teacher wording to keep.',
      previousSections: [{ title: 'Teacher section title', instruction: 'Print a greeting.' }],
    },
  });
  if (composition?.kind !== 'composition') {
    throw new Error('Missing composition.');
  }
  expect(composition.revision?.teacherNotes.map((note) => note.text)).toEqual([
    'Teacher: students run the whole file.',
    'Teacher: students run the whole file.',
  ]);
  expect((await fixture.read()).state).toBe(MaterialState.REVIEW);
  expect(await fixture.store.readClass(fixture.classId)).toEqual(publishedClass);
  expect(await fixture.store.readMaterialPublication(publishedClass.courseRevisionId)).toEqual(
    publication,
  );
  expect((await fixture.store.readMaterialCollection(fixture.classId))?.revisionRequest).toBeNull();
});

it('rejects a revision with no previous suggestions and keeps the request when a revision fails', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const collection = await fixture.read();
  fixture.generation.generate.mockRejectedValue(new Error('Provider failed'));
  await fixture.service.execute('teacher', {
    kind: 'prepare',
    classId: fixture.classId,
    version: collection.version,
    materialSchemaVersion: 2,
    teacherInstructions: '',
    locale: 'en',
    revisionRequest: 'Simplify the wording.',
  });
  await fixture.service.prepareNextCollection();
  const failed = await fixture.read();
  expect(failed.state).toBe(MaterialState.FAILED);
  expect(failed.sources).toEqual(collection.sources);
  expect(failed.draft).toEqual(collection.draft);
  expect((await fixture.store.readMaterialCollection(fixture.classId))?.revisionRequest).toBe(
    'Simplify the wording.',
  );
  const stored = await fixture.store.readMaterialCollection(fixture.classId);
  if (!stored) {
    throw new Error('Collection missing.');
  }
  fixture.store.materialCollections.set(fixture.classId, { ...stored, draft: null });
  await expect(
    fixture.service.execute('teacher', {
      kind: 'prepare',
      classId: fixture.classId,
      version: stored.version,
      materialSchemaVersion: 2,
      teacherInstructions: '',
      locale: 'en',
      revisionRequest: 'Edit nonexistent suggestions.',
    }),
  ).rejects.toMatchObject({ code: 'invalid' });
});

it('passes the same job and stage correlation to token counting and generation', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  for (const [index, [input, , context]] of fixture.generation.generate.mock.calls.entries()) {
    expect(context?.classId).toBe(fixture.classId);
    expect(typeof context?.jobId).toBe('string');
    expect(typeof context?.collectionVersion).toBe('number');
    expect(context?.stageKey).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.generation.countInput.mock.calls[index]?.[2]).toEqual(context);
    expect(fixture.generation.countInput.mock.calls[index]?.[0].kind).toBe(input.kind);
  }
  expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
});

it('reserves a larger composition allowance while keeping brief reservations compact', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const stages = [...fixture.store.materialDerivations.values()];
  expect(
    stages.filter((stage) => stage.result?.kind === 'brief').map((stage) => stage.reservedOutput),
  ).toEqual([2000, 2000]);
  expect(stages.find((stage) => stage.result?.kind === 'composition')?.reservedOutput).toBe(60000);
});

it('keeps old brief cache entries when only the composition allowance increases', async () => {
  const fixture = await createCompactFixture(undefined, {
    ...defaultMaterialGenerationPolicy,
    compositionOutputTokens: 2000,
  });
  await fixture.service.prepareNextCollection();
  const oldBriefKeys = [...fixture.store.materialDerivations.values()]
    .filter((stage) => stage.result?.kind === 'brief')
    .map((stage) => stage.key);
  await fixture.queue();
  const service = new MaterialService(
    fixture.store,
    new ExtractMaterial(),
    new PrepareMaterialCollection(fixture.store, fixture.generation),
  );
  await service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(4);
  expect(fixture.generation.countInput).toHaveBeenCalledTimes(4);
  expect(
    [...fixture.store.materialDerivations.values()]
      .filter((stage) => stage.result?.kind === 'brief')
      .map((stage) => stage.key),
  ).toEqual(oldBriefKeys);
  expect(
    [...fixture.store.materialDerivations.values()]
      .filter((stage) => stage.result?.kind === 'composition')
      .map((stage) => stage.reservedOutput),
  ).toEqual([2000, 60000]);
  expect((await fixture.read()).state).toBe(MaterialState.REVIEW);
});

it('checks the full composition reservation against the total job budget before generation', async () => {
  const fixture = await createCompactFixture(undefined, {
    ...defaultMaterialGenerationPolicy,
    outputTokens: 19000,
  });
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(2);
  expect(fixture.generation.countInput).toHaveBeenCalledTimes(3);
  expect((await fixture.read()).state).toBe(MaterialState.FAILED);
  expect(
    [...fixture.store.materialDerivations.values()].every(
      (stage) => stage.result?.kind === 'brief',
    ),
  ).toBe(true);
});

it('accepts larger lecture inputs within the new stage budget', async () => {
  const fixture = await createCompactFixture(['print("Hello")']);
  fixture.generation.countInput.mockResolvedValueOnce(80000).mockResolvedValueOnce(100);
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(2);
  expect((await fixture.read()).state).toBe(MaterialState.REVIEW);
});

it('repairs one completed composition with a separate claim, original evidence and cached briefs', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const previous = (await fixture.read()).draft;
  const briefKeys = [...fixture.store.materialDerivations.values()]
    .filter((stage) => stage.result?.kind === 'brief')
    .map((stage) => stage.key);
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const generated = await original(input, signal, context);
    if (input.kind !== 'composition' || generated.output.kind !== 'composition') {
      return generated;
    }
    if (input.citationRepair) {
      expect((await fixture.read()).preparationProgress?.phase).toBe(
        MaterialPreparationPhase.CORRECTING_REFERENCES,
      );
      expect(input.citationRepair.evidence[0]?.text).toBe('print("Hello")');
      expect(input.citationRepair.issues[0]?.path).toBe('composition.sections[0].sourcePageIds[0]');
      expect(input.citationRepair.previousComposition.sections[0]?.sourcePageIds[0]).toBe(
        input.sourceMap[0]?.passageId,
      );
      expect(input.sourceMap[0]).toEqual({
        passageId: previous && 'schemaVersion' in previous ? previous.passages[0]?.id : '',
        pageId: previous?.pages[0]?.id,
        materialId: previous?.pages[0]?.materialId,
      });
      return generated;
    }
    return {
      ...generated,
      output: {
        kind: 'composition',
        composition: {
          ...generated.output.composition,
          sections: generated.output.composition.sections.map((section) => ({
            ...section,
            sourcePageIds: [input.sourceMap[0]?.passageId ?? randomUUID()],
          })),
        },
      },
    };
  });
  await fixture.queue('Correct citations.');
  await fixture.service.prepareNextCollection();
  const current = await fixture.read();
  expect(current.state).toBe(MaterialState.REVIEW);
  expect(current.draft?.summary).toBe(previous?.summary);
  expect(fixture.generation.generate).toHaveBeenCalledTimes(5);
  expect(fixture.reportFailure).not.toHaveBeenCalled();
  const rejectedEvent = fixture.reportStage.mock.calls.find(([event]) => event.rejected)?.[0];
  expect(rejectedEvent?.referenceIssues?.[0]?.path).toBe(
    'composition.sections[0].sourcePageIds[0]',
  );
  expect(rejectedEvent?.citationRepair).toBe(false);
  expect(fixture.reportStage.mock.calls.at(-1)?.[0].citationRepair).toBe(true);
  expect(JSON.stringify(fixture.reportStage.mock.calls)).not.toMatch(
    /print\("Hello"\)|Correct citations|Practice Python/,
  );
  expect(
    [...fixture.store.materialDerivations.values()]
      .filter((stage) => stage.result?.kind === 'brief')
      .map((stage) => stage.key),
  ).toEqual(briefKeys);
  const stored = await fixture.store.readMaterialCollection(fixture.classId);
  const stages = await fixture.store.listMaterialDerivations(stored?.jobId ?? '');
  expect(stages).toHaveLength(2);
  expect(new Set(stages.map((stage) => stage.key)).size).toBe(2);
  const rejected = stages.find((stage) => stage.state === MaterialDerivationState.REJECTED);
  expect(rejected).toMatchObject({
    result: null,
    usedInput: 100,
    usedOutput: 50,
    reservedOutput: 60000,
  });
  expect(
    stages.find((stage) => stage.state === MaterialDerivationState.COMPLETED)?.result?.kind,
  ).toBe('composition');
});

it.each([{ outputTokens: 64000 }, { calls: 3 }, { inputTokens: 350 }, { stageInputTokens: 150 }])(
  'admits citation repair through the existing budgets (%j)',
  async (limit) => {
    const fixture = await createCompactFixture(undefined, {
      ...defaultMaterialGenerationPolicy,
      ...limit,
    });
    const original = fixture.generation.generate.getMockImplementation();
    if (!original) {
      throw new Error('Missing generator.');
    }
    fixture.generation.generate.mockImplementation(async (input, signal, context) => {
      const result = await original(input, signal, context);
      if (result.output.kind === 'composition') {
        result.output.composition.sections.forEach((section) => {
          section.sourcePageIds = [randomUUID()];
        });
      }
      return result;
    });
    fixture.generation.countInput.mockImplementation((input) =>
      Promise.resolve(
        input.kind === 'composition' && input.citationRepair && 'stageInputTokens' in limit
          ? 200
          : 100,
      ),
    );
    await fixture.service.prepareNextCollection();
    expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
    expect(fixture.generation.countInput).toHaveBeenCalledTimes(4);
    expect((await fixture.read()).issue).toBe(MaterialIssue.GENERATION_LIMIT);
    expect(fixture.reportFailure.mock.calls[0]?.[0].reason).toBe(
      MaterialPreparationReason.GENERATION_LIMIT,
    );
    expect([...fixture.store.materialDerivations.values()]).toHaveLength(3);
  },
);

it.each([
  MaterialPreparationReason.PROVIDER_TIMEOUT,
  MaterialPreparationReason.INCOMPLETE_RESPONSE,
  MaterialPreparationReason.INVALID_JSON,
])('does not repair a provider failure or unfinished response (%s)', async (reason) => {
  const fixture = await createCompactFixture();
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation((input, signal, context) =>
    input.kind === 'composition'
      ? Promise.reject(new MaterialPreparationError({ reason }))
      : original(input, signal, context),
  );
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
  expect((await fixture.read()).state).toBe(MaterialState.FAILED);
  expect(
    [...fixture.store.materialDerivations.values()].filter(
      (stage) => stage.state === MaterialDerivationState.UNCERTAIN,
    ),
  ).toHaveLength(1);
});

it('rejects a citation repair that changes lesson content and retains the previous review', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const previous = (await fixture.read()).draft;
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const generated = await original(input, signal, context);
    if (input.kind === 'composition' && generated.output.kind === 'composition') {
      if (input.citationRepair) {
        generated.output.composition.summary = 'AI rewrote the lesson.';
      } else {
        generated.output.composition.sections.forEach((section) => {
          section.sourcePageIds = [randomUUID()];
        });
      }
    }
    return generated;
  });
  await fixture.queue('Preserve teacher wording.');
  await fixture.service.prepareNextCollection();
  const failed = await fixture.read();
  expect(failed.state).toBe(MaterialState.FAILED);
  expect(failed.issue).toBe(MaterialIssue.CITATION_VALIDATION_FAILED);
  expect(failed.draft).toEqual(previous);
  expect(fixture.generation.generate).toHaveBeenCalledTimes(5);
  expect(fixture.reportFailure.mock.calls[0]?.[0]).toMatchObject({
    reason: MaterialPreparationReason.CITATION_REPAIR_CHANGED_CONTENT,
    citationRepair: true,
  });
  const legacy = readCompactCollection(
    await fixture.service.execute('teacher', { kind: 'read', classId: fixture.classId }),
  );
  expect(legacy.issue).toBe(MaterialIssue.PREPARATION_FAILED);
  expect(legacy).not.toHaveProperty('preparationProgress');
});

it('stops at an expired job lease rather than invoking citation repair', async () => {
  const fixture = await createCompactFixture();
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const generated = await original(input, signal, context);
    if (generated.output.kind === 'composition') {
      generated.output.composition.sections.forEach((section) => {
        section.sourcePageIds = [randomUUID()];
      });
      const stored = await fixture.store.readMaterialCollection(fixture.classId);
      if (!stored) {
        throw new Error('Missing collection.');
      }
      fixture.store.materialCollections.set(fixture.classId, {
        ...stored,
        leaseUntil: new Date(0).toISOString(),
      });
    }
    return generated;
  });
  await fixture.service.prepareNextCollection();
  expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
  expect(fixture.reportFailure.mock.calls[0]?.[0].reason).toBe(
    MaterialPreparationReason.STALE_STAGE,
  );
  expect((await fixture.read()).state).toBe(MaterialState.FAILED);
});

it('does not schedule repair if persisting the confirmed rejection fails', async () => {
  const fixture = await createCompactFixture();
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const result = await original(input, signal, context);
    if (result.output.kind === 'composition') {
      result.output.composition.sections.forEach((section) => {
        section.sourcePageIds = [randomUUID()];
      });
    }
    return result;
  });
  const save = fixture.store.saveMaterialDerivation.bind(fixture.store);
  const spy = vi
    .spyOn(fixture.store, 'saveMaterialDerivation')
    .mockImplementation((record, claimId) =>
      record.state === MaterialDerivationState.REJECTED
        ? Promise.reject(new Error('Storage unavailable'))
        : save(record, claimId),
    );
  try {
    await fixture.service.prepareNextCollection();
    expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
    expect((await fixture.read()).state).toBe(MaterialState.FAILED);
    expect(
      readStageInputs(fixture.generation).some(
        (input) => input.kind === 'composition' && input.citationRepair,
      ),
    ).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it('uses the original job abort signal to stop before a citation repair', async () => {
  const fixture = await createCompactFixture();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const generated = await original(input, signal, context);
    if (generated.output.kind === 'composition') {
      generated.output.composition.sections.forEach((section) => {
        section.sourcePageIds = [randomUUID()];
      });
      controller.abort(new DOMException('Job deadline', 'TimeoutError'));
    }
    return generated;
  });
  try {
    await fixture.service.prepareNextCollection();
    expect(fixture.generation.generate).toHaveBeenCalledTimes(3);
    expect((await fixture.read()).state).toBe(MaterialState.FAILED);
  } finally {
    timeout.mockRestore();
  }
});

it('does not publish or overwrite a newer job when a repair returns late', async () => {
  const fixture = await createCompactFixture();
  await fixture.service.prepareNextCollection();
  const previous = (await fixture.read()).draft;
  const newJobId = randomUUID();
  const original = fixture.generation.generate.getMockImplementation();
  if (!original) {
    throw new Error('Missing generator.');
  }
  fixture.generation.generate.mockImplementation(async (input, signal, context) => {
    const result = await original(input, signal, context);
    if (input.kind === 'composition' && result.output.kind === 'composition') {
      if (input.citationRepair) {
        const current = await fixture.store.readMaterialCollection(fixture.classId);
        if (!current) {
          throw new Error('Missing collection.');
        }
        fixture.store.materialCollections.set(fixture.classId, {
          ...current,
          version: current.version + 1,
          jobId: newJobId,
          state: MaterialState.QUEUED,
        });
      } else {
        result.output.composition.sections.forEach((section) => {
          section.sourcePageIds = [randomUUID()];
        });
      }
    }
    return result;
  });
  await fixture.queue('Correct citations.');
  await fixture.service.prepareNextCollection();
  const current = await fixture.store.readMaterialCollection(fixture.classId);
  expect(current?.jobId).toBe(newJobId);
  expect(current?.state).toBe(MaterialState.QUEUED);
  expect(current?.draft).toEqual(previous);
  expect(fixture.generation.generate).toHaveBeenCalledTimes(5);
  expect(fixture.reportFailure.mock.calls[0]?.[0].reason).toBe(
    MaterialPreparationReason.STALE_STAGE,
  );
});
