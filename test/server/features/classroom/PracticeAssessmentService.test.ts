import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { PracticeCapability, type PracticeGrounding } from '#contracts/PracticeAssessment.js';
import { PracticeFinding, type PracticeEvidence } from '#contracts/PracticeCheck.js';
import { PracticeAssessmentService } from '../../../../src/server/features/classroom/application/PracticeAssessmentService.js';
import { PreparePracticeEvidence } from '../../../../src/server/features/classroom/application/PreparePracticeEvidence.js';
import { ExactOutputEvaluator } from '../../../../src/server/features/classroom/application/ExactOutputEvaluator.js';
import { ScratchStructureEvaluator } from '../../../../src/server/features/classroom/application/ScratchStructureEvaluator.js';
import { LlmCriterionEvaluator } from '../../../../src/server/features/classroom/infrastructure/LlmCriterionEvaluator.js';
import { ExtractPracticeArtifact } from '../../../../src/server/features/classroom/infrastructure/ExtractPracticeArtifact.js';
import { ExtractMaterial } from '../../../../src/server/features/materials/infrastructure/ExtractMaterial.js';
import type { PracticeCheckEvaluator } from '../../../../src/server/features/classroom/application/PracticeCheckEvaluator.js';
import { describePracticeEvidence } from '../../../../src/server/features/classroom/application/PracticeEvidence.js';
import { createPracticeCheckpoint } from './PracticeFixtures.js';

function fixture() {
  const rubric = createPracticeCheckpoint();
  const evidence: PracticeEvidence[] = [
    { id: randomUUID(), kind: 'text', name: 'Output.txt', text: 'Hello\r\n' },
  ];
  const grounding: PracticeGrounding = {
    courseRevisionId: randomUUID(),
    teacherInstructions: 'Accept equivalent work.',
    sources: [],
    missingSourceIds: [],
  };
  const evaluate = vi
    .fn<PracticeCheckEvaluator['evaluate']>()
    .mockImplementation((checkpoint, items) =>
      Promise.resolve({
        results: checkpoint.criteria.map((criterion) => ({
          criterionId: criterion.id,
          finding: PracticeFinding.MET,
          feedback: 'Visible greeting.',
          evidenceIds: items.map((item) => item.id),
        })),
      }),
    );
  const service = new PracticeAssessmentService(
    [
      new LlmCriterionEvaluator({ version: 'fake-v1', available: true, evaluate }),
      new ExactOutputEvaluator(),
      new ScratchStructureEvaluator(),
    ],
    new PreparePracticeEvidence(new ExtractPracticeArtifact(new ExtractMaterial())),
  );
  return { rubric, evidence, grounding, evaluate, service };
}

it('batches legacy LLM criteria with approved grounding and preserves extracted evidence provenance', async () => {
  const f = fixture();
  f.grounding.sources.push({
    id: randomUUID(),
    sourceUnitId: randomUUID(),
    location: 'Page 2',
    text: 'A greeting may be any language.',
    teacherNote: 'Do not demand the example verbatim.',
  });
  const result = await f.service.evaluate(
    f.rubric,
    f.evidence,
    'vi',
    new AbortController().signal,
    { grounding: f.grounding },
  );
  expect(f.evaluate).toHaveBeenCalledTimes(1);
  expect(f.evaluate.mock.calls[0]?.[4]).toMatchObject({
    grounding: f.grounding,
    units: [{ evidenceId: f.evidence[0]?.id, text: 'Hello\r\n' }],
  });
  expect(result.assessment).toMatchObject({
    courseRevisionId: f.grounding.courseRevisionId,
    sourceIds: [f.grounding.sources[0]?.id],
    evaluators: f.rubric.criteria.map((criterion) => ({
      criterionId: criterion.id,
      id: 'llm',
      version: 'fake-v1',
    })),
  });
});

it('uses explicit exact text rules without falling back to an unavailable model', async () => {
  const f = fixture();
  f.rubric.criteria = f.rubric.criteria.map((criterion) => ({
    ...criterion,
    verification: { kind: 'exact-output', expectedText: 'Hello' },
    capabilities: [PracticeCapability.TEXT],
  }));
  const result = await f.service.evaluate(
    f.rubric,
    f.evidence,
    'en',
    new AbortController().signal,
    { grounding: f.grounding },
  );
  expect(result.results.every((item) => item.finding === 'met')).toBe(true);
  expect(f.evaluate).not.toHaveBeenCalled();
  f.evidence = [{ id: randomUUID(), kind: 'text', name: 'Output.txt', text: 'hello' }];
  const different = await f.service.evaluate(
    f.rubric,
    f.evidence,
    'en',
    new AbortController().signal,
    { grounding: f.grounding },
  );
  expect(different.results.every((item) => item.finding === 'needs_changes')).toBe(true);
});

it.each(['missing-source', 'execution', 'teacher'] as const)(
  'abstains for %s without calling the judge',
  async (reason) => {
    const f = fixture();
    f.rubric.criteria = f.rubric.criteria.map((criterion) => ({
      ...criterion,
      ...(reason === 'execution' ? { capabilities: [PracticeCapability.VERIFIED_EXECUTION] } : {}),
      ...(reason === 'teacher' ? { verification: { kind: 'teacher' as const } } : {}),
      ...(reason === 'missing-source' ? { sourceIds: [f.grounding.courseRevisionId] } : {}),
    }));
    f.grounding.missingSourceIds = [f.grounding.courseRevisionId];
    const result = await f.service.evaluate(
      f.rubric,
      f.evidence,
      'vi',
      new AbortController().signal,
      { grounding: f.grounding },
    );
    expect(result.results.every((item) => item.finding === 'insufficient_evidence')).toBe(true);
    expect(f.evaluate).not.toHaveBeenCalled();
  },
);

it('rejects invented evidence citations and aborted work', async () => {
  const f = fixture();
  f.evaluate.mockResolvedValue({
    results: f.rubric.criteria.map((criterion) => ({
      criterionId: criterion.id,
      finding: 'met',
      feedback: 'Claim',
      evidenceIds: [randomUUID()],
    })),
  });
  await expect(
    f.service.evaluate(f.rubric, f.evidence, 'en', new AbortController().signal, {
      grounding: f.grounding,
    }),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.service.evaluate(f.rubric, f.evidence, 'en', abort.signal, { grounding: f.grounding }),
  ).rejects.toThrow();
});

it.each([true, false])(
  'reads real sb3 bytes and checks connected blocks (connected=%s)',
  async (connected) => {
    const f = fixture();
    const bytes = zipSync({
      'project.json': strToU8(
        JSON.stringify({
          targets: [
            {
              name: 'Cat',
              isStage: false,
              blocks: {
                start: {
                  opcode: 'event_whenflagclicked',
                  topLevel: true,
                  parent: null,
                  next: connected ? 'move' : null,
                },
                move: {
                  opcode: 'motion_movesteps',
                  parent: connected ? 'start' : null,
                  next: null,
                },
              },
            },
          ],
        }),
      ),
    });
    f.evidence = [
      {
        id: randomUUID(),
        kind: 'document',
        name: 'Work.sb3',
        mediaType: 'application/x.scratch.sb3',
        base64: Buffer.from(bytes).toString('base64'),
      },
    ];
    f.rubric.criteria = f.rubric.criteria.map((criterion) => ({
      ...criterion,
      verification: {
        kind: 'scratch-structure',
        eventOpcode: 'event_whenflagclicked',
        blockOpcode: 'motion_movesteps',
      },
      capabilities: [PracticeCapability.PROJECT_STRUCTURE],
    }));
    describePracticeEvidence(f.evidence);
    const result = await f.service.evaluate(
      f.rubric,
      f.evidence,
      'en',
      new AbortController().signal,
      { grounding: f.grounding },
    );
    expect(
      result.results.every((item) => item.finding === (connected ? 'met' : 'needs_changes')),
    ).toBe(true);
    expect(result.assessment?.units[0]).toMatchObject({
      evidenceId: f.evidence[0]?.id,
      location: 'Sprite: Cat',
    });
    expect(f.evaluate).not.toHaveBeenCalled();
  },
);

it('fails closed on malformed documents and derived evidence exceeding the budget', async () => {
  expect(() =>
    describePracticeEvidence([
      {
        id: randomUUID(),
        kind: 'document',
        name: 'Work.pdf',
        mediaType: 'application/pdf',
        base64: Buffer.from('wrong').toString('base64'),
      },
    ]),
  ).toThrow();
  const prepare = new PreparePracticeEvidence({
    version: 'fixture-v1',
    extract: (item) =>
      Promise.resolve([{ evidenceId: item.id, location: 'Page 1', text: 'x'.repeat(12001) }]),
  });
  await expect(
    prepare.prepare(
      [
        {
          id: randomUUID(),
          kind: 'document',
          name: 'Work.pdf',
          mediaType: 'application/pdf',
          base64: 'JVBERi0=',
        },
      ],
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

it('can establish required capabilities from complementary cited evidence', async () => {
  const f = fixture();
  f.rubric.criteria = f.rubric.criteria.map((criterion) => ({
    ...criterion,
    capabilities: [PracticeCapability.TEXT, PracticeCapability.IMAGE],
  }));
  f.evidence.push({
    id: randomUUID(),
    kind: 'image',
    name: 'Work.jpg',
    mediaType: 'image/jpeg',
    base64: '/9j/AQ==',
  });
  const result = await f.service.evaluate(
    f.rubric,
    f.evidence,
    'en',
    new AbortController().signal,
    { grounding: f.grounding },
  );
  expect(result.results.every((item) => item.finding === 'met')).toBe(true);
});
