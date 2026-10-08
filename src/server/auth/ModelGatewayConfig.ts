/** Backend-owned gateway policy. Secrets are supplied by validated ServerEnv.
 * Keep the model aligned with the desktop agent; changing it requires both consumers.
 * Retry attempts remain bounded by the public diagnostics contract (at most two).
 */
export const ModelGatewayConfig = {
  model: 'gpt-5.4',
  maximumOutputTokens: 4096,
  bodyLimitBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 120_000,
  credentialTtlMs: 15 * 60_000,
  providerResponsesUrl: 'https://api.openai.com/v1/responses',
  retry: {
    maximumAttempts: 2,
    delayMs: 250,
    socketCodes: ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'],
  },
} as const;
