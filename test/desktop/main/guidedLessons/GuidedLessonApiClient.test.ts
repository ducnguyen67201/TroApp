import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GuidedLessonApiClient } from '../../../../src/desktop/main/guidedLessons/GuidedLessonApiClient.js';

const request = { classId: 'class', lessonId: 'lesson', releaseId: 'release', artifactId: 'audio' };

describe('guided lesson main transport', () => {
  it('keeps cookies in main and rejects replies from a previous account', async () => {
    let cookie = 'first';
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.headers).toMatchObject({ cookie: 'first' });
      cookie = 'second';
      return Promise.resolve(Response.json({ kind: 'list', classes: [], lessons: [] }));
    });
    const client = new GuidedLessonApiClient('https://api.example.test', () => cookie, fetcher);
    expect(await client.read({ action: 'list' })).toMatchObject({
      kind: 'failed',
      code: 'unauthorized',
    });
  });

  it('downloads only bounded digest-verified binary artifacts', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const fetcher = vi.fn<typeof fetch>((url) => {
      expect(url instanceof Request ? url.url : url.toString()).toContain('?releaseId=release');
      return Promise.resolve(
        new Response(bytes, {
          headers: {
            'content-type': 'audio/wav',
            'content-length': '3',
            'x-artifact-digest': digest,
          },
        }),
      );
    });
    const client = new GuidedLessonApiClient('https://api.example.test', () => 'cookie', fetcher);
    expect(await client.readArtifact(request)).toMatchObject({ kind: 'artifact', bytes, digest });
  });

  it('rejects oversized, truncated and mismatched artifacts', async () => {
    for (const headers of [
      { 'content-length': '16777217', 'x-artifact-digest': '0'.repeat(64) },
      { 'content-length': '4', 'x-artifact-digest': '0'.repeat(64) },
      { 'content-length': '3', 'x-artifact-digest': '0'.repeat(64) },
    ]) {
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { ...headers, 'content-type': 'audio/wav' },
          }),
        ),
      );
      expect(
        await new GuidedLessonApiClient(
          'https://api.example.test',
          () => 'cookie',
          fetcher,
        ).readArtifact(request),
      ).toMatchObject({ kind: 'failed' });
    }
  });
});
