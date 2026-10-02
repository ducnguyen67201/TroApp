import { CursorCompanionStateSchema, CursorCompanionTool } from '#contracts/CursorCompanion.js';
import type { CallToolResult } from '@openai/agents';

export interface CompanionTransport {
  callHostTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** Cua renders and schedules every frame. Tro owns only its transport lease. */
export class CuaCompanionClient {
  private renewal: ReturnType<typeof setInterval> | null = null;
  private renewalPending = false;
  private closed = false;
  private modeChanges: Promise<void> = Promise.resolve();

  constructor(private readonly transport: CompanionTransport) {}

  async startFollowing(): Promise<void> {
    if (this.closed) {
      throw new Error('Cursor companion session closed.');
    }
    if (this.renewal) {
      return;
    }
    await this.setMode('follow');
    this.renewal = setInterval(() => {
      if (this.renewalPending || this.closed) {
        return;
      }
      this.renewalPending = true;
      void this.setMode('follow')
        .catch(() => {
          /* Cua expires the lease after lost transport; no unbounded retries. */
          if (this.renewal) {
            clearInterval(this.renewal);
            this.renewal = null;
          }
        })
        .finally(() => {
          this.renewalPending = false;
        });
    }, 15_000);
    this.renewal.unref();
  }

  /** Release pointer-follow ownership before Cua's real action animations.
   * Its existing cursor remains enabled for native executor feedback. */
  async pauseFollowing(): Promise<void> {
    if (this.renewal) {
      clearInterval(this.renewal);
      this.renewal = null;
    }
    await this.setMode('hidden');
    const result = await this.transport.callHostTool('set_agent_cursor_enabled', { enabled: true });
    if (result.isError) {
      throw new Error('Cua could not enable action feedback.');
    }
  }

  async cancelSequence(): Promise<void> {
    const result = await this.transport.callHostTool(CursorCompanionTool.CANCEL_SEQUENCE, {});
    if (result.isError) {
      throw new Error('Cua could not cancel cursor guidance.');
    }
    CursorCompanionStateSchema.parse(result.structuredContent);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.renewal) {
      clearInterval(this.renewal);
      this.renewal = null;
    }
    /* Hiding cancels natively before transport shutdown. A disconnected worker
       also loses its runtime lease and session cleanup removes native marks. */
    await this.setMode('hidden');
  }

  private setMode(mode: 'follow' | 'hidden'): Promise<void> {
    const change = this.modeChanges.then(async () => {
      if (mode === 'follow' && this.closed) {
        return;
      }
      const result = await this.transport.callHostTool(CursorCompanionTool.SET_MODE, {
        mode,
        ...(mode === 'follow' ? { label: 'Tro' } : {}),
      });
      if (result.isError) {
        throw new Error('Cua cursor companion is unavailable.');
      }
      const state = CursorCompanionStateSchema.parse(result.structuredContent);
      if (state.following !== (mode === 'follow')) {
        throw new Error('Cua cursor mode was not applied.');
      }
    });
    this.modeChanges = change.catch(() => {});
    return change;
  }
}
