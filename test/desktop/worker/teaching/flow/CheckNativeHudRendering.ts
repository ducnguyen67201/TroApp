import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MCPServerStdio } from '@openai/agents';
import {
  CompanionHudAckSchema,
  CompanionHudCommandKind,
  CompanionHudTool,
  type CompanionHudCommand,
} from '#contracts/CompanionHud.js';
import { CompanionHudMessageSchema } from '#contracts/CompanionHudWorker.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';

/** Uses the actual main-queue compositor and installed-message readback. No model, capture or physical input. */
export async function checkNativeHudRendering(server: MCPServerStdio): Promise<void> {
  const group = randomUUID();
  const first = {
    lessonId: randomUUID(),
    stepId: randomUUID(),
    sequence: 1,
    kind: TeachingMessageKind.INSTRUCTION,
    text: 'Synthetic native HUD acceptance message one.',
  };
  const second = {
    ...first,
    stepId: randomUUID(),
    sequence: 2,
    text: 'Synthetic native HUD acceptance message two.',
  };
  const initial = await server.callToolResult(CompanionHudTool.SET_STATE, {
    group,
    sequence: 0,
    phase: 'waiting',
    locale: 'en',
    level: 0,
  });
  assert.ok(!initial.isError && CompanionHudAckSchema.parse(initial.structuredContent).applied);

  async function send(command: CompanionHudCommand) {
    const result = await server.callToolResult(CompanionHudTool.SEND_COMMAND, command, null, {
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(!result.isError, `Native HUD command refused: ${command.kind}`);
    const acknowledgment = CompanionHudAckSchema.parse(result.structuredContent);
    assert.ok(acknowledgment.applied);
    return acknowledgment;
  }

  const firstReceipt = await send({
    kind: CompanionHudCommandKind.PRESENT_MESSAGE,
    group,
    sequence: 1,
    locale: 'en',
    message: first,
  });
  assert.ok(firstReceipt.renderToken, 'First message must be installed by the native callback.');
  const pending = send({
    kind: CompanionHudCommandKind.PRESENT_MESSAGE,
    group,
    sequence: 2,
    locale: 'en',
    message: second,
  });
  // A legacy refresh can carry old content; common admission must preserve the current job.
  const stale = await server.callToolResult(CompanionHudTool.SET_STATE, {
    group,
    sequence: 3,
    phase: 'thinking',
    locale: 'en',
    level: 0,
    message: first,
  });
  assert.ok(!stale.isError);
  await send({ kind: CompanionHudCommandKind.RENEW_LEASE, group, sequence: 4 });
  await send({
    kind: CompanionHudCommandKind.UPDATE_APPEARANCE,
    group,
    sequence: 5,
    phase: 'thinking',
    locale: 'en',
    level: 0.5,
    speakingSequence: 2,
  });
  const secondReceipt = await pending;
  assert.ok(
    secondReceipt.renderToken,
    'Second message must complete its matching native installation.',
  );
  assert.notDeepEqual(secondReceipt.renderToken, firstReceipt.renderToken);
  const readback = await server.callToolResult(CompanionHudTool.READ_MESSAGE, { group });
  const installed = CompanionHudMessageSchema.parse(readback.structuredContent);
  assert.deepEqual(installed.message, second);
  assert.deepEqual(installed.renderToken, secondReceipt.renderToken);
  await send({
    kind: CompanionHudCommandKind.CLEAR_MESSAGE,
    group,
    sequence: 6,
    expectedToken: firstReceipt.renderToken,
  });
  const afterOldClear = await server.callToolResult(CompanionHudTool.READ_MESSAGE, { group });
  assert.deepEqual(
    CompanionHudMessageSchema.parse(afterOldClear.structuredContent).message,
    second,
  );
  await send({
    kind: CompanionHudCommandKind.CLEAR_MESSAGE,
    group,
    sequence: 7,
    expectedToken: secondReceipt.renderToken,
  });
  const afterClear = await server.callToolResult(CompanionHudTool.READ_MESSAGE, { group });
  assert.equal(CompanionHudMessageSchema.parse(afterClear.structuredContent).message, null);
  const binding = await server.callToolResult(CompanionHudTool.BIND_CURSOR, { group });
  assert.ok(!binding.isError);
  const nextLesson = { ...first, lessonId: randomUUID() };
  const context = await server.callToolResult(CompanionHudTool.BIND_CURSOR, {
    group,
    lessonId: nextLesson.lessonId,
  });
  assert.ok(!context.isError);
  const nextReceipt = await send({
    kind: CompanionHudCommandKind.PRESENT_MESSAGE,
    group,
    sequence: 8,
    locale: 'en',
    message: nextLesson,
  });
  assert.ok(nextReceipt.renderToken);
  const oldLesson = await server.callToolResult(CompanionHudTool.SEND_COMMAND, {
    kind: CompanionHudCommandKind.PRESENT_MESSAGE,
    group,
    sequence: 9,
    locale: 'en',
    message: { ...second, sequence: 3 },
  });
  assert.equal(
    oldLesson.isError,
    true,
    'Retired lesson cannot re-enter through delayed host content.',
  );
  await send({
    kind: CompanionHudCommandKind.CLEAR_MESSAGE,
    group,
    sequence: 10,
    expectedToken: nextReceipt.renderToken,
  });
  console.info(
    'PASS native HUD: two CALayer installations, stale snapshot, renewal, speaking/appearance, token readback and conditional clear.',
  );
}
