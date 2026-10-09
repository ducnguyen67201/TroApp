import { describe, expect, it, vi } from 'vitest';
import {
  CompanionHudCommandKind,
  CompanionHudPhase,
  type CompanionHudAck,
  type CompanionRenderToken,
} from '#contracts/CompanionHud.js';
import { TeachingMessageKind, type TeachingMessage } from '#contracts/TeachingStep.js';
import {
  CompanionHudPublisher,
  type CompanionHudTransport,
} from '../../../../src/desktop/worker/companion/CompanionHudPublisher.js';

const group = '11111111-1111-4111-8111-111111111111';

function message(sequence: number): TeachingMessage {
  return {
    lessonId: group,
    stepId: group,
    sequence,
    kind: TeachingMessageKind.INSTRUCTION,
    text: `Instruction ${String(sequence)}`,
  };
}

function token(revision: number): CompanionRenderToken {
  return {
    ownerEpoch: group,
    revision,
    renderId: `22222222-2222-4222-8222-${String(revision).padStart(12, '0')}`,
  };
}

function snapshot(teachingMessage?: TeachingMessage | null) {
  return {
    phase: CompanionHudPhase.THINKING,
    locale: 'en' as const,
    level: 0,
    ...(teachingMessage === undefined ? {} : { message: teachingMessage }),
  };
}

function fixture() {
  const sendCommand = vi.fn<CompanionHudTransport['sendCommand']>().mockImplementation((command) =>
    Promise.resolve({
      applied: true,
      ...(command.kind === CompanionHudCommandKind.PRESENT_MESSAGE
        ? { renderToken: token(command.message.sequence) }
        : {}),
    }),
  );
  const publisher = new CompanionHudPublisher(group, { sendCommand });
  return { publisher, sendCommand };
}

function deferredAck() {
  let resolve: (ack: CompanionHudAck) => void = () => {};
  const promise = new Promise<CompanionHudAck>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('serialized native HUD commands', () => {
  it('renews leases without replaying the cached message', async () => {
    const { publisher, sendCommand } = fixture();
    publisher.updateSnapshot(snapshot(message(1)));
    await publisher.flush();
    sendCommand.mockClear();
    publisher.renewLease();
    await publisher.flush();
    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([
      { kind: CompanionHudCommandKind.RENEW_LEASE, group, sequence: 3 },
    ]);
  });
  it('keeps one in-flight command and dispatches current appearance after a delayed acknowledgment', async () => {
    const { publisher, sendCommand } = fixture();
    const pending = deferredAck();
    sendCommand.mockReturnValueOnce(pending.promise);
    publisher.updateSnapshot(snapshot());
    const first = publisher.flush();
    publisher.updateSnapshot({ ...snapshot(), level: 0.25 });
    publisher.renewLease();
    publisher.renewLease();
    publisher.updateSnapshot({ ...snapshot(), level: 0.75 });
    const second = publisher.flush();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    pending.resolve({ applied: true });
    await Promise.all([first, second]);
    const commands = sendCommand.mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.sequence)).toEqual([1, 2, 3]);
    expect(commands[1]).toMatchObject({ kind: CompanionHudCommandKind.RENEW_LEASE });
    expect(commands[2]).toMatchObject({
      kind: CompanionHudCommandKind.UPDATE_APPEARANCE,
      level: 0.75,
    });
    expect(commands.every((command) => !('message' in command))).toBe(true);
  });
  it('preserves explicit message and clear order through coalesced appearance updates', async () => {
    const { publisher, sendCommand } = fixture();
    const pending = deferredAck();
    sendCommand.mockReturnValueOnce(pending.promise);
    publisher.updateSnapshot(snapshot(message(1)));
    const flushing = publisher.flush();
    publisher.updateSnapshot(snapshot(null));
    publisher.updateSnapshot(snapshot(message(2)));
    pending.resolve({ applied: true, renderToken: token(1) });
    await flushing;
    const commands = sendCommand.mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.kind)).toEqual([
      CompanionHudCommandKind.PRESENT_MESSAGE,
      CompanionHudCommandKind.CLEAR_MESSAGE,
      CompanionHudCommandKind.PRESENT_MESSAGE,
      CompanionHudCommandKind.UPDATE_APPEARANCE,
    ]);
    expect(commands[1]).toMatchObject({ expectedToken: token(1) });
    expect(commands[2]).toMatchObject({ message: message(2) });
  });
  it('ignores stale snapshots and same-identity conflicts after newer native readback', async () => {
    const { publisher, sendCommand } = fixture();
    publisher.observeMessage({ message: message(2), renderToken: token(2) });
    publisher.updateSnapshot(snapshot(message(1)));
    publisher.updateSnapshot(snapshot({ ...message(2), kind: TeachingMessageKind.QUESTION }));
    publisher.renewLease();
    await publisher.flush();
    expect(sendCommand.mock.calls.every(([command]) => !('message' in command))).toBe(true);
  });
  it('fences a delayed clear to its captured token and refuses late readback', async () => {
    const { publisher, sendCommand } = fixture();
    publisher.observeMessage({ message: message(1), renderToken: token(1) });
    const revision = publisher.readObservationRevision();
    publisher.updateSnapshot(snapshot(null));
    publisher.observeMessage({ message: message(2), renderToken: token(2) });
    publisher.observeMessage({ message: null }, revision);
    await publisher.flush();
    expect(sendCommand.mock.calls[0]?.[0]).toMatchObject({
      kind: CompanionHudCommandKind.CLEAR_MESSAGE,
      expectedToken: token(1),
    });
    sendCommand.mockClear();
    publisher.updateSnapshot(snapshot(null));
    await publisher.flush();
    expect(sendCommand.mock.calls[0]?.[0]).toMatchObject({ expectedToken: token(2) });
  });
  it('does not repaint a completion message after clear or empty appearance updates', async () => {
    const { publisher, sendCommand } = fixture();
    const completion = { ...message(2), kind: TeachingMessageKind.COMPLETION };
    publisher.updateSnapshot(snapshot(completion));
    await publisher.flush();
    publisher.updateSnapshot(snapshot(null));
    await publisher.flush();
    sendCommand.mockClear();
    publisher.updateSnapshot(snapshot(completion));
    publisher.renewLease();
    await publisher.flush();
    expect(sendCommand.mock.calls.every(([command]) => !('message' in command))).toBe(true);
  });
  it('stops dispatching queued updates after disposal during an in-flight call', async () => {
    const { publisher, sendCommand } = fixture();
    const pending = deferredAck();
    sendCommand.mockReturnValueOnce(pending.promise);
    publisher.updateSnapshot(snapshot());
    const flushing = publisher.flush();
    publisher.renewLease();
    publisher.dispose();
    pending.resolve({ applied: true });
    await flushing;
    publisher.updateSnapshot(snapshot());
    publisher.renewLease();
    await publisher.flush();
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
  it('reports transport rejection without replaying any message', async () => {
    const { publisher, sendCommand } = fixture();
    sendCommand.mockResolvedValueOnce({ applied: false });
    publisher.updateSnapshot(snapshot(message(2)));
    await expect(publisher.flush()).rejects.toThrow('Native presentation unavailable');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});

it('publishes the practice shortcut as appearance only, without action or teaching content', async () => {
  const { publisher, sendCommand } = fixture();
  publisher.updateSnapshot({ phase: CompanionHudPhase.PRACTICE_READY, locale: 'vi', level: 0 });
  await publisher.flush();
  expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([
    {
      kind: CompanionHudCommandKind.UPDATE_APPEARANCE,
      group,
      sequence: 1,
      phase: 'practice_ready',
      locale: 'vi',
      level: 0,
      speakingSequence: null,
    },
  ]);
});
