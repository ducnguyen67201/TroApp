import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MaterialApiClient } from '../../../../src/desktop/main/classroom/MaterialApiClient.js';
import { MaterialCommandSchema } from '#contracts/ClassroomMaterials.js';

describe('private material main client', () => {
  it('reports bounded failure diagnostics without response content or credentials', async () => {
    const report = vi.fn<NonNullable<ConstructorParameters<typeof MaterialApiClient>[3]>>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ privateContent: 'Do not log teacher source or synthetic-session.' }),
      );
    const client = new MaterialApiClient(
      'http://127.0.0.1:3000',
      () => 'synthetic-session',
      request,
      report,
    );
    const classId = randomUUID();
    expect(await client.execute({ kind: 'read', classId })).toEqual({
      kind: 'failed',
      code: 'unavailable',
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'read',
        classId,
        reason: 'invalid_reply',
        httpStatus: 200,
      }),
    );
    expect(report.mock.calls[0]?.[0].validationIssueCount).toBeGreaterThan(0);
    request.mockResolvedValueOnce(
      Response.json({ kind: 'failed', code: 'forbidden' }, { status: 403 }),
    );
    await client.execute({ kind: 'read', classId });
    expect(report).toHaveBeenLastCalledWith({
      operation: 'read',
      classId,
      reason: 'refused',
      httpStatus: 403,
      code: 'forbidden',
    });
    request.mockRejectedValueOnce(new Error('Private error synthetic-session'));
    await client.execute({ kind: 'read', classId });
    expect(report).toHaveBeenLastCalledWith({
      operation: 'read',
      classId,
      reason: 'request_failed',
      httpStatus: null,
      code: 'unavailable',
    });
    expect(JSON.stringify(report.mock.calls)).not.toMatch(
      /privateContent|teacher source|synthetic-session|Private error/,
    );
  });
  it('attaches main-owned authentication and validates replies', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ kind: 'failed', code: 'stale' }));
    const client = new MaterialApiClient(
      'http://127.0.0.1:3000',
      () => 'synthetic-session',
      request,
    );
    const command = { kind: 'read' as const, classId: randomUUID() };
    expect(await client.execute(command)).toEqual({ kind: 'failed', code: 'stale' });
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/v1/classroom/materials',
      expect.objectContaining({
        headers: { cookie: 'synthetic-session', 'content-type': 'application/json' },
      }),
    );
    const body = request.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected serialized material command.');
    }
    const serializedCommand: unknown = JSON.parse(body);
    expect(MaterialCommandSchema.parse(serializedCommand)).toEqual({
      ...command,
      materialSchemaVersion: 2,
    });
    request.mockResolvedValueOnce(
      Response.json({ kind: 'download', name: '../../Unsafe.py', data: '' }),
    );
    expect(
      await client.execute({
        kind: 'download',
        classId: command.classId,
        materialId: randomUUID(),
      }),
    ).toEqual({ kind: 'failed', code: 'unavailable' });
  });
  it('discards a late private response after account change', async () => {
    let cookie: string | null = 'first';
    const request = vi.fn<typeof fetch>().mockImplementation(() => {
      cookie = 'second';
      return Promise.resolve(
        Response.json({ kind: 'download', name: 'Lesson.py', data: 'cHJpbnQ=' }),
      );
    });
    const client = new MaterialApiClient('http://127.0.0.1:3000', () => cookie, request);
    expect(
      await client.execute({ kind: 'download', classId: randomUUID(), materialId: randomUUID() }),
    ).toEqual({ kind: 'failed', code: 'forbidden' });
    cookie = null;
    expect(await client.execute({ kind: 'read', classId: randomUUID() })).toEqual({
      kind: 'failed',
      code: 'forbidden',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
