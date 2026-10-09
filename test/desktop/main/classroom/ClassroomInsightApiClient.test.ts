import { expect, it, vi } from 'vitest';
import { ClassroomInsightApiClient } from '../../../../src/desktop/main/classroom/ClassroomInsightApiClient.js';
import { insightClassId } from '../../ClassroomInsightDesktopFixtures.js';

it('keeps credentials in main and validates the strict feature response', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        kind: 'status',
        enabled: false,
        teacher: true,
        students: [],
        activities: [],
        plans: [],
        mappings: [],
      }),
    ),
  );
  const api = new ClassroomInsightApiClient('http://localhost', () => 'private-cookie', request);
  expect((await api.execute({ kind: 'status', classId: insightClassId })).kind).toBe('status');
  expect(request.mock.calls[0]?.[0]).toBe('http://localhost/api/v1/classroom/insights');
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({
    cookie: 'private-cookie',
    'content-type': 'application/json',
  });
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        kind: 'status',
        enabled: true,
        cookie: 'private',
        students: [],
        activities: [],
        plans: [],
        mappings: [],
      }),
    ),
  );
  expect(await api.execute({ kind: 'status', classId: insightClassId })).toEqual({
    kind: 'failed',
    code: 'unavailable',
  });
});

it('rejects stale credentials and aborted lifetimes even after a successful fetch', async () => {
  let cookie: string | null = 'first';
  const request = vi.fn<typeof fetch>().mockImplementation(() => {
    cookie = 'second';
    return Promise.resolve(new Response(JSON.stringify({ kind: 'failed', code: 'forbidden' })));
  });
  const api = new ClassroomInsightApiClient('http://localhost', () => cookie, request);
  expect(await api.execute({ kind: 'status', classId: insightClassId })).toEqual({
    kind: 'failed',
    code: 'stale',
  });
  cookie = null;
  expect(await api.execute({ kind: 'status', classId: insightClassId })).toEqual({
    kind: 'failed',
    code: 'forbidden',
  });
  expect(request).toHaveBeenCalledOnce();
});
