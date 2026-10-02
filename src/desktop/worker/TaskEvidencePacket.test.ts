import { describe, expect, it } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { CuaTaskEvidence } from './CuaTaskEvidence.js';
import { TaskContext } from './TaskContext.js';
import { TaskCompletionConfig } from './TaskCompletionConfig.js';
import { createVerificationEvidencePacket } from './TaskEvidencePacket.js';
import { TaskContextBudgetError } from './TaskContextBudget.js';

function createTask(limits: Partial<typeof TaskCompletionConfig> = {}): TaskContext {
  const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal, {
    ...TaskCompletionConfig,
    ...limits,
  });
  task.defineGoal({
    summary: 'Show pages',
    criteria: [{ description: 'Requested pages are visible' }],
  });
  task.evidence.setReadOnlyTools(['get_window_state']);
  return task;
}

function observe(task: TaskContext, windowId: number, data: string): void {
  task.evidence.recordToolResult(
    task.evidence.beginToolCall('get_window_state'),
    { pid: 7, window_id: windowId },
    {
      content: [{ type: 'image', data, mimeType: 'image/png' }],
      structuredContent: { pid: 7, window_id: windowId },
    },
  );
}

describe('bounded raw evidence and packets', () => {
  it('stores and transmits duplicate images once while preserving distinct observation references', () => {
    const task = createTask();
    try {
      const image = 'a'.repeat(4000);
      observe(task, 12, image);
      observe(task, 13, image);
      const packet = createVerificationEvidencePacket(task, DesktopLocale.ENGLISH);
      expect(packet.observations).toHaveLength(2);
      expect(packet.content.filter(({ part }) => part.type === 'image')).toHaveLength(1);
      expect(task.evidence.readRetainedBytes()).toBeLessThan(8000);
      task.dispose();
      expect(task.evidence.readRetainedBytes()).toBe(2);
    } finally {
      task.dispose();
    }
  });

  it('fails a packet byte budget without truncating current evidence', () => {
    const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal, {
      ...TaskCompletionConfig,
      maximumEvidencePacketBytes: 1000,
    });
    try {
      task.defineGoal({ summary: 'Show page', criteria: [{ description: 'Page shown' }] });
      task.evidence.setReadOnlyTools(['get_window_state']);
      observe(task, 12, 'a'.repeat(1500));
      expect(() => createVerificationEvidencePacket(task, DesktopLocale.ENGLISH)).toThrow(
        TaskContextBudgetError,
      );
      expect(task.evidence.readSnapshot().observations).toHaveLength(1);
    } finally {
      task.dispose();
    }
  });

  it('discards obsolete content first and never silently drops current evidence to fit the store', () => {
    const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal, {
      ...TaskCompletionConfig,
      maximumRetainedEvidenceBytes: 4000,
    });
    try {
      task.defineGoal({ summary: 'Show page', criteria: [{ description: 'Page shown' }] });
      task.evidence.setReadOnlyTools(['get_window_state']);
      observe(task, 12, 'a'.repeat(2000));
      observe(task, 12, 'b'.repeat(2000));
      expect(task.evidence.readSnapshot().observations).toHaveLength(1);
      expect(task.evidence.readRetainedBytes()).toBeLessThanOrEqual(4000);
      expect(() => {
        observe(task, 13, 'c'.repeat(3000));
      }).toThrow(TaskContextBudgetError);
      expect(task.evidence.readSnapshot().observations).toHaveLength(2);
    } finally {
      task.dispose();
    }
  });

  it('invalid image content cannot establish success just by its content kind', () => {
    const task = createTask();
    try {
      observe(task, 12, 'invalid image !');
      const observation = task.evidence.readSnapshot().observations[0];
      expect(observation?.hasImage).toBe(false);
      expect(task.evidence.hasAdmissibleEvidence(observation?.id ?? 'missing')).toBe(false);
    } finally {
      task.dispose();
    }
  });
});
