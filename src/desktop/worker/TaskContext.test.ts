import { describe, expect, it, vi } from 'vitest';
import { CuaTaskEvidence } from './CuaTaskEvidence.js';
import { TaskContext } from './TaskContext.js';
import { TaskCompletionConfig, TaskTermination } from './TaskCompletionConfig.js';

const goal = {
  summary: 'Open YouTube',
  criteria: [
    {
      description: 'YouTube loaded',
    },
  ],
};

describe('per-task control state', () => {
  it('enforces separate verifier turn limits while sharing cancellation and tool budgets', () => {
    const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal, {
      ...TaskCompletionConfig,
      verificationModelTurns: 1,
    });
    try {
      task.defineGoal(goal);
      task.admitModelTurn();
      task.beginVerification();
      expect(() => {
        task.admitToolCall(true);
      }).toThrow('read-only');
      task.admitVerificationModelTurn();
      expect(() => {
        task.admitVerificationModelTurn();
      }).toThrow();
      expect(task.termination).toBe(TaskTermination.TURN_LIMIT);
    } finally {
      task.endVerification();
      task.dispose();
    }
  });

  it('freezes goals and rejects mutation in the goal-definition model turn', () => {
    const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal);
    try {
      task.admitModelTurn();
      const defined = task.defineGoal(goal);
      expect(Object.isFrozen(defined)).toBe(true);
      expect(Object.isFrozen(defined.criteria[0])).toBe(true);
      expect(() => task.defineGoal(goal)).toThrow('cannot be changed');
      expect(() => {
        task.admitToolCall(true);
      }).toThrow('wait for its result');
      task.admitModelTurn();
      expect(() => {
        task.admitToolCall(true);
      }).not.toThrow();
    } finally {
      task.dispose();
    }
  });

  it('stops a repeated inspection loop without evaluating task success', () => {
    const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal, {
      ...TaskCompletionConfig,
      settleAllowanceMs: 0,
    });
    try {
      task.defineGoal(goal);
      task.recordProgress('same-state', true);
      task.recordProgress('same-state', true);
      expect(task.termination).toBeNull();
      task.recordProgress('same-state', true);
      expect(task.termination).toBe(TaskTermination.LOOP);
      expect(task.abort.signal.aborted).toBe(true);
    } finally {
      task.dispose();
    }
  });

  it('enforces a shared tool budget across the recovery attempt', () => {
    const task = new TaskContext(new CuaTaskEvidence(), new AbortController().signal, {
      ...TaskCompletionConfig,
      maximumToolCalls: 2,
    });
    try {
      task.defineGoal(goal);
      task.admitModelTurn();
      task.admitToolCall(true);
      expect(() => {
        task.admitToolCall(false);
      }).toThrow();
      expect(task.termination).toBe(TaskTermination.TOOL_LIMIT);
    } finally {
      task.dispose();
    }
  });

  it('aborts at the worker deadline and disposes the user listener', async () => {
    vi.useFakeTimers();
    const user = new AbortController();
    const task = new TaskContext(new CuaTaskEvidence(), user.signal, {
      ...TaskCompletionConfig,
      deadlineMs: 10,
    });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(task.termination).toBe(TaskTermination.DEADLINE);
      task.dispose();
      user.abort();
      expect(task.termination).toBe(TaskTermination.DEADLINE);
    } finally {
      task.dispose();
      vi.useRealTimers();
    }
  });

  it('handles cancellation before the first model call', () => {
    const user = new AbortController();
    user.abort();
    const task = new TaskContext(new CuaTaskEvidence(), user.signal);
    try {
      expect(() => {
        task.admitModelTurn();
      }).toThrow();
      expect(task.termination).toBe(TaskTermination.USER);
    } finally {
      task.dispose();
    }
  });
});
