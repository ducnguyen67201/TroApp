import { randomUUID } from 'node:crypto';
import { LessonStatus } from '#contracts/GuidedLessons.js';
import type { LessonRecord } from '../../../../src/server/features/guidedLessons/application/LessonState.js';
import { createLessonFixture } from './LessonFixture.js';

export function createStoredLesson(): LessonRecord {
  const fixture = createLessonFixture();
  return {
    id: randomUUID(),
    classId: fixture.input.classId,
    teacherId: 'teacher',
    version: 1,
    revisionId: fixture.record.revisionId,
    title: fixture.plan.title,
    language: 'en',
    status: LessonStatus.RELEASED,
    updatedAt: '2026-10-09T12:00:00.000Z',
    input: fixture.input,
    plan: fixture.plan,
    contentHash: fixture.record.contentHash,
    review: null,
    visualReview: null,
    manifest: fixture.record.manifest,
    adjustments: null,
    speech: fixture.record.manifest?.speechArtifacts ?? [],
    scriptApproved: true,
    previewApproved: true,
    scriptApproval: null,
    previewApproval: null,
    releaseId: 'release-1',
    error: null,
    run: null,
  };
}
