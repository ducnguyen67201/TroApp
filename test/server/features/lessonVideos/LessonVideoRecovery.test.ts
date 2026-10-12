import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RunLessonVideoStage } from '../../../../src/server/features/lessonVideos/application/RunLessonVideoStage.js';
import { LessonVideoService } from '../../../../src/server/features/lessonVideos/application/LessonVideoService.js';
import {
  LessonVideoStatus,
  LessonVideoFailure,
  LessonCommand,
} from '../../../../src/contracts/LessonVideos.js';
import { createLessonFixture, createLessonPorts } from './LessonVideoFixtures.js';
import { estimateContentReservation } from '../../../../src/server/features/lessonVideos/application/LessonVideoBudget.js';
import { readLessonVideoConfig } from '../../../../src/server/config/LessonVideoConfig.js';

const signal = new AbortController().signal;

describe('durable lesson generation', () => {
  it('uses one content request, saves all screens first, then finishes media', async () => {
    let lesson = createLessonFixture();
    const ports = createLessonPorts(lesson);
    const stages = new RunLessonVideoStage(
      ports.store,
      ports.content,
      ports.speech,
      ports.renderer,
      randomUUID,
      vi.fn(),
    );
    lesson = await stages.execute(lesson, signal);
    expect(lesson.screens).toHaveLength(3);
    expect(ports.speech.synthesize).not.toHaveBeenCalled();
    for (let step = 0; step < 7; step += 1) {
      lesson = await stages.execute(lesson, signal);
    }
    expect(lesson.status).toBe(LessonVideoStatus.READY);
    expect(ports.content.generate).toHaveBeenCalledTimes(1);
    expect(ports.speech.synthesize).toHaveBeenCalledTimes(3);
    expect(ports.renderer.render).toHaveBeenCalledTimes(4);
    expect(lesson.videoRevision).toBe(lesson.revision);
  });
  it('delivers text-only clips when speech fails without regenerating content', async () => {
    let lesson = createLessonFixture();
    const ports = createLessonPorts(lesson);
    vi.mocked(ports.speech.synthesize).mockRejectedValue(new Error('provider disconnected'));
    const stages = new RunLessonVideoStage(
      ports.store,
      ports.content,
      ports.speech,
      ports.renderer,
      randomUUID,
      vi.fn(),
    );
    for (let step = 0; step < 8; step += 1) {
      lesson = await stages.execute(lesson, signal);
    }
    expect(lesson.status).toBe(LessonVideoStatus.READY);
    expect(lesson.screens.every((screen) => screen.silent)).toBe(true);
    expect(ports.content.generate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ports.renderer.render).mock.calls[0]?.[0]).toMatchObject({
      kind: 'clip',
      audio: null,
    });
  });
  it('does not replay unknown in-flight model attempts after restart', async () => {
    const lesson = { ...createLessonFixture(), contentStarted: true, usageUncertain: true };
    const ports = createLessonPorts(lesson);
    const result = await new RunLessonVideoStage(
      ports.store,
      ports.content,
      ports.speech,
      ports.renderer,
      randomUUID,
      vi.fn(),
    ).execute(lesson, signal);
    expect(result.status).toBe(LessonVideoStatus.STOPPED);
    expect(result.error).toBe(LessonVideoFailure.CONTENT);
    expect(ports.content.generate).not.toHaveBeenCalled();
  });
  it('retains saved script and narration when rendering fails', async () => {
    let lesson = createLessonFixture();
    const ports = createLessonPorts(lesson);
    const stages = new RunLessonVideoStage(
      ports.store,
      ports.content,
      ports.speech,
      ports.renderer,
      randomUUID,
      vi.fn(),
    );
    lesson = await stages.execute(lesson, signal);
    lesson = await stages.execute(lesson, signal);
    vi.mocked(ports.renderer.render).mockRejectedValue(new Error('renderer unavailable'));
    lesson = await stages.execute(lesson, signal);
    expect(lesson.status).toBe(LessonVideoStatus.STOPPED);
    expect(lesson.screens[0]?.audioId).not.toBeNull();
    expect(lesson.screens[0]?.renderAttempts).toBe(3);
    expect(ports.content.generate).toHaveBeenCalledTimes(1);
  });
  it('stops expired jobs before any provider dispatch', async () => {
    const lesson = { ...createLessonFixture(), deadline: new Date(0).toISOString() };
    const ports = createLessonPorts(lesson);
    const result = await new RunLessonVideoStage(
      ports.store,
      ports.content,
      ports.speech,
      ports.renderer,
      randomUUID,
      vi.fn(),
    ).execute(lesson, signal);
    expect(result.error).toBe(LessonVideoFailure.DEADLINE);
    expect(ports.content.generate).not.toHaveBeenCalled();
  });
  it('persists reservation before calling the content provider', async () => {
    const lesson = createLessonFixture();
    const ports = createLessonPorts(lesson);
    vi.mocked(ports.content.generate).mockImplementation(() => {
      expect(ports.readSaved().contentStarted).toBe(true);
      throw new Error('TLS');
    });
    await new RunLessonVideoStage(
      ports.store,
      ports.content,
      ports.speech,
      ports.renderer,
      randomUUID,
      vi.fn(),
    ).execute(lesson, signal);
    expect(ports.readSaved().usageUncertain).toBe(true);
  });
  it('requires owner access and a matching revision for edits', async () => {
    const lesson = createLessonFixture();
    const ports = createLessonPorts(lesson);
    const sources = {
      authorize: vi.fn(() => Promise.resolve()),
      read: vi.fn(() => Promise.resolve(lesson.sources)),
      list: vi.fn(() => Promise.resolve([])),
    };
    const service = new LessonVideoService(
      ports.store,
      sources,
      ports.content,
      ports.renderer,
      lesson.settings,
      randomUUID,
      (value) => createHash('sha256').update(value).digest('hex'),
    );
    await expect(
      service.execute('another-owner', { kind: LessonCommand.READ, id: lesson.id }),
    ).rejects.toMatchObject({ code: LessonVideoFailure.FORBIDDEN });
    await expect(
      service.execute(lesson.ownerId, { kind: LessonCommand.CANCEL, id: lesson.id, revision: 99 }),
    ).rejects.toMatchObject({ code: LessonVideoFailure.STALE });
  });
  it('rejects a model configuration whose maximum reservation does not fit', () => {
    const settings = readLessonVideoConfig();
    expect(estimateContentReservation(settings)).toBe(108000);
    expect(() =>
      readLessonVideoConfig({ ...settings, budget: { ...settings.budget, revisionMicroUsd: 100 } }),
    ).toThrow();
  });
});
