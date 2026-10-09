import type { CallToolResult } from '@openai/agents';
import { z } from 'zod';
import { EvidenceContentSchema } from '../cua/CuaTaskEvidence.js';

export const DesktopCaptureSchema = z.object({
  capture_id: z.string().min(1),
  display: z.literal('primary'),
  screen_width: z.number().int().positive(),
  screen_height: z.number().int().positive(),
  screenshot_width: z.number().int().positive(),
  screenshot_height: z.number().int().positive(),
  scale_factor: z.number().positive(),
  agent_overlay_capture: z
    .object({
      status: z.enum(['excluded', 'not_present', 'not_excluded']),
      method: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    })
    .optional(),
});

const CaptureOptionsSchema = z.object({
  max_image_dimension: z.number().int().nonnegative().optional(),
});

interface DesktopCapture {
  captureId: string;
}

export interface PresentationCapture extends DesktopCapture {
  ageMs: number;
  observationArgs: z.infer<typeof CaptureOptionsSchema>;
}

/** Validate a model observation; the native adapter owns pixel comparison. */
function readDesktopCapture(result: CallToolResult): DesktopCapture | null {
  const metadata = DesktopCaptureSchema.safeParse(result.structuredContent);
  if (result.isError || !metadata.success) {
    return null;
  }
  const images = result.content.flatMap((part) => {
    const parsed = EvidenceContentSchema.safeParse(part);
    return parsed.success && parsed.data.type === 'image' ? [parsed.data] : [];
  });
  if (images.length !== 1) {
    return null;
  }
  return { captureId: metadata.data.capture_id };
}

/**
 * Retains the latest capture ID and safe options, never screenshot content.
 * Each presentation forwards these options to its native refresh/comparison.
 */
export class TeachingCapture {
  private capture: DesktopCapture | null = null;
  private receivedAtMs = 0;
  private observationArgs: z.infer<typeof CaptureOptionsSchema> = {};

  constructor(private readonly readTime: () => number = () => performance.now()) {}

  reset(): void {
    this.capture = null;
    this.receivedAtMs = 0;
    this.observationArgs = {};
  }

  readCaptureId(): string | null {
    return this.capture?.captureId ?? null;
  }

  recordDesktopCapture(result: CallToolResult, args: Record<string, unknown> | null): void {
    const options = CaptureOptionsSchema.safeParse(args ?? {});
    this.capture = options.success ? readDesktopCapture(result) : null;
    this.observationArgs = options.success ? options.data : {};
    this.receivedAtMs = this.readTime();
  }

  readPresentationCapture(args: Record<string, unknown> | null): PresentationCapture | null {
    const capture = this.capture;
    const ageMs = this.readTime() - this.receivedAtMs;
    if (!capture || args?.['capture_id'] !== capture.captureId) {
      return null;
    }
    return { ...capture, ageMs, observationArgs: { ...this.observationArgs } };
  }
}
