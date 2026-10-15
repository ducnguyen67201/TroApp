import type { AuthUser } from '#contracts/AuthSession.js';
import type {
  StudentAccessCommand,
  StudentAccessReply,
  StudentEnrollment,
} from '#contracts/StudentAccess.js';
import type { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import type { ClassroomCommand } from '#contracts/Classroom.js';

export const StudentAccessPolicy = {
  ACTIVATION_MS: 24 * 60 * 60_000,
  DEVICE_MS: 180 * 24 * 60 * 60_000,
  PERSONAL_SESSION_MS: 30 * 24 * 60 * 60_000,
  SHARED_SESSION_MS: 8 * 60 * 60_000,
  PROFILES_PER_DEVICE: 1000,
  DAILY_SCHOOL_ADMISSIONS: 500,
  DAILY_SCHOOL_MODEL_REQUESTS: 1000,
  DAILY_LEARNER_MODEL_REQUESTS: 100,
  REQUEST_ATTEMPTS_PER_IP: 240,
} as const;

export interface StudentPrincipal {
  sessionId: string;
  user: AuthUser;
  deviceId: string;
  schoolId: string;
  classId: string | null;
  organizationId?: string;
  mode: StudentDeviceMode;
  meetingId: string | null;
  expiresAt: Date;
}

export interface StudentCredential {
  credential: string;
  digest: string;
}

/** Atomic persistence operations enforce ownership, conditional counters and audit writes together. */
export interface StudentAccessStore {
  createComputerCode(
    actorId: string,
    command: Extract<StudentAccessCommand, { kind: 'create-computer-code' }>,
    digest: string,
    now: Date,
  ): Promise<void>;
  readOrganizationAccess(
    actorId: string,
    organizationId: string,
    now: Date,
  ): Promise<StudentAccessReply>;
  revokeComputer(
    actorId: string,
    organizationId: string,
    deviceId: string,
    now: Date,
  ): Promise<void>;
  revokeComputerCode(actorId: string, organizationId: string, admissionId: string): Promise<void>;
  deactivateDevice(digest: string): Promise<void>;
  activateDevice(
    codeDigest: string,
    requestId: string,
    credential: StudentCredential,
    now: Date,
    mode?: StudentDeviceMode,
  ): Promise<StudentAccessReply>;
  readDevice(digest: string, now: Date): Promise<StudentAccessReply>;
  enroll(
    digest: string,
    command: StudentEnrollment,
    payloadDigest: string,
    credential: StudentCredential,
    now: Date,
  ): Promise<StudentPrincipal>;
  readSession(digest: string, now: Date): Promise<StudentPrincipal | null>;
  refreshSession(digest: string, now: Date): Promise<StudentPrincipal | null>;
  readSessionById(sessionId: string, now: Date): Promise<StudentPrincipal | null>;
  revokeSession(digest: string): Promise<void>;
  reserveModelRequest(sessionId: string, now: Date): Promise<boolean>;
  canAccessClassroom(principal: StudentPrincipal, command: ClassroomCommand): Promise<boolean>;
}

export class StudentAccessError extends Error {
  constructor(
    message = 'Student access is unavailable. Ask your organization administrator to check computer authorization.',
  ) {
    super(message);
  }
}
