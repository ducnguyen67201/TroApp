import { AccountRole } from '#contracts/AccountRole.js';
import { LessonLimits, LessonVideoFailure } from '#contracts/LessonVideos.js';
import type { ClassroomStore } from '../../classroom/application/ClassroomStore.js';
import { readPublicationPassages } from '../../materials/application/MaterialSourceSelection.js';
import { LessonVideoError } from '../domain/LessonVideoRules.js';
import type { LessonSources, LessonSource } from '../application/LessonVideoPorts.js';

/** Source reads always follow teacher assignment checks; the model cannot expand their scope. */
export class ClassroomLessonSources implements LessonSources {
  constructor(private readonly store: ClassroomStore) {}
  async canAdminister(actorId: string, classId: string): Promise<boolean> {
    return this.store.canAdministerClass(actorId, classId);
  }

  async authorize(ownerId: string, classId: string): Promise<void> {
    if (!(await this.store.canTeachClass(ownerId, classId))) {
      throw new LessonVideoError(LessonVideoFailure.FORBIDDEN);
    }
  }
  async list(ownerId: string): ReturnType<LessonSources['list']> {
    const classes = [];
    for (const item of await this.store.listClasses(ownerId)) {
      if (await this.store.canTeachClass(ownerId, item.id)) {
        classes.push(item);
      }
    }
    if (
      classes.length === 0 &&
      (await this.store.readAccountRole(ownerId)) !== AccountRole.TEACHER &&
      (await this.store.listTeachingOrganizations(ownerId)).length === 0
    ) {
      throw new LessonVideoError(LessonVideoFailure.FORBIDDEN);
    }
    return Promise.all(
      classes.map(async (item) => {
        const publication = await this.store.readMaterialPublication(item.courseRevisionId);
        return {
          id: item.id,
          name: item.name,
          materials: publication?.sources.map(({ id, name }) => ({ id, name })) ?? [],
        };
      }),
    );
  }
  async read(ownerId: string, classId: string, materialIds: string[]): Promise<LessonSource[]> {
    await this.authorize(ownerId, classId);
    const classroom = await this.store.readClass(classId);
    const publication = classroom
      ? await this.store.readMaterialPublication(classroom.courseRevisionId)
      : null;
    if (
      !publication ||
      materialIds.some((id) => !publication.sources.some((source) => source.id === id))
    ) {
      throw new LessonVideoError(LessonVideoFailure.INVALID);
    }
    const passages = readPublicationPassages(publication).filter((passage) =>
      materialIds.includes(passage.materialId),
    );
    let remaining = LessonLimits.SOURCE_CHARACTERS;
    const sources: LessonSource[] = [];
    for (const passage of passages) {
      const text = passage.text.slice(0, remaining);
      if (text.trim()) {
        sources.push({ id: passage.id, name: passage.location, text });
        remaining -= text.length;
        if (remaining <= 0) {
          break;
        }
      }
    }
    if (!sources.length) {
      throw new LessonVideoError(LessonVideoFailure.INVALID);
    }
    return sources;
  }
}
