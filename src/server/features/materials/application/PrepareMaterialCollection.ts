import { createHash, randomUUID } from 'node:crypto';
import {
  MaterialDraftV2Schema,
  MaterialState,
  MaterialPreparationPhase,
  type MaterialDraftV2,
} from '#contracts/ClassroomMaterials.js';
import {
  MaterialDerivationState,
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
  readMaterialStageOutputTokens,
} from './MaterialGeneration.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
  type MaterialReferenceIssue,
} from './MaterialPreparationError.js';
import { buildMaterialPassages } from './MaterialSourceSelection.js';
import { materialTokenCounter } from './MaterialTokenBudget.js';
import {
  validateBriefReferences,
  validateCompositionReferences,
} from './MaterialReferenceValidation.js';
import {
  MaterialCitationRejection,
  buildMaterialCitationRepair,
  validateMaterialCitationRepair,
} from './MaterialCitationRepair.js';

interface MaterialJobBinding {
  classId: string;
  jobId: string;
  collectionVersion: number;
  extractionVersion: string | null;
}

/** One teacher job, bounded durable stages. Existing publications never depend on this mutable cache. */
export class PrepareMaterialCollection implements MaterialPreparation {
  readonly available: boolean;
  constructor(
    private readonly store: ClassroomStore,
    private readonly generation: MaterialGeneration,
    private readonly policy: MaterialGenerationPolicy = defaultMaterialGenerationPolicy,
    private readonly report: (event: {
      jobId: string;
      classId: string;
      stageKey: string;
      collectionVersion: number;
      kind: string;
      cacheHit: boolean;
      inputTokens: number;
      outputTokens: number | null;
      citationRepair?: boolean;
      rejected?: boolean;
      referenceIssueCount?: number;
      referenceIssues?: MaterialReferenceIssue[];
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
          part.map((passage) => passage.sourceUnitId),
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
          documentPassages.map((passage) => passage.sourceUnitId),
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
            preparationProgress: {
              completed: documents.length,
              total: input.sources.length + 1,
              phase: MaterialPreparationPhase.PREPARING,
            },
          },
          current.version,
        );
      });
    }
    const revision = buildMaterialRevision(input);
    const citedPassageIds = new Set(
      documents.flatMap((document) =>
        [document.purpose, ...document.setup, ...document.practice, ...document.examples].flatMap(
          (note) => note.sourceIds,
        ),
      ),
    );
    const result = await this.composeWithCitationRepair(
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
        sourceMap: passages
          .filter((passage) => citedPassageIds.has(passage.id))
          .map((passage) => ({
            passageId: passage.id,
            pageId: passage.sourceUnitId,
            materialId: passage.materialId,
          })),
      },
      passages,
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

  private async composeWithCitationRepair(
    binding: MaterialJobBinding,
    input: Extract<MaterialStageInput, { kind: 'composition' }>,
    passages: MaterialSourcePassage[],
    signal: AbortSignal,
  ): Promise<MaterialGenerationOutput> {
    try {
      return await this.runStage(binding, input, signal);
    } catch (error: unknown) {
      if (!(error instanceof MaterialCitationRejection)) {
        throw error;
      }
      signal.throwIfAborted();
      await this.savePreparationPhase(binding, MaterialPreparationPhase.CORRECTING_REFERENCES);
      // Separate stage key/claim and normal budget admission; there is no recursive repair loop.
      return this.runStage(binding, buildMaterialCitationRepair(input, error, passages), signal);
    }
  }

  private async savePreparationPhase(
    binding: MaterialJobBinding,
    phase: (typeof MaterialPreparationPhase)[keyof typeof MaterialPreparationPhase],
  ): Promise<void> {
    await this.store.runAtomically(async (store) => {
      const current = await this.requireCurrentJob(store, binding);
      await store.saveMaterialCollection(
        {
          ...current,
          preparationProgress: {
            completed: current.sources.length,
            total: current.sources.length + 1,
            phase,
          },
        },
        current.version,
      );
    });
  }

  private async runStage(
    binding: MaterialJobBinding,
    input: MaterialStageInput,
    signal: AbortSignal,
  ): Promise<MaterialGenerationOutput> {
    signal.throwIfAborted();
    const outputTokens = readMaterialStageOutputTokens(this.policy, input.kind);
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
          outputTokens,
          input: reference,
        }),
      )
      .digest('hex');
    const cached = await this.store.readMaterialDerivation(binding.classId, key);
    if (cached?.state === MaterialDerivationState.COMPLETED && cached.result) {
      await this.requireCurrentJob(this.store, binding);
      this.report({
        ...binding,
        stageKey: key,
        kind: input.kind,
        cacheHit: true,
        inputTokens: 0,
        outputTokens: 0,
      });
      return cached.result;
    }
    const context = {
      classId: binding.classId,
      jobId: binding.jobId,
      collectionVersion: binding.collectionVersion,
      stageKey: key,
    };
    const inputTokens = await this.generation.countInput(input, signal, context);
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
        stages.reduce((sum, stage) => sum + stage.reservedOutput, 0) + outputTokens >
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
        reservedOutput: outputTokens,
        usedInput: null,
        usedOutput: null,
        result: null,
      };
      await store.saveMaterialDerivation(record, current?.claimId ?? null);
      return record;
    });
    let generatedOutput: MaterialGenerationOutput | undefined;
    let usedInput: number | null = null;
    let usedOutput: number | null = null;
    try {
      const generated = await this.generation.generate(input, signal, context);
      usedInput = generated.usedInput;
      usedOutput = generated.usedOutput;
      const output = MaterialGenerationOutputSchema.parse(generated.output);
      generatedOutput = output;
      if (output.kind !== input.kind) {
        throw new MaterialPreparationError({ reason: MaterialPreparationReason.INVALID_DRAFT });
      }
      if (output.kind === 'brief' && input.kind === 'brief') {
        validateBriefReferences(
          output.brief,
          [
            ...input.passages.map((passage) => passage.id),
            ...input.summaries.flatMap((summary) =>
              [summary.purpose, ...summary.setup, ...summary.practice, ...summary.examples].flatMap(
                (note) => note.sourceIds,
              ),
            ),
          ],
          input.passages.map((passage) => passage.sourceUnitId),
        );
      }
      if (output.kind === 'composition' && input.kind === 'composition') {
        await this.savePreparationPhase(binding, MaterialPreparationPhase.CHECKING_REFERENCES);
        validateCompositionReferences(output.composition, input);
        if (input.citationRepair) {
          validateMaterialCitationRepair(
            input.citationRepair.previousComposition,
            output.composition,
          );
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
        ...binding,
        stageKey: key,
        kind: input.kind,
        cacheHit: false,
        inputTokens: generated.usedInput ?? inputTokens,
        outputTokens: generated.usedOutput,
        ...(input.kind === 'composition' ? { citationRepair: Boolean(input.citationRepair) } : {}),
      });
      return output;
    } catch (error: unknown) {
      const rejected =
        generatedOutput !== undefined &&
        error instanceof MaterialPreparationError &&
        (error.diagnostic.reason === MaterialPreparationReason.INVALID_SOURCE_REFERENCES ||
          error.diagnostic.reason === MaterialPreparationReason.CITATION_REPAIR_CHANGED_CONTENT);
      let savedRejection = false;
      try {
        await this.store.runAtomically(async (store) => {
          await this.requireCurrentJob(store, binding);
          await store.saveMaterialDerivation(
            {
              ...claim,
              state: rejected
                ? MaterialDerivationState.REJECTED
                : MaterialDerivationState.UNCERTAIN,
              usedInput,
              usedOutput,
            },
            claim.claimId,
          );
        });
        savedRejection = rejected;
      } catch {
        /* Preserve the original diagnostic; a superseded worker cannot alter a newer claim. */
      }
      if (error instanceof MaterialPreparationError) {
        const diagnostic = {
          ...error.diagnostic,
          stageKey: key,
          generationStage: input.kind,
          ...(input.kind === 'brief' ? { materialId: input.materialId } : {}),
          ...(input.kind === 'composition'
            ? { citationRepair: Boolean(input.citationRepair) }
            : {}),
          ...(usedInput !== null ? { usedInputTokens: usedInput } : {}),
          ...(usedOutput !== null ? { usedOutputTokens: usedOutput } : {}),
        };
        if (rejected) {
          this.report({
            ...context,
            kind: input.kind,
            cacheHit: false,
            inputTokens: usedInput ?? inputTokens,
            outputTokens: usedOutput,
            rejected: true,
            ...(diagnostic.referenceIssueCount !== undefined
              ? { referenceIssueCount: diagnostic.referenceIssueCount }
              : {}),
            ...(diagnostic.referenceIssues ? { referenceIssues: diagnostic.referenceIssues } : {}),
            ...(input.kind === 'composition'
              ? { citationRepair: Boolean(input.citationRepair) }
              : {}),
          });
        }
        if (
          savedRejection &&
          error.diagnostic.reason === MaterialPreparationReason.INVALID_SOURCE_REFERENCES &&
          input.kind === 'composition' &&
          generatedOutput?.kind === 'composition' &&
          !input.citationRepair
        ) {
          throw new MaterialCitationRejection(diagnostic, generatedOutput.composition);
        }
        throw new MaterialPreparationError(diagnostic);
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
