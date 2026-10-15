import { StudentAccessKind } from '#contracts/StudentAccess.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { StudentAccessCommand } from '#contracts/StudentAccess.js';
import { StudentSessionCookie } from '#contracts/StudentAccess.js';
import type {
  StudentAccessStore,
  StudentCredential,
  StudentPrincipal,
} from './StudentAccessStore.js';

export const StudentModelSubjectPrefix = 'tro-learner-session:';

/** Cookie parsing is deliberately strict; malformed learner credentials never fall back to Google. */
export function readStudentCookie(headers: IncomingHttpHeaders): string | null {
  const cookies = (headers.cookie ?? '').split(';').map((item) => item.trim());
  const entries = cookies.filter((item) => item.startsWith(`${StudentSessionCookie}=`));
  if (entries.length !== 1) {
    return null;
  }
  const value = entries[0]?.slice(StudentSessionCookie.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function hasStudentCookie(headers: IncomingHttpHeaders): boolean {
  return (headers.cookie ?? '')
    .split(';')
    .some((item) => item.trim().startsWith(`${StudentSessionCookie}=`));
}

/** Application owns credential semantics; persistence receives only digests. */
export class StudentAccessService {
  constructor(
    readonly store: StudentAccessStore,
    private readonly digest: (value: string) => string,
    private readonly issueCredential: () => StudentCredential,
    private readonly deriveDeviceCredential: (code: string, requestId: string) => StudentCredential,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readPrincipal(headers: IncomingHttpHeaders): Promise<StudentPrincipal | null> {
    const token = readStudentCookie(headers);
    return token ? this.store.readSession(this.digest(token), this.now()) : Promise.resolve(null);
  }

  refreshPrincipal(headers: IncomingHttpHeaders): Promise<StudentPrincipal | null> {
    const token = readStudentCookie(headers);
    return token
      ? this.store.refreshSession(this.digest(token), this.now())
      : Promise.resolve(null);
  }

  async execute(
    command: StudentAccessCommand,
    deviceToken: string | null,
    teacherId: string | null,
  ) {
    if (command.kind === StudentAccessKind.ACTIVATE) {
      const credential = this.deriveDeviceCredential(command.code, command.requestId);
      const result = await this.store.activateDevice(
        this.digest(command.code),
        command.requestId,
        credential,
        this.now(),
        command.mode,
      );
      return result.kind === 'ready'
        ? { credential: credential.credential, context: result.context }
        : result;
    }
    if (command.kind === StudentAccessKind.STATUS) {
      return deviceToken
        ? this.store.readDevice(this.digest(deviceToken), this.now())
        : ({ kind: 'unconfigured' } as const);
    }
    if (command.kind === StudentAccessKind.DEACTIVATE && deviceToken) {
      await this.store.deactivateDevice(this.digest(deviceToken));
      return { kind: 'done' } as const;
    }
    if (teacherId && command.kind === StudentAccessKind.ORGANIZATION_ACCESS) {
      return this.store.readOrganizationAccess(teacherId, command.organizationId, this.now());
    }
    if (teacherId && command.kind === StudentAccessKind.REVOKE_COMPUTER) {
      await this.store.revokeComputer(
        teacherId,
        command.organizationId,
        command.deviceId,
        this.now(),
      );
      return { kind: 'done' } as const;
    }
    if (teacherId && command.kind === StudentAccessKind.REVOKE_COMPUTER_CODE) {
      await this.store.revokeComputerCode(teacherId, command.organizationId, command.admissionId);
      return { kind: 'done' } as const;
    }
    if (command.kind === StudentAccessKind.ENROLL && deviceToken) {
      const credential = this.issueCredential();
      const principal = await this.store.enroll(
        this.digest(deviceToken),
        command,
        this.digest(JSON.stringify({ externalId: command.externalId, name: command.name })),
        credential,
        this.now(),
      );
      return {
        user: principal.user,
        role: 'student' as const,
        expiresAt: principal.expiresAt.toISOString(),
        credential: credential.credential,
      };
    }
    return { kind: 'failed', message: 'Student access is unavailable.' } as const;
  }

  async revoke(headers: IncomingHttpHeaders): Promise<void> {
    const token = readStudentCookie(headers);
    if (token) {
      await this.store.revokeSession(this.digest(token));
    }
  }
}
