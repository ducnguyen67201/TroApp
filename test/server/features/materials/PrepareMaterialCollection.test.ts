import { expect, it } from 'vitest';
import { MaterialState } from '#contracts/ClassroomMaterials.js';
import { MaterialDerivationState } from '#contracts/MaterialContext.js';
import {
  createCompactFixture,
  readCompactCollection,
  readStageInputs,
} from './CompactMaterialFixtures.js';
import { randomUUID } from 'node:crypto';

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
  expect(collection.preparationProgress).toEqual({ completed: 3, total: 3 });
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
  fixture.generation.countInput.mockResolvedValue(100000);
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
