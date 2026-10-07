import {
  readMaterialSource,
  searchMaterialSources,
} from '../../materials/application/ReadMaterialSources.js';
import { buildMaterialLessonContext } from '../../materials/application/MaterialLessonContext.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomFailure,
  ClassroomPhase,
  ClassroomStatus,
  ClassroomPacing,
  SubmissionRequirement,
  type ClassroomCommand,
  type ClassroomReply,
  type ClassMeeting,
  type SchoolClass,
  type TeachingContext,
} from '#contracts/Classroom.js';
import {
  ClassroomError,
  canAccessActivity,
  findActivity,
  listActivities,
  requireLiveMeeting,
  validateScratchProjectLink,
} from '../domain/ClassroomRules.js';
import type { ClassroomStore } from './ClassroomStore.js';

/** Authorizes the complete workflow; the model never owns membership or teacher policy. */
export class ClassroomService {
  private readonly listeners = new Set<(classId: string) => void>();
  constructor(
    private readonly store: ClassroomStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(userId: string, command: ClassroomCommand): Promise<ClassroomReply> {
    const reply = await this.store.runAtomically((store) =>
      this.executeInTransaction(store, userId, command),
    );
    if (command.kind === 'update-session' || command.kind === 'end-session') {
      const meeting = await this.store.readMeeting(command.classSessionId);
      if (meeting) {
        this.notifyClass(meeting.classId);
      }
    } else if (command.kind === 'revoke' || command.kind === 'delete-class') {
      this.notifyClass(command.classId);
    }
    return reply;
  }

  /** Process-local wakeups only; authoritative snapshot/heartbeat covers missed events. */
  subscribe(listener: (classId: string) => void): () => void {
    if (this.listeners.size >= 1000) {
      throw new ClassroomError(ClassroomFailure.UNAVAILABLE);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyClass(classId: string): void {
    for (const listener of this.listeners) {
      listener(classId);
    }
  }

  private async executeInTransaction(
    store: ClassroomStore,
    userId: string,
    command: ClassroomCommand,
  ): Promise<ClassroomReply> {
    if (command.kind === 'delete-class') {
      await this.readOwnedClass(store, userId, command.classId);
      if (
        (await store.listMeetings(command.classId)).some(
          (meeting) => meeting.status === ClassroomStatus.LIVE,
        )
      ) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
      await store.revokeInvitations(command.classId);
      await store.deleteClass(command.classId, this.now());
      return { kind: 'ok' };
    }
    if (command.kind === 'create-invitation') {
      await this.readOwnedClass(store, userId, command.classId);
      const code = randomBytes(6).toString('hex').toUpperCase();
      const invitation = {
        id: randomUUID(),
        classId: command.classId,
        code,
        email: command.email?.trim().toLowerCase() ?? null,
        expiresAt: new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await store.saveInvitation({
        id: invitation.id,
        classId: invitation.classId,
        codeDigest: createHash('sha256').update(code).digest('hex'),
        email: invitation.email,
        expiresAt: invitation.expiresAt,
        revoked: false,
      });
      return { kind: 'invitation', invitation };
    }
    if (command.kind === 'revoke-invitations') {
      await this.readOwnedClass(store, userId, command.classId);
      await store.revokeInvitations(command.classId);
      return { kind: 'ok' };
    }
    if (command.kind === 'accept-invitation') {
      const invitation = await store.readInvitation(
        createHash('sha256').update(command.code).digest('hex'),
      );
      const email = await store.readVerifiedEmail(userId);
      if (
        !invitation ||
        invitation.revoked ||
        Date.parse(invitation.expiresAt) <= this.now().getTime() ||
        !email ||
        (invitation.email !== null && invitation.email !== email)
      ) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      const schoolClass = await store.readClass(invitation.classId);
      if (!schoolClass) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      await this.requireTeacher(store, schoolClass.teacherId);
      await store.enrollStudent(invitation.classId, userId, true);
      return { kind: 'ok' };
    }
    if (command.kind === 'home') {
      const classes = await store.listClasses(userId);
      const role = await store.readAccountRole(userId);
      const canTeach = role === AccountRole.TEACHER;
      const referencedCourses = canTeach
        ? (
            await Promise.all(
              classes
                .filter((schoolClass) => schoolClass.teacherId === userId)
                .map((schoolClass) => store.readCourse(schoolClass.courseRevisionId)),
            )
          ).filter((course) => course !== null)
        : [];
      const recentCourses = canTeach ? await store.listCourses(userId) : [];
      const courseList = [
        ...new Map(
          [...referencedCourses, ...recentCourses].map((course) => [course.id, course]),
        ).values(),
      ].slice(0, 100);
      const courses = canTeach
        ? courseList.map((course) => ({
            id: course.id,
            title: course.title,
            activities: listActivities(course.content).map((activity) => ({
              id: activity.id,
              title: activity.title,
            })),
          }))
        : [];
      return {
        kind: 'home',
        home: {
          role,
          courses,
          classes: await Promise.all(
            classes.map(async (schoolClass) => ({
              schoolClass,
              meetings: await store.listMeetings(schoolClass.id),
            })),
          ),
        },
      };
    }
    if (command.kind === 'publish-course') {
      await this.requireTeacher(store, userId);
      await store.saveCourse(userId, command.title, command.content);
      return { kind: 'ok' };
    }
    if (command.kind === 'create-class') {
      await this.requireTeacher(store, userId);
      const course = command.courseRevisionId
        ? await store.readCourse(command.courseRevisionId)
        : await store.saveCourse(userId, command.name, {
            modules: [
              {
                title: command.name,
                lessons: [
                  {
                    title: command.name,
                    activities: [
                      {
                        id: randomUUID(),
                        title: 'Class activity',
                        objective: 'Follow the teacher’s current activity.',
                        instructions:
                          'No reviewed materials are available yet. Ask the teacher what to practice.',
                        prerequisites: [],
                        criteria: [
                          {
                            id: randomUUID(),
                            description: 'Teacher confirms the activity is finished.',
                          },
                        ],
                        materials: [],
                        submission: SubmissionRequirement.NONE,
                      },
                    ],
                  },
                ],
              },
            ],
          });
      if (course?.ownerId !== userId) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      await store.saveClass(userId, command.name, course.id);
      return { kind: 'ok' };
    }
    if (command.kind === 'enroll' || command.kind === 'revoke') {
      await this.readOwnedClass(store, userId, command.classId);
      const studentId =
        command.kind === 'enroll'
          ? await store.readStudentByEmail(command.email.trim().toLowerCase())
          : command.studentId;
      if (!studentId) {
        throw new ClassroomError(ClassroomFailure.NOT_FOUND);
      }
      if (command.kind === 'revoke' && !(await store.isEnrolled(command.classId, studentId))) {
        throw new ClassroomError(ClassroomFailure.NOT_FOUND);
      }
      await store.enrollStudent(command.classId, studentId, command.kind === 'enroll');
      return { kind: 'ok' };
    }
    if (command.kind === 'start-session') {
      const schoolClass = await this.readOwnedClass(store, userId, command.classId);
      const course = await store.readCourse(schoolClass.courseRevisionId);
      if (!course) {
        throw new ClassroomError(ClassroomFailure.NOT_FOUND);
      }
      findActivity(course.content, command.activityId);
      if (
        (await store.listMeetings(schoolClass.id)).some(
          (meeting) => meeting.status === ClassroomStatus.LIVE,
        )
      ) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
      await store.saveMeeting({
        id: randomUUID(),
        classId: schoolClass.id,
        status: ClassroomStatus.LIVE,
        phase: ClassroomPhase.EXPLANATION,
        pacing: command.pacing,
        currentActivityId: command.activityId,
        contextVersion: 1,
      });
      return { kind: 'ok' };
    }
    if (
      command.kind === 'update-session' ||
      command.kind === 'end-session' ||
      command.kind === 'session-roster'
    ) {
      const meeting = await this.readMeeting(store, command.classSessionId);
      const schoolClass = await this.readOwnedClass(store, userId, meeting.classId);
      if (command.kind === 'session-roster') {
        return { kind: 'roster', roster: await store.readRoster(meeting.id, schoolClass.id) };
      }
      requireLiveMeeting(meeting);
      if (command.contextVersion !== meeting.contextVersion) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
      if (command.kind === 'end-session') {
        await store.saveMeeting({
          ...meeting,
          status: ClassroomStatus.ENDED,
          contextVersion: meeting.contextVersion + 1,
        });
      } else {
        const course = await store.readCourse(schoolClass.courseRevisionId);
        if (!course) {
          throw new ClassroomError(ClassroomFailure.NOT_FOUND);
        }
        findActivity(course.content, command.activityId);
        await store.saveMeeting({
          ...meeting,
          phase: command.phase,
          pacing: command.pacing,
          currentActivityId: command.activityId,
          contextVersion: meeting.contextVersion + 1,
        });
      }
      return { kind: 'ok' };
    }
    if (command.kind === 'join') {
      const meeting = await this.readMeeting(store, command.classSessionId);
      requireLiveMeeting(meeting);
      if (!(await store.isEnrolled(meeting.classId, userId))) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      const participation = await store.joinMeeting(
        meeting.id,
        userId,
        command.deviceId,
        new Date(this.now().getTime() + 60_000),
      );
      return {
        kind: 'context',
        context: await this.buildContext(
          store,
          userId,
          participation.id,
          command.deviceId,
          meeting.currentActivityId,
          true,
          command.materialSchemaVersion,
        ),
      };
    }
    if (command.kind === 'leave') {
      const participation = await store.readParticipation(command.participationId);
      if (
        !participation ||
        participation.studentId !== userId ||
        participation.deviceId !== command.deviceId
      ) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      await store.saveParticipation({
        ...participation,
        left: true,
        leaseUntil: this.now().toISOString(),
      });
      return { kind: 'ok' };
    }
    const context = await this.buildContext(
      store,
      userId,
      command.participationId,
      command.deviceId,
      command.activityId,
      command.kind === 'context',
      command.kind === 'context' ? command.materialSchemaVersion : undefined,
      command.kind === 'context' ? (command.question ?? '') : '',
    );
    if (command.kind === 'context') {
      return { kind: 'context', context };
    }
    if (command.kind === 'search-material' || command.kind === 'read-material-source') {
      if (
        context.activity.id !== command.activityId ||
        context.meeting.contextVersion !== command.contextVersion
      ) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
      const publication = await store.readMaterialPublication(context.courseRevisionId);
      if (!publication) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      if (command.kind === 'search-material') {
        if (
          command.documentId &&
          !publication.sources.some((source) => source.id === command.documentId)
        ) {
          throw new ClassroomError(ClassroomFailure.FORBIDDEN);
        }
        return {
          kind: 'material-search',
          result: searchMaterialSources(
            publication,
            context.activity.id,
            command.question,
            command.documentId,
          ),
        };
      }
      const result = readMaterialSource(
        publication,
        command.sourceId,
        command.scope,
        command.offset ?? 0,
      );
      if (!result) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      return { kind: 'material-source', result };
    }
    if (command.kind === 'read-material-notes') {
      const publication = await store.readMaterialPublication(context.courseRevisionId);
      const page = publication?.draft.pages.find((item) => item.id === command.pageId);
      if (!page) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      return { kind: 'material-note', page };
    }
    if (
      context.activity.id !== command.activityId ||
      context.meeting.contextVersion !== command.contextVersion
    ) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
    const attempt = context.attempt;
    if (command.kind === 'submit-work') {
      const receipt = await store.readSubmission(attempt.id, command.idempotencyKey);
      if (receipt) {
        return { kind: 'submitted', receipt };
      }
    }
    if (
      command.kind === 'report-progress' &&
      (await store.hasProgressEvent(attempt.id, command.eventId))
    ) {
      return { kind: 'context', context };
    }
    if (attempt.progressVersion !== command.progressVersion) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
    switch (command.kind) {
      case 'save-workspace': {
        if (
          context.activity.submission === SubmissionRequirement.SCRATCH_LINK &&
          !validateScratchProjectLink(command.url)
        ) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        const updated = {
          ...attempt,
          workspaceUrl: command.url,
          progressVersion: attempt.progressVersion + 1,
        };
        await store.saveAttempt(updated);
        return { kind: 'context', context: { ...context, attempt: updated } };
      }
      case 'report-progress': {
        const criterionIds = new Set(context.activity.criteria.map((criterion) => criterion.id));
        if (
          command.evidence.some((item) => !criterionIds.has(item.criterionId)) ||
          new Set(command.evidence.map((item) => item.criterionId)).size !== command.evidence.length
        ) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        const updated = {
          ...attempt,
          evidence: command.evidence,
          declaredComplete: command.declaredComplete,
          helpSummary: command.helpSummary,
          progressVersion: attempt.progressVersion + 1,
        };
        await store.saveAttempt(updated);
        await store.saveProgressEvent(attempt.id, command.eventId);
        return { kind: 'context', context: { ...context, attempt: updated } };
      }
      case 'prepare-submission': {
        if (
          context.activity.submission !== SubmissionRequirement.SCRATCH_LINK ||
          !attempt.workspaceUrl ||
          !validateScratchProjectLink(attempt.workspaceUrl)
        ) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        const preparation = {
          id: randomUUID(),
          attemptId: attempt.id,
          url: attempt.workspaceUrl,
          progressVersion: attempt.progressVersion,
          contextVersion: context.meeting.contextVersion,
          expiresAt: new Date(this.now().getTime() + 600_000).toISOString(),
        };
        await store.savePreparation(preparation);
        return { kind: 'prepared', preparation };
      }
      case 'submit-work': {
        const preparation = await store.readPreparation(command.preparedSubmissionId);
        if (
          !preparation ||
          preparation.attemptId !== attempt.id ||
          preparation.progressVersion !== attempt.progressVersion ||
          preparation.contextVersion !== context.meeting.contextVersion ||
          preparation.url !== attempt.workspaceUrl ||
          Date.parse(preparation.expiresAt) <= this.now().getTime()
        ) {
          throw new ClassroomError(ClassroomFailure.STALE);
        }
        const receipt = {
          id: randomUUID(),
          attemptId: attempt.id,
          url: preparation.url,
          submittedAt: this.now().toISOString(),
        };
        await store.saveSubmission(receipt, command.idempotencyKey);
        return { kind: 'submitted', receipt };
      }
    }
  }

  private async requireTeacher(store: ClassroomStore, userId: string): Promise<void> {
    if ((await store.readAccountRole(userId)) !== AccountRole.TEACHER) {
      throw new ClassroomError(ClassroomFailure.FORBIDDEN);
    }
  }

  private async readOwnedClass(
    store: ClassroomStore,
    userId: string,
    classId: string,
  ): Promise<SchoolClass> {
    await this.requireTeacher(store, userId);
    const schoolClass = await store.readClass(classId);
    if (!schoolClass || schoolClass.teacherId !== userId) {
      throw new ClassroomError(ClassroomFailure.FORBIDDEN);
    }
    return schoolClass;
  }

  private async readMeeting(store: ClassroomStore, id: string): Promise<ClassMeeting> {
    const meeting = await store.readMeeting(id);
    if (!meeting || !(await store.readClass(meeting.classId))) {
      throw new ClassroomError(ClassroomFailure.NOT_FOUND);
    }
    return meeting;
  }

  private async buildContext(
    store: ClassroomStore,
    userId: string,
    participationId: string,
    deviceId: string,
    requestedActivityId: string,
    renew: boolean,
    materialSchemaVersion?: 2,
    question = '',
  ): Promise<TeachingContext> {
    const participation = await store.readParticipation(participationId);
    if (
      !participation ||
      participation.studentId !== userId ||
      participation.deviceId !== deviceId ||
      participation.left
    ) {
      throw new ClassroomError(ClassroomFailure.FORBIDDEN);
    }
    const meeting = await this.readMeeting(store, participation.classSessionId);
    requireLiveMeeting(meeting);
    if (!(await store.isEnrolled(meeting.classId, userId))) {
      throw new ClassroomError(ClassroomFailure.FORBIDDEN);
    }
    if (!renew && Date.parse(participation.leaseUntil) <= this.now().getTime()) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
    const schoolClass = await store.readClass(meeting.classId);
    const course = schoolClass ? await store.readCourse(schoolClass.courseRevisionId) : null;
    if (!schoolClass || !course) {
      throw new ClassroomError(ClassroomFailure.NOT_FOUND);
    }
    const activityId =
      meeting.pacing === ClassroomPacing.TEACHER ? meeting.currentActivityId : requestedActivityId;
    if (!canAccessActivity(meeting, activityId)) {
      throw new ClassroomError(ClassroomFailure.FORBIDDEN);
    }
    const activity = findActivity(course.content, activityId);
    const currentParticipation = renew
      ? { ...participation, leaseUntil: new Date(this.now().getTime() + 60_000).toISOString() }
      : participation;
    if (renew) {
      await store.saveParticipation(currentParticipation);
    }
    const attempt = await store.readOrCreateAttempt(participation.id, activity.id);
    return {
      ...(await buildMaterialLessonContext(
        store,
        course.id,
        activity.id,
        materialSchemaVersion,
        question,
      )),
      className: schoolClass.name,
      meeting,
      participation: currentParticipation,
      courseRevisionId: course.id,
      activity,
      attempt,
      latestSubmission: await store.readLatestSubmission(attempt.id),
      availableActivities: (meeting.pacing === ClassroomPacing.STUDENT
        ? listActivities(course.content)
        : [activity]
      ).map((item) => ({ id: item.id, title: item.title })),
    };
  }
}
