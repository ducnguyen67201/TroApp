import { describe, expect, it, vi } from 'vitest';
import { LessonGeneration } from '../../../../src/server/features/guidedLessons/application/LessonGeneration.js';
import type {
  LessonModel,
  LessonRenderer,
  LessonSpeech,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import { MemoryGuidedLessonStore } from './MemoryGuidedLessonStore.js';

function setup() {
  const store = new MemoryGuidedLessonStore();
  let now = new Date('2026-10-10T12:00:00.000Z');
  const model: LessonModel = {
    countInput: vi
      .fn<LessonModel['countInput']>()
      .mockRejectedValue(new Error('Unexpected model call')),
    generate: vi
      .fn<LessonModel['generate']>()
      .mockRejectedValue(new Error('Unexpected model call')),
  };
  const speech: LessonSpeech = {
    synthesize: vi
      .fn<LessonSpeech['synthesize']>()
      .mockRejectedValue(new Error('Unexpected speech call')),
  };
  const renderer: LessonRenderer = {
    render: vi
      .fn<LessonRenderer['render']>()
      .mockRejectedValue(new Error('Unexpected render call')),
  };
  return {
    cleanup: vi.spyOn(store, 'deleteExpiredArtifacts'),
    pending: vi.spyOn(store, 'listPendingLessons'),
    generation: new LessonGeneration(store, model, speech, renderer, () => now, vi.fn()),
    setTime(value: string): void {
      now = new Date(value);
    },
  };
}

describe('guided lesson artifact retention scheduling', () => {
  it('cleans on startup and hourly while still checking jobs on every wake', async () => {
    const fixture = setup();
    await fixture.generation.runNext();
    fixture.setTime('2026-10-10T12:00:01.000Z');
    await fixture.generation.runNext();
    fixture.setTime('2026-10-10T12:59:59.999Z');
    await fixture.generation.runNext();
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.pending).toHaveBeenCalledTimes(3);

    fixture.setTime('2026-10-10T13:00:00.000Z');
    await fixture.generation.runNext();
    expect(fixture.cleanup).toHaveBeenCalledTimes(2);
    expect(fixture.cleanup).toHaveBeenLastCalledWith(new Date('2026-10-10T13:00:00.000Z'));
    expect(fixture.pending).toHaveBeenCalledTimes(4);
  });

  it('reports cleanup failure once and continues job polls before the next cleanup attempt', async () => {
    const fixture = setup();
    fixture.cleanup.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(fixture.generation.runNext()).rejects.toThrow('Storage unavailable');

    fixture.setTime('2026-10-10T12:00:01.000Z');
    await fixture.generation.runNext();
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.pending).toHaveBeenCalledTimes(1);

    fixture.setTime('2026-10-10T13:00:00.000Z');
    await fixture.generation.runNext();
    expect(fixture.cleanup).toHaveBeenCalledTimes(2);
    expect(fixture.pending).toHaveBeenCalledTimes(2);
  });
});
