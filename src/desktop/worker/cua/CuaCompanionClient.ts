import {
  CursorCompanionStateSchema,
  CursorCompanionTool,
  CursorCompanionCapabilitiesSchema,
  CursorGuidanceTaskSchema,
  CursorGuidanceResultSchema,
  GuidanceReason,
} from '#contracts/CursorCompanion.js';
import type { CallToolResult } from '@openai/agents';
import { TeachingFailure, TeachingFailureCode } from '../teaching/TeachingFailure.js';
import { GuidanceTaskError } from '../teaching/GuidanceTaskError.js';
import { describeCuaResult } from './LoggedCuaServer.js';
export { GuidanceTaskError } from '../teaching/GuidanceTaskError.js';

export interface CompanionTransport {
  callHostTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** Cua renders and schedules every frame. Tro owns only its transport lease. */
export class CuaCompanionClient {
  private renewal: ReturnType<typeof setInterval> | null = null;
  private renewalPending = false;
  private closed = false;
  private followingFailure: TeachingFailure | null = null;
  private receiveFollowingFailure: (() => void) | null = null;
  private modeChanges: Promise<void> = Promise.resolve();

  constructor(private readonly transport: CompanionTransport) {}

  async beginGuidanceTask(taskEpoch: string): Promise<void> {
    const capabilities = await this.transport.callHostTool(
      CursorCompanionTool.READ_CAPABILITIES,
      {},
    );
    const parsed = CursorCompanionCapabilitiesSchema.safeParse(capabilities.structuredContent);
    if (
      capabilities.isError ||
      !parsed.success ||
      !parsed.data.task_lifecycle ||
      !parsed.data.paired_presentation ||
      !parsed.data.presentation_versions.includes(2)
    ) {
      throw new GuidanceTaskError(GuidanceReason.UNSUPPORTED_VERSION);
    }
    const result = await this.transport.callHostTool(CursorCompanionTool.BEGIN_TASK, {
      task_epoch: taskEpoch,
      presentation_version: 2,
    });
    const state = CursorGuidanceTaskSchema.parse(result.structuredContent);
    if (result.isError || state.status !== 'task_ready' || state.task_epoch !== taskEpoch) {
      throw new Error('Cua did not admit this guidance task.');
    }
  }

  async endGuidanceTask(taskEpoch: string): Promise<void> {
    const result = await this.transport.callHostTool(CursorCompanionTool.END_TASK, {
      task_epoch: taskEpoch,
    });
    const terminal = CursorGuidanceResultSchema.safeParse(result.structuredContent);
    if (
      result.isError &&
      terminal.success &&
      terminal.data.status !== 'completed' &&
      terminal.data.status !== 'presented' &&
      terminal.data.task_epoch === taskEpoch
    ) {
      throw new GuidanceTaskError(
        terminal.data.status === 'canceled' ? terminal.data.reason : terminal.data.code,
        terminal.data.status === 'canceled',
      );
    }
    const state = CursorGuidanceTaskSchema.parse(result.structuredContent);
    if (result.isError || state.status !== 'task_ended' || state.task_epoch !== taskEpoch) {
      throw new Error('Cua did not release this guidance task.');
    }
  }

  setFollowingFailureListener(listener: (() => void) | null): void {
    this.receiveFollowingFailure = listener;
  }

  assertFollowingAvailable(): void {
    if (this.followingFailure) {
      throw this.followingFailure;
    }
  }

  async startFollowing(): Promise<void> {
    this.assertFollowingAvailable();
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
        .catch((error: unknown) => {
          this.followingFailure = new TeachingFailure(
            TeachingFailureCode.COMPANION_RENEWAL_FAILED,
            GuidanceReason.SESSION_LOST,
            error instanceof TeachingFailure ? error.details : {},
          );
          this.receiveFollowingFailure?.();
          /* A failed renewal is latched. The lesson must not continue paying for
             model calls while native following is unavailable. */
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
      const details = {
        toolName: CursorCompanionTool.SET_MODE,
        requestedMode: mode,
        nativeResult: describeCuaResult(result),
      };
      if (result.isError) {
        throw new TeachingFailure(
          TeachingFailureCode.COMPANION_MODE_FAILED,
          GuidanceReason.SESSION_LOST,
          details,
        );
      }
      const state = CursorCompanionStateSchema.safeParse(result.structuredContent);
      if (!state.success) {
        throw new TeachingFailure(
          TeachingFailureCode.COMPANION_MODE_INVALID,
          GuidanceReason.SESSION_LOST,
          details,
        );
      }
      if (state.data.following !== (mode === 'follow')) {
        throw new TeachingFailure(
          TeachingFailureCode.COMPANION_MODE_NOT_APPLIED,
          GuidanceReason.SESSION_LOST,
          details,
        );
      }
    });
    this.modeChanges = change.catch(() => {});
    return change;
  }
}
