import { createHash, randomUUID } from 'node:crypto';
import {
  MaterialDraftV2Schema,
  MaterialState,
  type MaterialDraftV2,
} from '#contracts/ClassroomMaterials.js';
import {
  MaterialDerivationState,
  MaterialEvidenceOrigin,
  MaterialGenerationOutputSchema,
  type DocumentBrief,
  type DocumentBriefContent,
  type MaterialGenerationOutput,
  type MaterialSourcePassage,
} from '#contracts/MaterialContext.js';
import type { ClassroomStore } from '../../classroom/application/ClassroomStore.js';
import type { MaterialPreparation } from './MaterialPreparation.js';
import {
  type MaterialGeneration,
  type MaterialStageInput,
  type MaterialGenerationPolicy,
  defaultMaterialGenerationPolicy,
} from './MaterialGeneration.js';
import { MaterialPreparationError, MaterialPreparationReason } from './MaterialPreparationError.js';
import { buildMaterialPassages } from './MaterialSourceSelection.js';
import { materialTokenCounter } from './MaterialTokenBudget.js';

/** One teacher job, bounded durable stages. Existing publications never depend on this mutable cache. */
export class PrepareMaterialCollection implements MaterialPreparation {
  readonly available: boolean;
  constructor(
    private readonly store: ClassroomStore,
    private readonly generation: MaterialGeneration,
    private readonly policy: MaterialGenerationPolicy = defaultMaterialGenerationPolicy,
    private readonly report: (event: {
      jobId: string;
      kind: string;
      cacheHit: boolean;
      inputTokens: number;
      outputTokens: number | null;
    }) => void = () => {},
  ) {
    this.available = generation.available;
  }

  async prepare(input: Parameters<MaterialPreparation['prepare']>[0]): Promise<MaterialDraftV2> {
    const { classId, jobId, collectionVersion } = input;
    if (!classId || !jobId || collectionVersion === undefined) {
      throw new Error('Preparation job binding missing.');
    }
    const binding = {
      classId,
      jobId,
      collectionVersion,
      extractionVersion: input.extractionVersion ?? null,
    };
    const signal = AbortSignal.timeout(this.policy.deadlineMs);
    const passages = buildMaterialPassages(input.pages);
    const documents: DocumentBrief[] = [];
    for (const source of input.sources) {
      const documentPassages = passages.filter((passage) => passage.materialId === source.id);
      const file = input.files.find((item) => item.id === source.id) ?? null;
      const isPdf = file?.name.toLowerCase().endsWith('.pdf') ?? false;
      const groups: MaterialSourcePassage[][] = [];
      let group: MaterialSourcePassage[] = [];
      for (const passage of documentPassages) {
        if (
          !isPdf &&
          group.length &&
          materialTokenCounter.countText(JSON.stringify([...group, passage])) > 8000
        ) {
          groups.push(group);
          group = [];
        }
        group.push(passage);
      }
      if (group.length) {
        groups.push(group);
      }
      const summaries: DocumentBriefContent[] = [];
      for (const part of groups) {
        const result = await this.runStage(
          binding,
          {
            kind: 'brief',
            locale: input.locale,
            materialId: source.id,
            passages: part,
            summaries: [],
            file: isPdf ? file : null,
          },
          signal,
        );
        if (result.kind !== 'brief') {
          throw new Error('Unexpected generation stage.');
        }
        validateBriefReferences(
          result.brief,
          part.map((passage) => passage.id),
        );
        summaries.push(result.brief);
      }
      let brief = summaries[0];
      if (summaries.length > 1) {
        const result = await this.runStage(
          binding,
          {
            kind: 'brief',
            locale: input.locale,
            materialId: source.id,
            passages: [],
            summaries,
            file: null,
          },
          signal,
        );
        if (result.kind !== 'brief') {
          throw new Error('Unexpected generation stage.');
        }
        validateBriefReferences(
          result.brief,
          documentPassages.map((passage) => passage.id),
        );
        brief = result.brief;
      }
      if (!brief) {
        throw new MaterialPreparationError({
          reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
        });
      }
      const previousDraft = input.previousDraft;
      const teacherNote =
        previousDraft && 'schemaVersion' in previousDraft
          ? (previousDraft.documents.find(
              (document) =>
                document.materialId === source.id && document.sourceDigest === source.digest,
            )?.teacherNote ?? null)
          : null;
      documents.push({ ...brief, materialId: source.id, sourceDigest: source.digest, teacherNote });
      await this.store.runAtomically(async (store) => {
        const current = await this.requireCurrentJob(store, binding);
        await store.saveMaterialCollection(
          {
            ...current,
            preparationProgress: { completed: documents.length, total: input.sources.length + 1 },
          },
          current.version,
        );
      });
    }
    const revision = buildMaterialRevision(input);
    const result = await this.runStage(
      binding,
      {
        kind: 'composition',
        locale: input.locale,
        documents: documents.map((document) => ({
          materialId: document.materialId,
          brief: {
            purpose: document.purpose,
            topics: document.topics,
            setup: document.setup,
            practice: document.practice,
            examples: document.examples,
            uncertainties: document.uncertainties,
          },
          teacherNote: document.teacherNote,
        })),
        teacherInstructions: input.teacherInstructions,
        ...(revision ? { revision } : {}),
        sources: input.sources,
        sourceUnits: input.pages.map(({ id, materialId, location }) => ({
          id,
          materialId,
          location,
        })),
      },
      signal,
    );
    if (result.kind !== 'composition') {
      throw new Error('Unexpected generation stage.');
    }
    return MaterialDraftV2Schema.parse({
      schemaVersion: 2,
      ...result.composition,
      sections: result.composition.sections.map(({ practiceSuggestions, ...section }) => ({
        ...section,
        id: randomUUID(),
        ...(practiceSuggestions?.length
          ? {
              practiceCheckpoints: practiceSuggestions.map((suggestion) => ({
                ...suggestion,
                id: randomUUID(),
                rubricRevisionId: randomUUID(),
                approved: false,
                criteria: suggestion.criteria.map((criterion) => ({
                  ...criterion,
                  id: randomUUID(),
                })),
              })),
            }
          : {}),
      })),
      pages: input.pages,
      passages,
      documents,
    });
  }

  private async runStage(
    binding: {
      classId: string;
      jobId: string;
      collectionVersion: number;
      extractionVersion: string | null;
    },
    input: MaterialStageInput,
    signal: AbortSignal,
  ): Promise<MaterialGenerationOutput> {
    signal.throwIfAborted();
    const reference =
      input.kind === 'brief'
        ? {
            ...input,
            file: input.file
              ? {
                  id: input.file.id,
                  digest: createHash('sha256').update(input.file.bytes).digest('hex'),
                }
              : null,
          }
        : input;
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          version: this.generation.version,
          extractionVersion: binding.extractionVersion,
          outputTokens: this.policy.stageOutputTokens,
          input: reference,
        }),
      )
      .digest('hex');
    const cached = await this.store.readMaterialDerivation(binding.classId, key);
    if (cached?.state === MaterialDerivationState.COMPLETED && cached.result) {
      await this.requireCurrentJob(this.store, binding);
      this.report({
        jobId: binding.jobId,
        kind: input.kind,
        cacheHit: true,
        inputTokens: 0,
        outputTokens: 0,
      });
      return cached.result;
    }
    const inputTokens = await this.generation.countInput(input, signal);
    if (inputTokens > this.policy.stageInputTokens) {
      throw new MaterialPreparationError({ reason: MaterialPreparationReason.GENERATION_LIMIT });
    }
    const claim = await this.store.runAtomically(async (store) => {
      await this.requireCurrentJob(store, binding);
      const current = await store.readMaterialDerivation(binding.classId, key);
      if (current?.jobId === binding.jobId && current.state !== MaterialDerivationState.COMPLETED) {
        throw new MaterialPreparationError({ reason: MaterialPreparationReason.STALE_STAGE });
      }
      const stages = await store.listMaterialDerivations(binding.jobId);
      if (
        stages.length >= this.policy.calls ||
        stages.reduce((sum, stage) => sum + stage.reservedInput, 0) + inputTokens >
          this.policy.inputTokens ||
        stages.reduce((sum, stage) => sum + stage.reservedOutput, 0) +
          this.policy.stageOutputTokens >
          this.policy.outputTokens
      ) {
        throw new MaterialPreparationError({ reason: MaterialPreparationReason.GENERATION_LIMIT });
      }
      const record = {
        classId: binding.classId,
        jobId: binding.jobId,
        collectionVersion: binding.collectionVersion,
        key,
        claimId: randomUUID(),
        state: MaterialDerivationState.PREPARING,
        reservedInput: inputTokens,
        reservedOutput: this.policy.stageOutputTokens,
        usedInput: null,
        usedOutput: null,
        result: null,
      };
      await store.saveMaterialDerivation(record, current?.claimId ?? null);
      return record;
    });
    try {
      const generated = await this.generation.generate(input, signal);
      const output = MaterialGenerationOutputSchema.parse(generated.output);
      if (output.kind !== input.kind) {
        throw new MaterialPreparationError({ reason: MaterialPreparationReason.INVALID_DRAFT });
      }
      if (output.kind === 'brief' && input.kind === 'brief') {
        validateBriefReferences(output.brief, [
          ...input.passages.map((passage) => passage.id),
          ...input.summaries.flatMap((summary) =>
            [summary.purpose, ...summary.setup, ...summary.practice, ...summary.examples].flatMap(
              (note) => note.sourceIds,
            ),
          ),
        ]);
      }
      if (output.kind === 'composition' && input.kind === 'composition') {
        const pageIds = new Set(input.sourceUnits.map((unit) => unit.id));
        const passageIds = new Set(
          input.documents.flatMap((document) =>
            [
              document.brief.purpose,
              ...document.brief.setup,
              ...document.brief.practice,
              ...document.brief.examples,
            ].flatMap((note) => note.sourceIds),
          ),
        );
        if (
          output.composition.sections.some(
            (section) =>
              section.sourcePageIds.some((id) => !pageIds.has(id)) ||
              (section.practiceSuggestions ?? []).some((checkpoint) =>
                checkpoint.criteria.some(
                  (criterion) =>
                    criterion.sourceIds.some((id) => !pageIds.has(id)) ||
                    (checkpoint.origin === 'source' && criterion.sourceIds.length === 0),
                ),
              ) ||
              section.setup.some(
                (note) =>
                  (note.origin === MaterialEvidenceOrigin.SOURCE && note.sourceIds.length === 0) ||
                  note.sourceIds.some((id) => !passageIds.has(id)),
              ),
          )
        ) {
          throw new MaterialPreparationError({
            reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
          });
        }
      }
      await this.store.runAtomically(async (store) => {
        await this.requireCurrentJob(store, binding);
        await store.saveMaterialDerivation(
          {
            ...claim,
            state: MaterialDerivationState.COMPLETED,
            result: output,
            usedInput: generated.usedInput,
            usedOutput: generated.usedOutput,
          },
          claim.claimId,
        );
      });
      this.report({
        jobId: binding.jobId,
        kind: input.kind,
        cacheHit: false,
        inputTokens: generated.usedInput ?? inputTokens,
        outputTokens: generated.usedOutput,
      });
      return output;
    } catch (error: unknown) {
      try {
        await this.store.runAtomically(async (store) => {
          await this.requireCurrentJob(store, binding);
          await store.saveMaterialDerivation(
            { ...claim, state: MaterialDerivationState.UNCERTAIN },
            claim.claimId,
          );
        });
      } catch {
        /* Preserve the original diagnostic; a superseded worker cannot alter a newer claim. */
      }
      throw error;
    }
  }

  private async requireCurrentJob(
    store: ClassroomStore,
    binding: { classId: string; jobId: string; collectionVersion: number },
  ) {
    const collection = await store.readMaterialCollection(binding.classId);
    if (
      !collection ||
      collection.jobId !== binding.jobId ||
      collection.version !== binding.collectionVersion ||
      collection.state !== MaterialState.PREPARING ||
      !collection.leaseUntil ||
      Date.parse(collection.leaseUntil) <= Date.now() ||
      !(await store.readClass(binding.classId))
    ) {
      throw new MaterialPreparationError({ reason: MaterialPreparationReason.STALE_STAGE });
    }
    return collection;
  }
}

function validateBriefReferences(brief: DocumentBriefContent, sourceIds: readonly string[]): void {
  const ids = new Set(sourceIds);
  if (
    [brief.purpose, ...brief.setup, ...brief.practice, ...brief.examples].some(
      (note) =>
        (note.origin === MaterialEvidenceOrigin.SOURCE && !note.sourceIds.length) ||
        note.sourceIds.some((id) => !ids.has(id)),
    )
  ) {
    throw new MaterialPreparationError({
      reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
    });
  }
}

/** Previous wording guides a requested revision; only current sources can ground the new draft. */
function buildMaterialRevision(
  input: Parameters<MaterialPreparation['prepare']>[0],
): Extract<MaterialStageInput, { kind: 'composition' }>['revision'] | null {
  if (!input.revisionRequest || !input.previousDraft) {
    return null;
  }
  const materialIds = new Set(input.sources.map((source) => source.id));
  return {
    request: input.revisionRequest,
    previousSummary: input.previousDraft.summary,
    previousSections: input.previousDraft.sections.map(
      ({ title, instruction, practiceCheckpoints }) => ({
        title,
        instruction,
        ...(practiceCheckpoints ? { practiceCheckpoints } : {}),
      }),
    ),
    teacherNotes: input.previousDraft.pages.flatMap((page) =>
      page.teacherNote !== null && materialIds.has(page.materialId)
        ? [{ materialId: page.materialId, location: page.location, text: page.teacherNote }]
        : [],
    ),
  };
}
