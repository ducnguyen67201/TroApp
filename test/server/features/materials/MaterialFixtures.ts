import { randomUUID } from 'node:crypto';
import type { MaterialDraft } from '#contracts/ClassroomMaterials.js';
import type { MaterialPreparation } from '../../../../src/server/features/materials/application/MaterialPreparation.js';

export const fakeMaterialPreparation: MaterialPreparation = {
  available: true,
  prepare(input): Promise<MaterialDraft> {
    return Promise.resolve({
      summary: 'Move and speak. Read the setup first.',
      questions: ['Should the script start with the green flag?'],
      sections: [
        {
          id: randomUUID(),
          title: 'Build and test',
          instruction: 'Connect the movement and speech blocks; confirm how to start.',
          sourcePageIds: input.pages.map((page) => page.id),
        },
      ],
      pages: input.pages.map((page) => ({
        ...page,
        preparedNote: 'Preserved teaching note: ' + page.extractedText,
      })),
    });
  },
};
