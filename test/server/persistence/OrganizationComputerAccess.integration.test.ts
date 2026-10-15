import { createHash, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createApi } from '../../../src/server/CreateApi.js';
import { createPrismaStudentAccessStore } from '../../../src/server/persistence/PrismaStudentAccessStore.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { registerStudentAccessRoutes } from '../../../src/server/features/studentAccess/infrastructure/RegisterStudentAccessRoutes.js';
import { registerClassroomRoutes } from '../../../src/server/features/classroom/infrastructure/RegisterClassroomRoutes.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';
import {
  CompanyComputerCapability,
  StudentAccessKind,
  OrganizationComputerLimits,
  StudentAccessPath,
  StudentAccessReplySchema,
  StudentDeviceCredentialSchema,
  StudentEnrollmentReplySchema,
  StudentSessionCookie,
  type StudentAccessCommand,
} from '#contracts/StudentAccess.js';
import {
  ClassroomOrganizationCapability,
  ClassroomPacing,
  ClassroomReplySchema,
} from '#contracts/Classroom.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { StudentDeviceMode, StudentQrLimits } from '#contracts/StudentIdentity.js';

const environment = readServerEnv(process.env);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
const access = createPrismaStudentAccessStore(environment.DATABASE_URL);
const classrooms = createPrismaClassroomStore(environment.DATABASE_URL);
afterAll(async () => {
  await Promise.all([client.$disconnect(), access.close(), classrooms.close()]);
});

async function fixture() {
  const ownerId = randomUUID();
  const teacherId = randomUUID();
  const outsiderId = randomUUID();
  const adminId = randomUUID();
  const organizationId = randomUUID();
  await client.user.createMany({
    data: [ownerId, teacherId, outsiderId, adminId].map((id) => ({
      id,
      name: 'Synthetic staff',
      email: `${id}@example.test`,
      emailVerified: true,
      role: AccountRole.TEACHER,
      isAdmin: id === adminId,
    })),
  });
  await client.organization.create({
    data: {
      id: organizationId,
      name: 'Computer access fixture',
      ownerUserId: ownerId,
      nameSetAt: new Date(),
      memberships: {
        create: [ownerId, teacherId].map((userId) => ({ userId, role: AccountRole.TEACHER })),
      },
    },
  });
  const course = await classrooms.store.saveCourse(
    teacherId,
    'QR course',
    createCourseContent(),
    organizationId,
  );
  const schoolClass = await classrooms.store.saveClass(
    teacherId,
    'QR class',
    course.id,
    organizationId,
  );
  const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
  const staff = new Map([
    ['owner', ownerId],
    ['teacher', teacherId],
    ['outside', outsiderId],
    ['admin', adminId],
  ]);
  const routes = registerStudentAccessRoutes(
    api,
    access.store,
    (headers) => Promise.resolve(staff.get(headers.cookie ?? '') ?? null),
    environment.AUTH_SECRET,
  );
  const classroom = new ClassroomService(classrooms.store);
  registerClassroomRoutes(api, routes.readUserId, classroom, { warn() {}, error() {} });
  api.post('/api/v1/organizations/command', () => ({ kind: 'ok' }));

  const command = (payload: StudentAccessCommand, device?: string, actor?: string) =>
    api.inject({
      method: 'POST',
      url: `${StudentAccessPath}/command`,
      headers: {
        origin: 'app.tro.desktop:/',
        ...(device ? { 'x-tro-student-device': device } : {}),
        ...(actor ? { cookie: actor } : {}),
      },
      payload,
    });

  async function createCode(actor = 'owner') {
    const response = await command(
      { kind: StudentAccessKind.CREATE_COMPUTER_CODE, organizationId },
      undefined,
      actor,
    );
    const reply = StudentAccessReplySchema.parse(response.json());
    if (reply.kind !== 'admission') {
      throw new Error('Expected a computer activation code.');
    }
    return reply.code;
  }

  async function activate(existingCode?: string) {
    const code = existingCode ?? (await createCode());
    const requestId = randomUUID();
    const response = await command({ kind: StudentAccessKind.ACTIVATE, code, requestId });
    return { ...StudentDeviceCredentialSchema.parse(response.json()), code, requestId };
  }

  async function signIn(
    device: string,
    externalId = '001Ab',
    name = 'Minh',
    requestId = randomUUID(),
  ) {
    const response = await command(
      { kind: StudentAccessKind.ENROLL, externalId, name, requestId },
      device,
    );
    expect(response.statusCode).toBe(200);
    return StudentEnrollmentReplySchema.parse(response.json());
  }

  async function usage() {
    const reply = StudentAccessReplySchema.parse(
      (
        await command(
          { kind: StudentAccessKind.ORGANIZATION_ACCESS, organizationId },
          undefined,
          'owner',
        )
      ).json(),
    );
    if (reply.kind !== StudentAccessKind.ORGANIZATION_ACCESS) {
      throw new Error('Expected computer usage.');
    }
    return reply;
  }

  const enrollInClass = (classId: string, externalId: string, actor: string) =>
    api.inject({
      method: 'POST',
      url: '/api/v1/classroom/command',
      headers: { cookie: actor },
      payload: { kind: 'enroll-qr-student', classId, externalId },
    });
  const session = (credential: string) =>
    api.inject({
      url: `${StudentAccessPath}/session`,
      headers: { cookie: `${StudentSessionCookie}=${credential}` },
    });
  const home = async (credential: string) =>
    ClassroomReplySchema.parse(
      (
        await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers: { cookie: `${StudentSessionCookie}=${credential}` },
          payload: { kind: 'home' },
        })
      ).json(),
    );
  return {
    api,
    routes,
    classroom,
    ownerId,
    teacherId,
    outsiderId,
    adminId,
    organizationId,
    schoolClass,
    course,
    command,
    createCode,
    activate,
    signIn,
    usage,
    session,
    home,
    enrollInClass,
  };
}

describe('organization computer activation and QR login', () => {
  it('limits administration, reuses organization codes and generates distinct names across activation retries', async () => {
    const f = await fixture();
    try {
      for (const actor of ['teacher', 'outside']) {
        expect(
          (
            await f.command(
              {
                kind: StudentAccessKind.CREATE_COMPUTER_CODE,
                organizationId: f.organizationId,
              },
              undefined,
              actor,
            )
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await f.command(
              { kind: StudentAccessKind.ORGANIZATION_ACCESS, organizationId: f.organizationId },
              undefined,
              actor,
            )
          ).statusCode,
        ).toBe(403);
      }
      expect(await f.createCode('admin')).toMatch(/^TRO-[A-Z2-7]{16}$/);
      const device = await f.activate();
      expect(device.context).toMatchObject({
        organizationId: f.organizationId,
        classId: null,
        className: null,
        mode: 'shared',
      });
      const replay = StudentDeviceCredentialSchema.parse(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: device.code,
            requestId: device.requestId,
          })
        ).json(),
      );
      expect(replay.credential).toBe(device.credential);
      const second = await f.activate(device.code);
      expect(second.credential).not.toBe(device.credential);
      expect(
        (
          await f.api.inject({
            method: 'POST',
            url: `${StudentAccessPath}/command`,
            headers: { origin: 'https://outside.test' },
            payload: {
              kind: StudentAccessKind.ACTIVATE,
              code: device.code,
              requestId: randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.api.inject({
            method: 'POST',
            url: `${StudentAccessPath}/command`,
            headers: { origin: 'app.tro.desktop:/' },
            payload: {
              kind: StudentAccessKind.ACTIVATE,
              code: '123456ABCDEF',
              requestId: randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(await f.usage()).toMatchObject({
        authorizedComputers: 2,
        registeredStudents: 0,
        totalSignIns: 0,
      });
      const code = await f.createCode();
      const redemptions = await Promise.all(
        [randomUUID(), randomUUID()].map((requestId) =>
          f.command({ kind: StudentAccessKind.ACTIVATE, code, requestId }),
        ),
      );
      expect(redemptions.map((response) => response.statusCode).sort()).toEqual([200, 200]);
      const usage = await f.usage();
      expect(usage.authorizedComputers).toBe(4);
      expect(usage.computers.map((computer) => computer.name).sort()).toEqual([
        'Computer 1',
        'Computer 2',
        'Computer 3',
        'Computer 4',
      ]);
      expect(usage.activationCodes.map((code) => code.activations).sort()).toEqual([0, 2, 2]);
      const readTeacherHome = (companySupport: boolean) =>
        f.api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers: {
            cookie: 'teacher',
            [ClassroomOrganizationCapability.HEADER]: ClassroomOrganizationCapability.VERSION,
            ...(companySupport
              ? { [CompanyComputerCapability.HEADER]: CompanyComputerCapability.VERSION }
              : {}),
          },
          payload: { kind: 'home' },
        });
      const legacyHome = ClassroomReplySchema.parse((await readTeacherHome(false)).json());
      const currentHome = ClassroomReplySchema.parse((await readTeacherHome(true)).json());
      expect(legacyHome.kind === 'home' ? legacyHome.home.classes[0] : null).not.toHaveProperty(
        'organizationId',
      );
      expect(currentHome.kind === 'home' ? currentHome.home.classes[0] : null).toHaveProperty(
        'organizationId',
        f.organizationId,
      );
    } finally {
      await f.api.close();
    }
  });

  it('recovers one organization account across computers and distinguishes people from sign-ins', async () => {
    const f = await fixture();
    try {
      const firstDevice = await f.activate();
      const secondDevice = await f.activate(firstDevice.code);
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.ENROLL,
              externalId: '001Ab',
              name: '',
              requestId: randomUUID(),
            },
            firstDevice.credential,
          )
        ).statusCode,
      ).toBe(403);
      expect((await f.usage()).registeredStudents).toBe(0);
      const requestId = randomUUID();
      const first = await f.signIn(firstDevice.credential, '001Ab', 'Minh', requestId);
      const retry = await f.signIn(firstDevice.credential, '001Ab', 'Minh', requestId);
      expect(retry.user.id).toBe(first.user.id);
      expect((await f.session(first.credential)).statusCode).toBe(401);
      expect(await f.usage()).toMatchObject({
        registeredStudents: 1,
        studentsToday: 1,
        signInsToday: 1,
        totalSignIns: 1,
      });
      await access.store.revokeSession(createHash('sha256').update(retry.credential).digest('hex'));
      const returning = await f.signIn(secondDevice.credential, '001Ab', 'Different name');
      expect(returning.user).toMatchObject({
        id: first.user.id,
        name: 'Minh',
        learner: { organizationId: f.organizationId, classId: null },
      });
      const other = await f.signIn(firstDevice.credential, '002', 'Lan');
      expect(other.user.id).not.toBe(first.user.id);
      expect(await f.usage()).toMatchObject({
        authorizedComputers: 2,
        registeredStudents: 2,
        studentsToday: 2,
        signInsToday: 3,
        totalSignIns: 3,
      });
      await client.studentLearnerSession.updateMany({
        where: { userId: first.user.id },
        data: { expiresAt: new Date(0) },
      });
      expect((await f.signIn(firstDevice.credential, '001Ab', '')).user.id).toBe(first.user.id);
      const membership = await client.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId: f.organizationId, userId: first.user.id },
        },
      });
      expect(membership.role).toBe('student');
      expect((await f.usage()).registeredStudents).toBe(2);
    } finally {
      await f.api.close();
    }
  });

  it('keeps concurrent first scans on one identity and preserves distinct exact IDs', async () => {
    const f = await fixture();
    try {
      const one = await f.activate();
      const two = await f.activate(one.code);
      const results = await Promise.all([f.signIn(one.credential), f.signIn(two.credential)]);
      expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
      await f.signIn(one.credential, '001ab');
      await f.signIn(two.credential, '1Ab');
      expect(await f.usage()).toMatchObject({
        registeredStudents: 3,
        studentsToday: 3,
        totalSignIns: 4,
      });
    } finally {
      await f.api.close();
    }
  });

  it('requires explicit class enrollment while retaining identity across classes and lesson endings', async () => {
    const f = await fixture();
    const other = await fixture();
    try {
      const device = await f.activate();
      const student = await f.signIn(device.credential);
      const emptyHome = await f.home(student.credential);
      expect(emptyHome.kind === 'home' ? emptyHome.home.classes : null).toEqual([]);
      expect((await f.enrollInClass(f.schoolClass.id, '001Ab', 'outside')).statusCode).toBe(403);
      expect((await f.enrollInClass(other.schoolClass.id, '001Ab', 'teacher')).statusCode).toBe(
        403,
      );
      expect((await f.enrollInClass(f.schoolClass.id, '001Ab', 'teacher')).statusCode).toBe(200);
      const anotherClass = await classrooms.store.saveClass(
        f.teacherId,
        'Second class',
        f.course.id,
        f.organizationId,
      );
      expect((await f.enrollInClass(anotherClass.id, '001Ab', 'teacher')).statusCode).toBe(200);
      const home = await f.home(student.credential);
      expect(
        home.kind === 'home' ? home.home.classes.map((entry) => entry.schoolClass.id).sort() : null,
      ).toEqual([f.schoolClass.id, anotherClass.id].sort());
      const activity = f.course.content.modules[0]?.lessons[0]?.activities[0];
      if (!activity) {
        throw new Error('Missing activity fixture.');
      }
      await f.classroom.execute(f.teacherId, {
        kind: 'start-session',
        classId: f.schoolClass.id,
        activityId: activity.id,
        pacing: ClassroomPacing.TEACHER,
      });
      const meeting = await client.classroomMeeting.findFirstOrThrow({
        where: { classId: f.schoolClass.id },
      });
      const principal = await f.routes.service.readPrincipal({
        cookie: `${StudentSessionCookie}=${student.credential}`,
      });
      if (!principal) {
        throw new Error('Missing learner session.');
      }
      expect(
        await access.store.canAccessClassroom(principal, {
          kind: 'join',
          classSessionId: meeting.id,
          deviceId: randomUUID(),
        }),
      ).toBe(true);
      await client.classroomMeeting.update({
        where: { id: meeting.id },
        data: { status: 'ended' },
      });
      expect((await f.session(student.credential)).statusCode).toBe(200);
      await classrooms.store.enrollStudent(f.schoolClass.id, student.user.id, false);
      expect(
        await access.store.canAccessClassroom(principal, {
          kind: 'join',
          classSessionId: meeting.id,
          deviceId: randomUUID(),
        }),
      ).toBe(false);
      expect((await f.session(student.credential)).statusCode).toBe(200);
      expect(
        (
          await f.api.inject({
            method: 'POST',
            url: '/api/v1/organizations/command',
            headers: { cookie: `${StudentSessionCookie}=${student.credential}` },
            payload: { kind: 'home' },
          })
        ).statusCode,
      ).toBe(403);
      const otherDevice = await other.activate();
      const otherStudent = await other.signIn(otherDevice.credential);
      expect(otherStudent.user.id).not.toBe(student.user.id);
      const foreignMeeting = await client.classroomMeeting.create({
        data: {
          id: randomUUID(),
          classId: other.schoolClass.id,
          status: 'live',
          phase: 'practice',
          pacing: 'teacher',
          currentActivityId: activity.id,
        },
      });
      await client.organizationMembership.create({
        data: { organizationId: other.organizationId, userId: student.user.id, role: 'student' },
      });
      await client.classroomEnrollment.create({
        data: { classId: other.schoolClass.id, studentId: student.user.id },
      });
      expect(await classrooms.store.isEnrolled(other.schoolClass.id, student.user.id)).toBe(false);
      const scopedHome = await f.home(student.credential);
      expect(
        scopedHome.kind === 'home'
          ? scopedHome.home.classes.map((entry) => entry.schoolClass.id)
          : [],
      ).not.toContain(other.schoolClass.id);
      expect(
        await access.store.canAccessClassroom(principal, {
          kind: 'join',
          classSessionId: foreignMeeting.id,
          deviceId: randomUUID(),
        }),
      ).toBe(false);
      expect((await f.signIn(device.credential, '001Ab', '')).user.id).toBe(student.user.id);
    } finally {
      await Promise.all([f.api.close(), other.api.close()]);
    }
  });

  it('reuses accounts for opaque QR text, including URLs and multiline values, and enrolls those identities in classes', async () => {
    const f = await fixture();
    try {
      const one = await f.activate();
      const two = await f.activate(one.code);
      const values = [
        'https://school.example.test/card?token=001Ab',
        'BEGIN:VCARD\nFN:Minh\nEND:VCARD',
        '{"role":"admin"}',
        '学'.repeat(StudentQrLimits.TEXT_CHARACTERS),
      ];
      for (const value of values) {
        const first = await f.signIn(one.credential, value);
        const returning = await f.signIn(two.credential, value, '');
        expect(returning.user.id).toBe(first.user.id);
        expect(returning.user.learner?.externalId).toBe(value);
        expect(returning.user.isAdmin).toBe(false);
        expect((await f.enrollInClass(f.schoolClass.id, value, 'teacher')).statusCode).toBe(200);
        expect(await classrooms.store.isEnrolled(f.schoolClass.id, first.user.id)).toBe(true);
      }
      expect(await f.usage()).toMatchObject({
        registeredStudents: values.length,
        totalSignIns: values.length * 2,
      });
    } finally {
      await f.api.close();
    }
  });

  it('authorizes a personal computer for the same QR identity while preserving its distinct session policy', async () => {
    const f = await fixture();
    try {
      const company = await f.activate();
      const requestId = randomUUID();
      const response = await f.command({
        kind: StudentAccessKind.ACTIVATE,
        code: company.code,
        requestId,
        mode: StudentDeviceMode.PERSONAL,
      });
      const personal = StudentDeviceCredentialSchema.parse(response.json());
      expect(personal.context).toMatchObject({
        organizationId: f.organizationId,
        classId: null,
        mode: StudentDeviceMode.PERSONAL,
      });
      const first = await f.signIn(company.credential);
      const returning = await f.signIn(personal.credential, '001Ab', '');
      expect(returning.user.id).toBe(first.user.id);
      expect(returning.user.learner?.mode).toBe(StudentDeviceMode.PERSONAL);
      expect(Date.parse(returning.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
      const retry = StudentDeviceCredentialSchema.parse(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: company.code,
            requestId,
            mode: StudentDeviceMode.PERSONAL,
          })
        ).json(),
      );
      expect(retry.credential).toBe(personal.credential);
      expect(
        (await f.command({ kind: StudentAccessKind.ACTIVATE, code: company.code, requestId }))
          .statusCode,
      ).toBe(403);
      expect(await f.usage()).toMatchObject({
        authorizedComputers: 2,
        registeredStudents: 1,
        totalSignIns: 2,
      });
      const device = await client.studentDevice.findUniqueOrThrow({
        where: { credentialDigest: createHash('sha256').update(personal.credential).digest('hex') },
      });
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.REVOKE_COMPUTER,
              organizationId: f.organizationId,
              deviceId: device.id,
            },
            undefined,
            'owner',
          )
        ).statusCode,
      ).toBe(200);
      expect((await f.session(returning.credential)).statusCode).toBe(401);
      expect((await f.session(first.credential)).statusCode).toBe(200);
    } finally {
      await f.api.close();
    }
  });

  it('stops new activations when a used code is revoked or expires while keeping existing computers working', async () => {
    const f = await fixture();
    try {
      const one = await f.activate();
      const two = await f.activate(one.code);
      const student = await f.signIn(one.credential);
      const admission = await client.studentAdmission.findUniqueOrThrow({
        where: { codeDigest: createHash('sha256').update(one.code).digest('hex') },
      });
      expect(admission.uses).toBe(2);
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.REVOKE_COMPUTER_CODE,
              organizationId: f.organizationId,
              admissionId: admission.id,
            },
            undefined,
            'outside',
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.REVOKE_COMPUTER_CODE,
              organizationId: f.organizationId,
              admissionId: admission.id,
            },
            undefined,
            'owner',
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: one.code,
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(403);
      expect((await f.session(student.credential)).statusCode).toBe(200);
      const returning = await f.signIn(two.credential, '001Ab', '');
      expect(returning.user.id).toBe(student.user.id);
      const replay = StudentDeviceCredentialSchema.parse(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: one.code,
            requestId: one.requestId,
          })
        ).json(),
      );
      expect(replay.credential).toBe(one.credential);
      expect(await f.usage()).toMatchObject({
        authorizedComputers: 2,
        activationCodes: [],
        registeredStudents: 1,
      });
      const three = await f.activate();
      await client.studentAdmission.update({
        where: { codeDigest: createHash('sha256').update(three.code).digest('hex') },
        data: { expiresAt: new Date(0) },
      });
      expect(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: three.code,
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await f.command({ kind: StudentAccessKind.STATUS }, three.credential)).json(),
      ).toMatchObject({ kind: 'ready' });
      expect((await f.signIn(three.credential, '001Ab', '')).user.id).toBe(student.user.id);
      expect((await f.usage()).authorizedComputers).toBe(3);
    } finally {
      await f.api.close();
    }
  });

  it('preserves existing named installations and lets their already-used organization code activate another computer', async () => {
    const f = await fixture();
    try {
      const one = await f.activate();
      const digest = createHash('sha256').update(one.code).digest('hex');
      const admission = await client.studentAdmission.update({
        where: { codeDigest: digest },
        data: { computerName: 'Old computer label' },
      });
      await client.studentDevice.updateMany({
        where: { admissionId: admission.id },
        data: { computerName: 'Computer 2' },
      });
      const two = await f.activate(one.code);
      const otherCode = await f.createCode();
      await f.activate(otherCode);
      expect((await f.usage()).computers.map((computer) => computer.name).sort()).toEqual([
        'Computer 2',
        'Computer 3',
        'Computer 4',
      ]);
      expect(two.credential).not.toBe(one.credential);
      expect(
        await client.studentAdmission.findUniqueOrThrow({ where: { id: admission.id } }),
      ).toMatchObject({
        computerName: 'Old computer label',
        uses: 2,
      });
    } finally {
      await f.api.close();
    }
  });

  it('enforces organization computer capacity when a reusable code is redeemed concurrently', async () => {
    const f = await fixture();
    try {
      const code = await f.createCode();
      const admission = await client.studentAdmission.findUniqueOrThrow({
        where: { codeDigest: createHash('sha256').update(code).digest('hex') },
      });
      await client.studentDevice.createMany({
        data: Array.from({ length: OrganizationComputerLimits.COMPUTERS - 1 }, (_, index) => ({
          id: randomUUID(),
          organizationId: f.organizationId,
          schoolId: f.organizationId,
          admissionId: admission.id,
          requestId: randomUUID(),
          credentialDigest: createHash('sha256').update(randomUUID()).digest('hex'),
          mode: 'shared',
          computerName: `Computer ${String(index + 1)}`,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      });
      await client.studentAdmission.update({
        where: { id: admission.id },
        data: { uses: OrganizationComputerLimits.COMPUTERS - 1 },
      });
      const redemptions = await Promise.all(
        [randomUUID(), randomUUID()].map((requestId) =>
          f.command({ kind: StudentAccessKind.ACTIVATE, code, requestId }),
        ),
      );
      expect(redemptions.map((response) => response.statusCode).sort()).toEqual([200, 403]);
      const usage = await f.usage();
      expect(usage.authorizedComputers).toBe(OrganizationComputerLimits.COMPUTERS);
      expect(new Set(usage.computers.map((computer) => computer.name)).size).toBe(
        OrganizationComputerLimits.COMPUTERS,
      );
      expect(usage.activationCodes[0]?.activations).toBe(OrganizationComputerLimits.COMPUTERS);
    } finally {
      await f.api.close();
    }
  });

  it('revokes computers and memberships immediately while keeping historical usage', async () => {
    const f = await fixture();
    try {
      const one = await f.activate();
      const two = await f.activate(one.code);
      const student = await f.signIn(one.credential);
      const principal = await f.routes.service.readPrincipal({
        cookie: `${StudentSessionCookie}=${student.credential}`,
      });
      if (!principal) {
        throw new Error('Missing principal.');
      }
      expect(await access.store.reserveModelRequest(principal.sessionId, new Date())).toBe(true);
      const computer = (await f.usage()).computers.find((entry) => entry.name === 'Computer 1');
      if (!computer) {
        throw new Error('Missing computer.');
      }
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.REVOKE_COMPUTER,
              organizationId: f.organizationId,
              deviceId: computer.id,
            },
            undefined,
            'outside',
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.REVOKE_COMPUTER,
              organizationId: f.organizationId,
              deviceId: computer.id,
            },
            undefined,
            'owner',
          )
        ).statusCode,
      ).toBe(200);
      expect((await f.session(student.credential)).statusCode).toBe(401);
      expect(await access.store.reserveModelRequest(principal.sessionId, new Date())).toBe(false);
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.ENROLL,
              externalId: '001Ab',
              name: '',
              requestId: randomUUID(),
            },
            one.credential,
          )
        ).statusCode,
      ).toBe(403);
      const returned = await f.signIn(two.credential, '001Ab', '');
      expect(returned.user.id).toBe(student.user.id);
      await client.organizationMembership.update({
        where: {
          organizationId_userId: { organizationId: f.organizationId, userId: student.user.id },
        },
        data: { removedAt: new Date() },
      });
      expect((await f.session(returned.credential)).statusCode).toBe(401);
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.ENROLL,
              externalId: '001Ab',
              name: 'New name',
              requestId: randomUUID(),
            },
            two.credential,
          )
        ).statusCode,
      ).toBe(403);
      expect(await f.usage()).toMatchObject({
        authorizedComputers: 1,
        registeredStudents: 1,
        totalSignIns: 2,
      });
      expect(
        (await f.command({ kind: StudentAccessKind.DEACTIVATE }, two.credential)).statusCode,
      ).toBe(200);
      expect((await f.usage()).authorizedComputers).toBe(0);
    } finally {
      await f.api.close();
    }
  });

  it('rejects expired or cancelled codes and codes issued by a former owner', async () => {
    const f = await fixture();
    try {
      const expired = await f.createCode();
      await client.studentAdmission.update({
        where: { codeDigest: createHash('sha256').update(expired).digest('hex') },
        data: { expiresAt: new Date(0) },
      });
      expect(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: expired,
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(403);
      const cancelled = await f.createCode();
      const admission = await client.studentAdmission.findUniqueOrThrow({
        where: { codeDigest: createHash('sha256').update(cancelled).digest('hex') },
      });
      expect(
        (
          await f.command(
            {
              kind: StudentAccessKind.REVOKE_COMPUTER_CODE,
              organizationId: f.organizationId,
              admissionId: admission.id,
            },
            undefined,
            'owner',
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: cancelled,
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(403);
      const stale = await f.createCode();
      const existingComputer = await f.activate(stale);
      await client.organization.update({
        where: { id: f.organizationId },
        data: { ownerUserId: f.teacherId },
      });
      expect(
        (
          await f.command({
            kind: StudentAccessKind.ACTIVATE,
            code: stale,
            requestId: randomUUID(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await f.command({ kind: StudentAccessKind.STATUS }, existingComputer.credential)).json(),
      ).toMatchObject({ kind: 'ready' });
      expect(
        await client.studentDevice.count({ where: { organizationId: f.organizationId } }),
      ).toBe(1);
    } finally {
      await f.api.close();
    }
  });
});
