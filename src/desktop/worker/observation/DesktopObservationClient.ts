import type { CallToolResult } from '@openai/agents';
import { z } from 'zod';
import {
  DesktopObservationSchema,
  DesktopObservationTool,
  type DesktopObservation,
} from '#contracts/DesktopObservation.js';
import { GuidanceReason } from '#contracts/CursorCompanion.js';
import { EvidenceContentSchema } from '../cua/CuaTaskEvidence.js';
import { GuidanceTaskError, type CompanionTransport } from '../cua/CuaCompanionClient.js';
import { TeachingFailure, TeachingFailureCode } from '../teaching/TeachingFailure.js';
import { describeCuaResult } from '../cua/LoggedCuaServer.js';

export interface DesktopObservationPort {
  begin(watchId: string): Promise<void>;
  read(): Promise<DesktopObservation>;
  recordCapture(result: CallToolResult): void;
  readBaseline(): DesktopObservation | null;
  end(): Promise<void>;
}

const CaptureObservationSchema = z.object({ observation: DesktopObservationSchema });

/** Native metadata adapter. The driver retains pixels; model captures are admitted separately. */
export class DesktopObservationClient implements DesktopObservationPort {
  private watchId: string | null = null;
  private baseline: DesktopObservation | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private renewalPending = false;

  constructor(private readonly transport: CompanionTransport) {}

  async begin(watchId: string): Promise<void> {
    this.watchId = watchId;
    this.baseline = null;
    try {
      const result = await this.transport.callHostTool(DesktopObservationTool.BEGIN, {
        watch_id: watchId,
        input_only: true,
      });
      this.parseObservation(result, DesktopObservationTool.BEGIN);
      this.renewal = setInterval(() => {
        if (this.renewalPending || !this.watchId) {
          return;
        }
        this.renewalPending = true;
        void this.read()
          .catch(() => {})
          .finally(() => {
            this.renewalPending = false;
          });
      }, 15000);
      this.renewal.unref();
    } catch (error) {
      await this.end().catch(() => {});
      throw error;
    }
  }

  async read(): Promise<DesktopObservation> {
    if (!this.watchId) {
      throw new GuidanceTaskError(GuidanceReason.SESSION_LOST);
    }
    return this.parseObservation(
      await this.transport.callHostTool(DesktopObservationTool.READ, { watch_id: this.watchId }),
      DesktopObservationTool.READ,
    );
  }

  recordCapture(result: CallToolResult): void {
    const parsed = CaptureObservationSchema.safeParse(result.structuredContent);
    const images = result.content.filter((part) => {
      const content = EvidenceContentSchema.safeParse(part);
      return content.success && content.data.type === 'image';
    });
    this.baseline =
      !result.isError &&
      images.length === 1 &&
      parsed.success &&
      parsed.data.observation.watch_id === this.watchId
        ? parsed.data.observation
        : null;
  }

  readBaseline(): DesktopObservation | null {
    return this.baseline;
  }

  async end(): Promise<void> {
    if (this.renewal) {
      clearInterval(this.renewal);
      this.renewal = null;
    }
    const watchId = this.watchId;
    this.watchId = null;
    this.baseline = null;
    if (watchId) {
      await this.transport.callHostTool(DesktopObservationTool.END, { watch_id: watchId });
    }
  }

  private parseObservation(
    result: CallToolResult,
    toolName: DesktopObservationTool,
  ): DesktopObservation {
    const parsed = DesktopObservationSchema.safeParse(result.structuredContent);
    const details = { toolName, nativeResult: describeCuaResult(result) };
    if (result.isError) {
      throw new TeachingFailure(
        TeachingFailureCode.OBSERVATION_TOOL_FAILED,
        GuidanceReason.SESSION_LOST,
        details,
      );
    }
    if (!parsed.success) {
      const fields = new Set(Object.keys(DesktopObservationSchema.shape));
      const invalidFields = parsed.error.issues.map((issue) => {
        const field = issue.path[0];
        return typeof field === 'string' && fields.has(field) ? field : 'structuredContent';
      });
      throw new TeachingFailure(
        TeachingFailureCode.OBSERVATION_INVALID_SNAPSHOT,
        GuidanceReason.SESSION_LOST,
        { ...details, invalidFields: [...new Set(invalidFields)] },
      );
    }
    if (parsed.data.watch_id !== this.watchId) {
      throw new TeachingFailure(
        TeachingFailureCode.OBSERVATION_OWNER_MISMATCH,
        GuidanceReason.SESSION_LOST,
        details,
      );
    }
    return parsed.data;
  }
}
