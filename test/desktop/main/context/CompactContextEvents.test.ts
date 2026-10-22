import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ContextEventKind,
  ContextEventSchema,
  type ContextEvent,
} from '../../../../src/contracts/StudyContext.js';
import { compactContextEvents } from '../../../../src/desktop/main/context/CompactContextEvents.js';

function createEvent(index: number, kind: ContextEvent['kind'], text: string): ContextEvent {
  return {
    id: randomUUID(),
    kind,
    resource: kind === ContextEventKind.INPUT ? 'physical-input' : 'foreground-accessibility',
    observedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, index)).toISOString(),
    text,
    limitation: 'Targets and app acceptance are unknown.',
  };
}

it('compacts a click/scroll storm to one source without an AI call or raw input rows', () => {
  const events = Array.from({ length: 1000 }, (_, index) =>
    createEvent(
      index,
      ContextEventKind.INPUT,
      JSON.stringify({ kind: index % 2 ? 'release' : 'scroll', point: { x: 0.1234, y: 0.9876 } }),
    ),
  );
  const compacted = compactContextEvents(events);
  expect(compacted).toHaveLength(1);
  const snapshot = compacted[0];
  if (!snapshot) {
    throw new Error('Missing snapshot.');
  }
  expect(ContextEventSchema.safeParse(snapshot).success).toBe(true);
  expect(snapshot.kind).toBe(ContextEventKind.OBSERVATION);
  expect(snapshot.text).toContain('"eventCount":1000');
  expect(snapshot.text).toContain('"release":500');
  expect(snapshot.text).toContain('"scroll":500');
  expect(snapshot.text).toContain('"firstPoint":{"x":0.12,"y":0.99}');
  expect(snapshot.text).toContain('attempts, not proof');
  expect(snapshot.text).toContain('Memory-only fallback records may be lost on app restart.');
  expect(snapshot.limitation).toContain('memory-only fallback may be lost on restart');
  expect(snapshot.text.length).toBeLessThan(2000);
});

it('preserves selected text excerpts and evidence kinds with local provenance', () => {
  const observation = createEvent(0, ContextEventKind.OBSERVATION, 'repeat 10 / move 10 steps');
  const question = createEvent(1, ContextEventKind.USER_MESSAGE, 'Why does it move once?');
  const result = createEvent(2, ContextEventKind.RESULT, 'Task remains unresolved.');
  const snapshot = compactContextEvents([observation, question, result])[0];
  expect(snapshot?.text).toContain(observation.text);
  expect(snapshot?.text).toContain(observation.id);
  expect(snapshot?.text).toContain(question.text);
  expect(snapshot?.text).toContain(result.text);
  expect(snapshot?.text).toContain('"omittedEvidenceEvents":0');
  expect(snapshot?.text).toContain('"truncatedEvidenceExcerpts":0');
});

it('bounds snapshots and explicitly counts omitted and truncated evidence while leaving originals untouched', () => {
  const events = Array.from({ length: 100 }, (_, index) =>
    createEvent(
      index,
      ContextEventKind.OBSERVATION,
      `screen-${String(index)} ${'x'.repeat(10_000)}`,
    ),
  );
  const snapshot = compactContextEvents(events)[0];
  if (!snapshot) {
    throw new Error('Missing snapshot.');
  }
  expect(snapshot.text.length).toBeLessThanOrEqual(24_000);
  expect(snapshot.text).toContain('screen-99');
  expect(snapshot.text).not.toContain('"omittedEvidenceEvents":0');
  expect(snapshot.text).not.toContain('"truncatedEvidenceExcerpts":0');
  expect(snapshot.text).toContain('"evidenceEventCount":100');
  expect(events[0]?.text.length).toBeGreaterThan(10_000);
  expect(ContextEventSchema.safeParse(snapshot).success).toBe(true);
});

it('uses stable IDs and content for retries, deduplicates event replay and changes identity for new evidence', () => {
  const events = [createEvent(0, ContextEventKind.INPUT, '{"kind":"release","point":null}')];
  const first = compactContextEvents(events);
  expect(compactContextEvents([...events, ...events])).toEqual(first);
  expect(compactContextEvents([...events].reverse())).toEqual(first);
  expect(
    compactContextEvents([
      ...events,
      createEvent(1, ContextEventKind.OBSERVATION, 'changed screen'),
    ])[0]?.id,
  ).not.toBe(first[0]?.id);
});

it('records malformed physical evidence as unknown and rejects conflicting event identities', () => {
  const event = createEvent(0, ContextEventKind.INPUT, 'not valid JSON');
  expect(compactContextEvents([event])[0]?.text).toContain('"unknown":1');
  expect(() => compactContextEvents([event, { ...event, text: 'conflicting evidence' }])).toThrow(
    'Conflicting local context event identity.',
  );
  expect(compactContextEvents([])).toEqual([]);
});

it('reports locally omitted journal segments and changes retry identity when coverage changes', () => {
  const events = [createEvent(0, ContextEventKind.OBSERVATION, 'current screen')];
  const full = compactContextEvents(events)[0];
  const bounded = compactContextEvents(events, 3)[0];
  expect(bounded?.text).toContain('"omittedLocalSegments":3');
  expect(bounded?.id).not.toBe(full?.id);
  expect(compactContextEvents(events, 3)[0]).toEqual(bounded);
});
