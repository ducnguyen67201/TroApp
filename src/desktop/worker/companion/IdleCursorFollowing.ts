import { CursorCompanionStateSchema, CursorCompanionTool } from '#contracts/CursorCompanion.js';
import type { CallToolResult } from '@openai/agents';

export interface IdleCursorTransport {
  callToolResult(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** Serializes renewals and acknowledged native release without importing task orchestration. */
export class IdleCursorFollowing {
  private changes: Promise<void> = Promise.resolve();
  private renewal: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private disposed = false;

  constructor(
    private readonly transport: IdleCursorTransport,
    private readonly onFailure: () => void,
  ) {}

  setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.clearRenewal();
    const change = this.changes.then(async () => {
      if (this.disposed) {
        throw new Error('Cursor transport closed.');
      }
      await this.setMode(enabled);
      if (enabled && this.enabled && !this.renewal) {
        this.renewal = setInterval(() => {
          const renewal = this.changes.then(async () => {
            if (this.enabled) {
              await this.setMode(true);
            }
          });
          this.changes = renewal.catch(() => {
            this.enabled = false;
            this.clearRenewal();
            this.onFailure();
          });
        }, 15_000);
        this.renewal.unref();
      }
    });
    this.changes = change.catch(() => {});
    return change;
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.clearRenewal();
  }

  private clearRenewal(): void {
    if (this.renewal) {
      clearInterval(this.renewal);
    }
    this.renewal = null;
  }

  private async setMode(enabled: boolean): Promise<void> {
    const result = await this.transport.callToolResult(CursorCompanionTool.SET_MODE, {
      mode: enabled ? 'follow' : 'hidden',
      ...(enabled ? { label: 'Tro' } : {}),
    });
    const state = CursorCompanionStateSchema.safeParse(result.structuredContent);
    if (result.isError || !state.success || state.data.following !== enabled || state.data.active) {
      throw new Error('Cursor ownership transition failed.');
    }
  }
}
