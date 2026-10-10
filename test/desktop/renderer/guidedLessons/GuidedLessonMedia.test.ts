import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLessonPlaybackFixture } from '../../../server/features/guidedLessons/LessonPlaybackFixture.js';
import {
  canPlayLessonProjection,
  createVerifiedLessonArtifactUrl,
  readNeededLessonArtifacts,
} from '../../../../src/desktop/renderer/guidedLessons/GuidedLessonMedia.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guided lesson permitted media', () => {
  it('loads only current and next authorized audio, never worked audio while pending', () => {
    const { projection } = createLessonPlaybackFixture();
    const needed = readNeededLessonArtifacts(projection, 0);
    expect(needed.length).toBeLessThanOrEqual(2);
    expect(needed.every((artifactId) => projection.allowedArtifactIds.includes(artifactId))).toBe(
      true,
    );
    expect(needed).not.toContain('audio-worked');
    expect(projection.visibleTraceStates.every((state) => state.stateView === 'before')).toBe(true);
  });

  it('refuses playback with different composition or font bytes', () => {
    const approved = { compositionBundleHash: 'a'.repeat(64), fontBundleHash: 'b'.repeat(64) };
    expect(canPlayLessonProjection(approved, approved)).toBe(true);
    expect(
      canPlayLessonProjection({ ...approved, compositionBundleHash: 'c'.repeat(64) }, approved),
    ).toBe(false);
    expect(canPlayLessonProjection({ ...approved, fontBundleHash: 'c'.repeat(64) }, approved)).toBe(
      false,
    );
    expect(
      canPlayLessonProjection(approved, { compositionBundleHash: '', fontBundleHash: '' }),
    ).toBe(false);
  });

  it('does not load artifacts that are outside the projection allowlist', () => {
    const { projection } = createLessonPlaybackFixture('watch');
    expect(readNeededLessonArtifacts({ ...projection, allowedArtifactIds: [] }, 0)).toEqual([]);
  });

  it('rejects modified artifact bytes before creating a media URL', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified');
    await expect(
      createVerifiedLessonArtifactUrl(new Uint8Array([1, 2, 3]), 'a'.repeat(64), 'audio/wav'),
    ).rejects.toThrow('Artifact digest mismatch');
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('creates a media URL only after the artifact digest matches', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified');
    expect(await createVerifiedLessonArtifactUrl(bytes, hash, 'audio/wav')).toBe('blob:verified');
    expect(createUrl).toHaveBeenCalledOnce();
  });
});
