import {
  ClassroomFailure,
  type ClassroomCommand,
  type ClassroomReply,
} from '#contracts/Classroom.js';
import { ClassroomViewAs, type ClassroomPerson } from '#contracts/ClassroomViewAs.js';
import type { ClassroomApi } from './ClassroomSessionController.js';

/** Main owns the selected subject. Cookies remain the administrator's, and old requests are fenced. */
export class ClassroomViewAsController {
  private person: ClassroomPerson | null = null;
  private cookie: string | null = null;
  private generation = 0;
  private pending = new AbortController();

  constructor(
    private readonly adminApi: Pick<ClassroomApi, 'execute'>,
    private readonly readCookie: () => string | null,
    private readonly resetClassroom: () => void,
    private readonly request: typeof fetch = fetch,
  ) {
    this.cookie = readCookie();
  }

  reset(): void {
    this.generation += 1;
    this.pending.abort();
    this.pending = new AbortController();
    this.person = null;
    this.cookie = this.readCookie();
    this.resetClassroom();
  }

  /** Used only by classroom, materials, practice and insights clients. */
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.cookie !== this.readCookie()) {
      this.reset();
    }
    const generation = this.generation;
    const headers = new Headers(init?.headers);
    if (this.person) {
      headers.set(ClassroomViewAs.HEADER, this.person.id);
    }
    const response = await this.request(input, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([init.signal, this.pending.signal])
        : this.pending.signal,
    });
    if (generation !== this.generation || this.cookie !== this.readCookie()) {
      throw new Error('Classroom view changed.');
    }
    return response;
  };

  async selectPerson(userId: string | null): Promise<ClassroomReply> {
    // Returning to self is always possible, including after admin authority is revoked.
    if (userId === null) {
      this.reset();
      return { kind: 'admin-view-as', person: null };
    }
    const cookie = this.readCookie();
    const generation = this.generation;
    const reply = await this.adminApi.execute({ kind: 'admin-view-as', userId });
    if (generation !== this.generation || cookie !== this.readCookie()) {
      return { kind: 'failed', code: ClassroomFailure.STALE };
    }
    if (reply.kind !== 'admin-view-as') {
      return reply;
    }
    if (reply.person?.id !== userId) {
      return { kind: 'failed', code: ClassroomFailure.INVALID };
    }
    this.reset();
    this.person = reply.person;
    return reply;
  }

  async execute(
    command: ClassroomCommand,
    api: Pick<ClassroomApi, 'execute'>,
  ): Promise<ClassroomReply> {
    if (this.cookie !== this.readCookie()) {
      this.reset();
    }
    if (command.kind === 'admin-view-as') {
      return { kind: 'failed', code: ClassroomFailure.INVALID };
    }
    if (command.kind.startsWith('admin-')) {
      return this.adminApi.execute(command);
    }
    const generation = this.generation;
    const reply = await api.execute(command);
    if (generation !== this.generation) {
      return { kind: 'failed', code: ClassroomFailure.STALE };
    }
    if (reply.kind === 'home') {
      return {
        kind: 'home',
        home: {
          ...reply.home,
          viewingAs: this.person,
          isAdmin: this.person !== null || reply.home.isAdmin,
        },
      };
    }
    return reply;
  }
}
