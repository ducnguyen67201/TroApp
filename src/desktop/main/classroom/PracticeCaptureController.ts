import { createHash, randomUUID } from 'node:crypto';
import type { TeachingContext } from '#contracts/Classroom.js';
import {
  PracticeCaptureCommandSchema,
  PracticeCaptureLimits,
  type PracticeCaptureReply,
} from '#contracts/PracticeCapture.js';
import {
  PracticeEvidenceKind,
  PracticeEvidenceSchema,
  PracticeFailure,
  type PracticeEvidence,
} from '#contracts/PracticeCheck.js';

export interface PracticeWindowCapturePort {
  listWindows(): Promise<{ id: string; name: string }[]>;
  captureWindow(id: string): Promise<{ base64: string; width: number; height: number }>;
}

function readBinding(context: TeachingContext | null): string | null {
  return context
    ? JSON.stringify([
        context.participation.id,
        context.participation.deviceId,
        context.activity.id,
        context.attempt.id,
        context.meeting.contextVersion,
        context.attempt.progressVersion,
      ])
    : null;
}

/** Local drafts are immutable, expiring and bound to the current joined device/account. */
export class PracticeCaptureController {
  private windows = new Map<string, string>();
  private selected: string | null = null;
  private draft: {
    evidence: Extract<PracticeEvidence, { kind: typeof PracticeEvidenceKind.IMAGE }>;
    binding: string;
    expiresAt: number;
  } | null = null;
  private binding: string | null = null;
  private generation = 0;
  private busy = false;
  constructor(
    private readonly capture: PracticeWindowCapturePort,
    private readonly readContext: () => TeachingContext | null,
    private readonly now: () => number = Date.now,
  ) {}

  dispose(): void {
    this.generation += 1;
    this.draft = null;
    this.windows.clear();
    this.selected = null;
    this.binding = null;
  }

  async execute(raw: unknown): Promise<PracticeCaptureReply> {
    const command = PracticeCaptureCommandSchema.safeParse(raw);
    if (!command.success) {
      return { kind: 'failed', code: PracticeFailure.INVALID };
    }
    const binding = readBinding(this.readContext());
    if (!binding) {
      this.dispose();
      return { kind: 'failed', code: PracticeFailure.FORBIDDEN };
    }
    if (this.binding !== binding) {
      this.dispose();
      this.binding = binding;
    }
    if (command.data.kind === 'discard') {
      this.draft = null;
      this.generation += 1;
      return { kind: 'discarded' };
    }
    if (command.data.kind === 'read') {
      const draft = this.draft;
      return draft &&
        draft.binding === binding &&
        draft.expiresAt > this.now() &&
        draft.evidence.capture?.id === command.data.captureId
        ? { kind: 'captured', evidence: structuredClone(draft.evidence) }
        : { kind: 'failed', code: PracticeFailure.STALE };
    }
    if (this.busy) {
      return { kind: 'failed', code: PracticeFailure.UNAVAILABLE };
    }
    this.busy = true;
    const generation = this.generation;
    try {
      if (command.data.kind === 'list') {
        const windows = await this.capture.listWindows();
        if (generation !== this.generation || readBinding(this.readContext()) !== binding) {
          return { kind: 'failed', code: PracticeFailure.STALE };
        }
        this.windows.clear();
        return {
          kind: 'windows',
          windows: windows.slice(0, PracticeCaptureLimits.WINDOWS).map((window) => {
            const id = randomUUID();
            this.windows.set(id, window.id);
            return { id, name: window.name.slice(0, 200) };
          }),
        };
      }
      const selected = command.data.windowId
        ? this.windows.get(command.data.windowId)
        : this.selected;
      if (!selected) {
        return { kind: 'failed', code: PracticeFailure.INVALID };
      }
      const image = await this.capture.captureWindow(selected);
      if (generation !== this.generation || readBinding(this.readContext()) !== binding) {
        return { kind: 'failed', code: PracticeFailure.STALE };
      }
      const digest = createHash('sha256').update(Buffer.from(image.base64, 'base64')).digest('hex');
      const evidence = PracticeEvidenceSchema.parse({
        id: randomUUID(),
        kind: PracticeEvidenceKind.IMAGE,
        name: 'Captured work',
        mediaType: 'image/jpeg',
        base64: image.base64,
        capture: {
          id: randomUUID(),
          capturedAt: new Date(this.now()).toISOString(),
          width: image.width,
          height: image.height,
          digest,
        },
      });
      if (evidence.kind !== PracticeEvidenceKind.IMAGE) {
        throw new Error('Invalid capture.');
      }
      this.selected = selected;
      this.draft = { evidence, binding, expiresAt: this.now() + PracticeCaptureLimits.DRAFT_MS };
      return { kind: 'captured', evidence: structuredClone(evidence) };
    } catch {
      this.draft = null;
      return { kind: 'failed', code: PracticeFailure.UNAVAILABLE };
    } finally {
      this.busy = false;
    }
  }

  /** Rejects forged capture provenance; manual evidence remains a separate supported path. */
  validatesEvidence(evidence: PracticeEvidence[]): boolean {
    return evidence.every((item) => {
      if (item.kind !== PracticeEvidenceKind.IMAGE || !item.capture) {
        return true;
      }
      const draft = this.draft;
      return Boolean(
        draft &&
        draft.expiresAt > this.now() &&
        draft.binding === readBinding(this.readContext()) &&
        item.capture.id === draft.evidence.capture?.id &&
        item.base64 === draft.evidence.base64 &&
        JSON.stringify(item.capture) === JSON.stringify(draft.evidence.capture),
      );
    });
  }
}
