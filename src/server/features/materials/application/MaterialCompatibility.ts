import type {
  MaterialReply,
  MaterialDraft,
  MaterialCollection,
} from '#contracts/ClassroomMaterials.js';

/** Legacy projection is read-only: a V1 client cannot save and discard V2 fields. */
export function projectLegacyMaterialDraft(draft: MaterialDraft): MaterialDraft {
  if (!('schemaVersion' in draft)) {
    return draft;
  }
  return {
    summary: draft.summary,
    questions: draft.questions,
    sections: draft.sections.map(({ id, title, instruction, sourcePageIds }) => ({
      id,
      title,
      instruction,
      sourcePageIds,
    })),
    pages: draft.pages.map((page) => {
      const document = draft.documents.find((item) => item.materialId === page.materialId);
      const first = draft.pages.find((item) => item.materialId === page.materialId)?.id === page.id;
      return {
        ...page,
        preparedNote: first && document ? (document.teacherNote ?? document.purpose.text) : '',
      };
    }),
  };
}

export function projectMaterialReply(
  reply: MaterialReply,
  schemaVersion: 2 | undefined,
): MaterialReply {
  if (schemaVersion === 2 || reply.kind !== 'collection') {
    return reply;
  }
  const fields = { ...reply.collection };
  delete fields.preparationProgress;
  const collection: MaterialCollection = {
    ...fields,
    draft: fields.draft ? projectLegacyMaterialDraft(fields.draft) : null,
  };
  return { kind: 'collection', collection };
}
