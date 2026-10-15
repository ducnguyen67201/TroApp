/** Local worker lifetime, independent of voice and model request deadlines. */
export const AgentWorkerPolicy = {
  IDLE_MS: 120_000,
  SPECULATIVE_IDLE_MS: 15_000,
  STARTUP_TIMEOUT_MS: 10_000,
  SHUTDOWN_TIMEOUT_MS: 2_000,
} as const;
