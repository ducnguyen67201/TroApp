/** A local context limit: callers must terminate rather than retry the provider. */
export class TaskContextBudgetError extends Error {
  constructor() {
    super('The task context exceeds its byte budget.');
    this.name = 'TaskContextBudgetError';
  }
}

export function assertContextByteBudget(value: unknown, maximumBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) {
    throw new TaskContextBudgetError();
  }
}

export function isTaskContextBudgetError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof TaskContextBudgetError) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    current = current.cause;
  }
  return false;
}
