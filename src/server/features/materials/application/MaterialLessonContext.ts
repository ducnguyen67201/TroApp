import type { MaterialLessonContext } from '#contracts/ClassroomMaterials.js';
import { MaterialEvidenceOrigin } from '#contracts/MaterialContext.js';
import type { ClassroomStore } from '../../classroom/application/ClassroomStore.js';
import { rankMaterialPassages } from './MaterialSourceSelection.js';
import { materialTokenCounter, selectMaterialPacket } from './MaterialTokenBudget.js';
import { projectLegacyMaterialDraft } from './MaterialCompatibility.js';

/** Choose a bounded view, not the complete publication. More evidence remains behind scoped tools. */
export async function buildMaterialLessonContext(
  store: ClassroomStore,
  courseId: string,
  activityId: string,
  schemaVersion?: 2,
  question = '',
): Promise<{ materialContext?: MaterialLessonContext }> {
  const publication = await store.readMaterialPublication(courseId);
  if (!publication) {
    return {};
  }
  const section = publication.draft.sections.find((item) => item.id === activityId);
  if (schemaVersion === 2 && 'schemaVersion' in publication.draft) {
    const documents = publication.draft.documents;
    const linkedIds = new Set(section?.sourcePageIds ?? []);
    const materialIds = new Set(
      publication.draft.pages
        .filter((page) => linkedIds.has(page.id))
        .map((page) => page.materialId),
    );
    const setup = [
      ...new Map(
        [
          ...(section?.setup ?? []),
          ...documents
            .filter((document) => materialIds.has(document.materialId))
            .flatMap((document) => document.setup),
        ]
          .filter((note) => note.origin === MaterialEvidenceOrigin.SOURCE)
          .map((note) => [JSON.stringify(note), note]),
      ).values(),
    ];
    const ranked = rankMaterialPassages(publication, activityId, question);
    const selection = selectMaterialPacket(
      {
        schemaVersion: 2,
        courseRevisionId: courseId,
        activityId,
        summary: publication.draft.summary,
        teacherInstructions: publication.teacherInstructions,
        setup,
        documentNotes: documents
          .filter(
            (document) => materialIds.has(document.materialId) && document.teacherNote !== null,
          )
          .map((document) => ({
            materialId: document.materialId,
            text: document.teacherNote ?? '',
          })),
        documentIndex: publication.sources.map((source) => ({
          materialId: source.id,
          name: source.name,
          topics: documents.find((document) => document.materialId === source.id)?.topics ?? [],
        })),
      },
      setup.flatMap((note) => note.sourceIds),
      ranked,
    );
    return {
      materialContext: {
        ...selection,
        schemaVersion: 2,
        sources: publication.sources,
        summary: '',
        teacherInstructions: '',
        pages: [],
        pageIndex: [],
      },
    };
  }
  const draft = projectLegacyMaterialDraft(publication.draft);
  const ordered = [
    ...draft.pages.filter((page) => section?.sourcePageIds.includes(page.id)),
    ...draft.pages.filter((page) => !section?.sourcePageIds.includes(page.id)),
  ];
  const context = {
    summary: draft.summary,
    teacherInstructions: publication.teacherInstructions,
    pages: [] as typeof draft.pages,
    pageIndex: draft.pages.map(({ id, materialId, location }) => ({ id, materialId, location })),
    sources: publication.sources,
  };
  if (materialTokenCounter.countText(JSON.stringify(context)) > 8000) {
    throw new Error(
      'Legacy material context exceeds its token budget. Re-prepare and review the lesson.',
    );
  }
  for (const page of ordered) {
    if (
      materialTokenCounter.countText(
        JSON.stringify({ ...context, pages: [...context.pages, page] }),
      ) <= 8000
    ) {
      context.pages.push(page);
    }
  }
  return { materialContext: context };
}
