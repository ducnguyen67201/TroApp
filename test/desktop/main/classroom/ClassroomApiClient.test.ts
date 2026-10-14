import { describe, expect, it, vi } from 'vitest';
import { ClassroomAdminCapability, ClassroomOrganizationCapability } from '#contracts/Classroom.js';
import { StudentAccessCapability } from '#contracts/StudentAccess.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { ClassroomApiClient } from '../../../../src/desktop/main/classroom/ClassroomApiClient.js';

describe('classroom main HTTP client', () => {
  it('negotiates admin metadata without changing commands understood by older APIs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        kind: 'home',
        home: { role: AccountRole.STUDENT, courses: [], classes: [] },
      }),
    );
    const client = new ClassroomApiClient(
      'http://127.0.0.1:3000',
      () => 'synthetic-session',
      request,
    );

    expect(await client.execute({ kind: 'home' })).toEqual({
      kind: 'home',
      home: { role: AccountRole.STUDENT, isAdmin: false, courses: [], classes: [] },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'http://127.0.0.1:3000/api/v1/classroom/command',
      expect.objectContaining({
        method: 'POST',
        headers: {
          cookie: 'synthetic-session',
          'content-type': 'application/json',
          [ClassroomAdminCapability.HEADER]: ClassroomAdminCapability.VERSION,
          [ClassroomOrganizationCapability.HEADER]: ClassroomOrganizationCapability.VERSION,
          [StudentAccessCapability.HEADER]: StudentAccessCapability.VERSION,
        },
        body: JSON.stringify({ kind: 'home' }),
      }),
    );
  });

  it.each([false, true])('preserves the server administrator flag %s', async (isAdmin) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        kind: 'home',
        home: { role: AccountRole.STUDENT, isAdmin, courses: [], classes: [] },
      }),
    );
    const client = new ClassroomApiClient(
      'http://127.0.0.1:3000',
      () => 'synthetic-session',
      request,
    );

    expect(await client.execute({ kind: 'home' })).toEqual({
      kind: 'home',
      home: { role: AccountRole.STUDENT, isAdmin, courses: [], classes: [] },
    });
  });
});
