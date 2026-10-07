import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MaterialContextLimits,
  MaterialContextStatus,
  MaterialSourceScope,
  MaterialPacketSchema,
} from '#contracts/MaterialContext.js';
import { ClassroomPacing } from '#contracts/Classroom.js';
import {
  selectMaterialPacket,
  materialTokenCounter,
} from '../../../../src/server/features/materials/application/MaterialTokenBudget.js';
import {
  readMaterialSource,
  searchMaterialSources,
} from '../../../../src/server/features/materials/application/ReadMaterialSources.js';
import { buildMaterialLessonContext } from '../../../../src/server/features/materials/application/MaterialLessonContext.js';
import { createCompactFixture, readCompactCollection } from './CompactMaterialFixtures.js';

async function publish(texts?: string[]) {
  const fixture = await createCompactFixture(texts);
  await fixture.service.prepareNextCollection();
  const collection = await fixture.read();
  if (!collection.draft) {
    throw new Error('Missing draft.');
  }
  const saved = readCompactCollection(
    await fixture.service.execute('teacher', {
      kind: 'save-review',
      classId: fixture.classId,
      version: collection.version,
      materialSchemaVersion: 2,
      teacherInstructions: collection.teacherInstructions,
      summary: collection.draft.summary,
      sections: collection.draft.sections,
      notes: collection.draft.pages.map((page) => ({ pageId: page.id, text: page.teacherNote })),
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
  const publication = await fixture.store.readMaterialPublication(approved.approvedCourseId ?? '');
  if (!publication) {
    throw new Error('Missing publication.');
  }
  return { ...fixture, publication };
}

it('bounds a ten-document packet while retaining all originals and an index', async () => {
  const fixture = await publish(
    Array.from(
      { length: 10 },
      (_, index) => `# Lesson ${String(index)}\n` + 'print("Xin chào các bạn")\n'.repeat(100),
    ),
  );
  const activityId = fixture.publication.draft.sections[0]?.id ?? '';
  const { materialContext } = await buildMaterialLessonContext(
    fixture.store,
    fixture.publication.courseId,
    activityId,
    2,
  );
  if (!materialContext || !('schemaVersion' in materialContext) || !materialContext.packet) {
    throw new Error('Missing packet.');
  }
  expect(materialContext.packet.documentIndex).toHaveLength(10);
  expect(materialContext.tokens).toBeLessThanOrEqual(MaterialContextLimits.TARGET_TOKENS);
  expect(materialContext.omittedCount).toBeGreaterThan(0);
  expect(fixture.publication.draft.pages).toHaveLength(10);
  expect(MaterialPacketSchema.safeParse(materialContext.packet).success).toBe(true);
});
it('retrieves a prerequisite from an unlinked document even when the brief omitted it', async () => {
  const fixture = await publish();
  const activityId = fixture.publication.draft.sections[0]?.id ?? '';
  const search = searchMaterialSources(fixture.publication, activityId, 'setup_editor IDLE', null);
  const sourceId = search.matches[0]?.sourceId ?? '';
  const result = readMaterialSource(fixture.publication, sourceId, MaterialSourceScope.PASSAGE);
  expect(result?.evidence[0]?.text).toContain('setup_editor');
  expect(materialTokenCounter.countText(JSON.stringify(search))).toBeLessThanOrEqual(
    MaterialContextLimits.SEARCH_TOKENS,
  );
});
it('reads long code with explicit continuations and no missing characters', async () => {
  const text = 'print("Xin chào các bạn")\n'.repeat(1000);
  const fixture = await publish([text]);
  if (!('schemaVersion' in fixture.publication.draft)) {
    throw new Error('V2 missing.');
  }
  let reconstructed = '';
  for (const passage of fixture.publication.draft.passages) {
    let offset = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = readMaterialSource(
        fixture.publication,
        passage.id,
        MaterialSourceScope.PASSAGE,
        offset,
      );
      if (!result) {
        throw new Error('Missing read.');
      }
      expect(materialTokenCounter.countText(JSON.stringify(result))).toBeLessThanOrEqual(
        MaterialContextLimits.READ_TOKENS,
      );
      reconstructed += result.evidence.map((item) => item.text).join('');
      if (result.nextOffset === null) {
        break;
      }
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
    }
  }
  expect(reconstructed).toBe(text);
});
it('reports required evidence that cannot fit instead of truncating it or claiming readiness', async () => {
  const fixture = await publish();
  if (!('schemaVersion' in fixture.publication.draft)) {
    throw new Error('Missing draft.');
  }
  const passage = fixture.publication.draft.passages[0];
  if (!passage) {
    throw new Error('Missing passage.');
  }
  const base = {
    schemaVersion: 2 as const,
    courseRevisionId: fixture.publication.courseId,
    activityId: randomUUID(),
    summary: '',
    teacherInstructions: '',
    setup: [],
    documentNotes: [],
    documentIndex: [],
  };
  const selection = selectMaterialPacket(
    base,
    [passage.id],
    [{ ...passage, text: '漢字 '.repeat(3000) }],
  );
  expect(selection.status).toBe(MaterialContextStatus.NEEDS_EXPANSION);
  expect(selection.missingSourceIds).toEqual([passage.id]);
  expect(selection.packet?.evidence).toEqual([]);
});
it('authorizes retrieval through the current student participation and pinned publication', async () => {
  const fixture = await publish();
  const activityId = fixture.publication.draft.sections[0]?.id ?? '';
  await fixture.store.enrollStudent(fixture.classId, 'student', true);
  await fixture.classroom.execute('teacher', {
    kind: 'start-session',
    classId: fixture.classId,
    activityId,
    pacing: ClassroomPacing.TEACHER,
  });
  const meeting = [...fixture.store.meetings.values()][0];
  if (!meeting) {
    throw new Error('Missing meeting.');
  }
  const reply = await fixture.classroom.execute('student', {
    kind: 'join',
    classSessionId: meeting.id,
    deviceId: randomUUID(),
    materialSchemaVersion: 2,
  });
  if (reply.kind !== 'context') {
    throw new Error('Missing context.');
  }
  const binding = {
    participationId: reply.context.participation.id,
    deviceId: reply.context.participation.deviceId,
    activityId,
    contextVersion: reply.context.meeting.contextVersion,
    progressVersion: reply.context.attempt.progressVersion,
  };
  await expect(
    fixture.classroom.execute('student', {
      kind: 'read-material-source',
      ...binding,
      sourceId: randomUUID(),
      scope: MaterialSourceScope.PASSAGE,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    fixture.classroom.execute('student', {
      kind: 'search-material',
      ...binding,
      question: 'setup',
      documentId: null,
      contextVersion: binding.contextVersion + 1,
    }),
  ).rejects.toMatchObject({ code: 'stale' });
  const result = await fixture.classroom.execute('student', {
    kind: 'search-material',
    ...binding,
    question: 'setup',
    documentId: null,
  });
  expect(result.kind).toBe('material-search');
  await fixture.store.enrollStudent(fixture.classId, 'student', false);
  await expect(
    fixture.classroom.execute('student', {
      kind: 'search-material',
      ...binding,
      question: 'setup',
      documentId: null,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});
