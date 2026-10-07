import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { MaterialStageInput } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import {
  buildMaterialCompositionFormat,
  buildMaterialCompositionSchema,
} from '../../../../src/server/features/materials/infrastructure/MaterialCompositionFormat.js';

function fixture() {
  const materialId = randomUUID();
  const pageId = randomUUID();
  const passageId = randomUUID();
  const input: Extract<MaterialStageInput, { kind: 'composition' }> = {
    kind: 'composition',
    locale: 'en',
    teacherInstructions: '',
    documents: [],
    sources: [],
    sourceUnits: [{ id: pageId, materialId, location: 'Page 1' }],
    sourceMap: [{ passageId, pageId, materialId }],
  };
  const composition = {
    summary: 'Print a greeting.',
    questions: [],
    sections: [
      {
        title: 'Printing',
        instruction: 'Print a greeting.',
        sourcePageIds: [pageId],
        setup: [{ text: 'Open editor.', origin: 'source', sourceIds: [passageId] }],
        practiceSuggestions: [
          {
            title: 'Greeting',
            task: 'Print a greeting.',
            origin: 'source',
            criteria: [
              {
                description: 'Greeting visible',
                required: true,
                evidenceNeeded: 'text',
                sourceIds: [pageId],
              },
            ],
          },
        ],
      },
    ],
  };
  return { input, composition, pageId, passageId };
}

it('constrains pages, passages and source-backed requirements to their own allowed IDs', () => {
  const { input, composition, pageId, passageId } = fixture();
  const schema = buildMaterialCompositionSchema(input);
  expect(schema.safeParse(composition).success).toBe(true);
  const section = composition.sections[0];
  if (!section) {
    throw new Error('Missing section.');
  }
  for (const id of [passageId, randomUUID()]) {
    expect(
      schema.safeParse({ ...composition, sections: [{ ...section, sourcePageIds: [id] }] }).success,
    ).toBe(false);
  }
  for (const sourceIds of [[], [pageId], [randomUUID()]]) {
    expect(
      schema.safeParse({
        ...composition,
        sections: [{ ...section, setup: [{ text: 'Editor', origin: 'source', sourceIds }] }],
      }).success,
    ).toBe(false);
  }
  for (const sourceIds of [[], [passageId], [randomUUID()]]) {
    expect(
      schema.safeParse({
        ...composition,
        sections: [
          {
            ...section,
            practiceSuggestions: [
              {
                title: 'Greeting',
                task: 'Print',
                origin: 'source',
                criteria: [
                  { description: 'Greeting', required: true, evidenceNeeded: 'text', sourceIds },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  }
});

it('supports uncited suggestions and no retained passages without empty enums', () => {
  const { input, composition } = fixture();
  input.sourceMap = [];
  const schema = buildMaterialCompositionSchema(input);
  const section = composition.sections[0];
  if (!section) {
    throw new Error('Missing section.');
  }
  expect(
    schema.safeParse({
      ...composition,
      sections: [
        {
          ...section,
          setup: [{ text: 'Optional editor', origin: 'suggestion', sourceIds: [] }],
          practiceSuggestions: [
            {
              title: 'Optional practice',
              task: 'Print',
              origin: 'suggestion',
              criteria: [
                { description: 'Greeting', required: true, evidenceNeeded: 'text', sourceIds: [] },
              ],
            },
          ],
        },
      ],
    }).success,
  ).toBe(true);
  expect(schema.safeParse(composition).success).toBe(false);
  expect(JSON.stringify(buildMaterialCompositionFormat(input).schema)).not.toContain('"enum":[]');
  expect(() => buildMaterialCompositionFormat({ ...input, sourceUnits: [] })).toThrow();
});

function readSchemaEnums(value: unknown): string[][] {
  const arrays = z.array(z.unknown()).safeParse(value);
  if (arrays.success) {
    return arrays.data.flatMap(readSchemaEnums);
  }
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) {
    return [];
  }
  const strings = z.array(z.string()).safeParse(record.data['enum']);
  return [
    ...(strings.success ? [strings.data] : []),
    ...Object.values(record.data).flatMap(readSchemaEnums),
  ];
}

it('shares enum definitions and chunks passage IDs for a maximum-sized collection', () => {
  const { input } = fixture();
  input.sourceUnits = Array.from({ length: 120 }, () => ({
    id: randomUUID(),
    materialId: randomUUID(),
    location: 'Page',
  }));
  const page = input.sourceUnits[0];
  if (!page) {
    throw new Error('Missing page.');
  }
  input.sourceMap = Array.from({ length: 600 }, () => ({
    passageId: randomUUID(),
    pageId: page.id,
    materialId: page.materialId,
  }));
  const format = buildMaterialCompositionFormat(input);
  const enums = readSchemaEnums(format.schema);
  expect(enums.flat()).toHaveLength(720);
  expect(enums.every((values) => values.join('').length <= 15000)).toBe(true);
  expect(JSON.stringify(format.schema)).toContain('"$ref"');
  expect(format.strict).toBe(true);
});
