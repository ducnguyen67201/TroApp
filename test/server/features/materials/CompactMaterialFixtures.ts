import { defaultMaterialGenerationPolicy } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import type { MaterialCollection, MaterialReply } from '#contracts/ClassroomMaterials.js';
import { MaterialEvidenceOrigin } from '#contracts/MaterialContext.js';
import { ClassroomService } from '../../../../src/server/features/classroom/application/ClassroomService.js';
import { MaterialService } from '../../../../src/server/features/materials/application/MaterialService.js';
import { PrepareMaterialCollection } from '../../../../src/server/features/materials/application/PrepareMaterialCollection.js';
import type {
  MaterialGeneration,
  MaterialGenerationPolicy,
  MaterialStageInput,
} from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import { ExtractMaterial } from '../../../../src/server/features/materials/infrastructure/ExtractMaterial.js';
import { MemoryClassroomStore } from '../classroom/ClassroomFixtures.js';
import { vi } from 'vitest';

export function readCompactCollection(reply: MaterialReply): MaterialCollection {
  if (reply.kind !== 'collection') {
    throw new Error('Missing collection.');
  }
  return reply.collection;
}

export function createMaterialGeneration() {
  const generate = vi.fn<MaterialGeneration['generate']>((input) => {
    if (input.kind === 'brief') {
      const sourceId = input.passages[0]?.id ?? input.summaries[0]?.purpose.sourceIds[0];
      if (!sourceId) {
        throw new Error('Missing source.');
      }
      return Promise.resolve({
        output: {
          kind: 'brief',
          brief: {
            purpose: {
              text: 'Practice Python.',
              origin: MaterialEvidenceOrigin.SOURCE,
              sourceIds: [sourceId],
            },
            topics: ['Python'],
            setup: [],
            practice: [],
            examples: [],
            uncertainties: [],
          },
        },
        usedInput: 100,
        usedOutput: 50,
      });
    }
    const sourceId = input.sourceUnits[0]?.id;
    if (!sourceId) {
      throw new Error('Missing source unit.');
    }
    return Promise.resolve({
      output: {
        kind: 'composition',
        composition: {
          summary: 'A short overview.',
          questions: [],
          sections: [
            {
              title: 'Practice',
              instruction: 'Print a greeting.',
              sourcePageIds: [sourceId],
              setup: [],
            },
          ],
        },
      },
      usedInput: 100,
      usedOutput: 50,
    });
  });
  const countInput = vi.fn<MaterialGeneration['countInput']>(() => Promise.resolve(100));
  return { available: true, version: 'test-v2', generate, countInput } satisfies MaterialGeneration;
}

export async function createCompactFixture(
  texts = ['print("Hello")', 'setup_editor = "IDLE"'],
  policy: MaterialGenerationPolicy = defaultMaterialGenerationPolicy,
) {
  const store = new MemoryClassroomStore();
  const classroom = new ClassroomService(store);
  await classroom.execute('teacher', { kind: 'create-class', name: 'Python' });
  const schoolClass = [...store.classes.values()][0];
  if (!schoolClass) {
    throw new Error('Missing class.');
  }
  const generation = createMaterialGeneration();
  const reportStage =
    vi.fn<NonNullable<ConstructorParameters<typeof PrepareMaterialCollection>[3]>>();
  const prepare = new PrepareMaterialCollection(store, generation, policy, reportStage);
  const reportFailure = vi.fn<NonNullable<ConstructorParameters<typeof MaterialService>[4]>>();
  const service = new MaterialService(
    store,
    new ExtractMaterial(),
    prepare,
    () => new Date(),
    reportFailure,
  );
  let version = 0;
  for (const [index, text] of texts.entries()) {
    const collection = readCompactCollection(
      await service.execute('teacher', {
        kind: 'upload',
        classId: schoolClass.id,
        version,
        name: `Lesson${String(index)}.py`,
        data: Buffer.from(text).toString('base64'),
        materialSchemaVersion: 2,
      }),
    );
    version = collection.version;
  }
  const queue = async (instructions = 'Students practice.') => {
    const collection = readCompactCollection(
      await service.execute('teacher', {
        kind: 'read',
        classId: schoolClass.id,
        materialSchemaVersion: 2,
      }),
    );
    await service.execute('teacher', {
      kind: 'prepare',
      classId: schoolClass.id,
      version: collection.version,
      teacherInstructions: instructions,
      locale: 'en',
      materialSchemaVersion: 2,
    });
  };
  await queue();
  const read = async () =>
    readCompactCollection(
      await service.execute('teacher', {
        kind: 'read',
        classId: schoolClass.id,
        materialSchemaVersion: 2,
      }),
    );
  return {
    store,
    classroom,
    generation,
    prepare,
    service,
    reportFailure,
    classId: schoolClass.id,
    reportStage,
    queue,
    read,
  };
}

export function readStageInputs(
  generation: ReturnType<typeof createMaterialGeneration>,
): MaterialStageInput[] {
  return generation.generate.mock.calls.map(([input]) => input);
}
