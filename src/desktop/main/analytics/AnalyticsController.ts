import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AnalyticsEvent,
  AnalyticsEventSchema,
  type AnalyticsEventInput,
  type AnalyticsReply,
} from '#contracts/Analytics.js';
import { AppEnvironmentSchema, type AppEnvironment } from '#contracts/AppEnvironment.js';
import {
  AnalyticsPreferencesSchema,
  type AnalyticsStore,
  type SavedAnalyticsPreferences,
} from './AnalyticsPreferences.js';

export const analyticsShutdownTimeoutMs = 2_000;

export interface AnalyticsMetadata {
  appVersion: string;
  appEnvironment: AppEnvironment;
  platform: NodeJS.Platform;
}

export interface AnalyticsCapture {
  distinctId: string;
  event: string;
  properties: Record<string, string | number | boolean>;
}

export interface AnalyticsTransport {
  capture(message: AnalyticsCapture): void;
  stop(): void;
  shutdown(): Promise<void>;
}

const metadataSchema = z.strictObject({
  appVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/)
    .max(128),
  appEnvironment: AppEnvironmentSchema,
  platform: z.enum([
    'aix',
    'darwin',
    'freebsd',
    'linux',
    'openbsd',
    'sunos',
    'win32',
    'android',
    'haiku',
  ]),
});

/** Configured installations share by default; saved preferences gate every capture. */
export class AnalyticsController {
  private preferences: SavedAnalyticsPreferences | null = null;
  private transport: AnalyticsTransport | null = null;
  private initialization: Promise<void> | null = null;
  private changes: Promise<void> = Promise.resolve();
  private storageReady = false;
  private closed = false;
  private generation = 0;
  private hasCapturedAppOpen = false;

  constructor(
    private readonly store: AnalyticsStore,
    private readonly createTransport: (() => AnalyticsTransport) | undefined,
    private readonly metadata: AnalyticsMetadata,
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= this.loadPreferences().then(() => {
      if (!this.storageReady) {
        this.initialization = null;
      }
    });
    return this.initialization;
  }

  readStatus(): AnalyticsReply {
    if (!this.storageReady) {
      return { kind: 'failed' };
    }
    return {
      kind: 'ok',
      status: {
        configured: this.createTransport !== undefined,
        enabled: this.transport !== null && !this.closed,
      },
    };
  }

  setEnabled(enabled: boolean): Promise<AnalyticsReply> {
    const generation = ++this.generation;
    if (!enabled) {
      this.stopTransport();
    }
    const change = this.changes.then(() => this.saveEnabled(enabled, generation));
    this.changes = change.then(() => {});
    return change;
  }

  capture(input: AnalyticsEventInput): void {
    if (!this.transport || !this.preferences?.enabled || this.closed) {
      return;
    }
    const event = AnalyticsEventSchema.safeParse(input);
    const metadata = metadataSchema.safeParse(this.metadata);
    if (!event.success || !metadata.success) {
      return;
    }
    const { event: eventName, ...fields } = event.data;
    const properties: Record<string, string | number | boolean> = {
      ...metadata.data,
      $process_person_profile: false,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        properties[key] = value;
      }
    }
    try {
      this.transport.capture({
        distinctId: this.preferences.installationId,
        event: eventName,
        properties,
      });
      if (eventName === AnalyticsEvent.APP_OPENED) {
        this.hasCapturedAppOpen = true;
      }
    } catch {
      /* Analytics failures cannot interrupt the action being measured. */
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await this.closeTransport(transport);
    }
  }

  private async loadPreferences(): Promise<void> {
    const generation = this.generation;
    try {
      const saved = await this.store.readPreferences();
      this.preferences = saved === null ? null : AnalyticsPreferencesSchema.parse(saved);
      if (!this.preferences && this.createTransport && this.canRestoreSharing(generation)) {
        const preferences: SavedAnalyticsPreferences = {
          version: 1,
          enabled: true,
          installationId: randomUUID(),
        };
        /* Persist the device identity before creating a client. A pending user
           preference change takes priority and is saved after initialization. */
        await this.store.savePreferences(preferences);
        this.preferences = preferences;
      }
      this.storageReady = true;
      if (this.preferences?.enabled && this.canRestoreSharing(generation)) {
        this.startTransport();
      }
    } catch {
      this.storageReady = false;
      this.preferences = null;
    }
  }

  private canRestoreSharing(generation: number): boolean {
    return !this.closed && generation === 0 && generation === this.generation;
  }

  private async saveEnabled(enabled: boolean, generation: number): Promise<AnalyticsReply> {
    await this.initialize();
    if (!this.storageReady || this.closed || (enabled && !this.createTransport)) {
      return { kind: 'failed' };
    }
    if (generation !== this.generation) {
      return this.readStatus();
    }
    if (enabled && this.transport) {
      return this.readStatus();
    }
    const preferences: SavedAnalyticsPreferences = {
      version: 1,
      enabled,
      installationId: enabled ? randomUUID() : (this.preferences?.installationId ?? randomUUID()),
    };
    try {
      await this.store.savePreferences(preferences);
      this.preferences = preferences;
      if (generation !== this.generation) {
        return this.readStatus();
      }
      if (enabled) {
        this.startTransport();
      }
      return this.readStatus();
    } catch {
      this.stopTransport();
      return { kind: 'failed' };
    }
  }

  private startTransport(): void {
    this.transport = this.createTransport?.() ?? null;
    if (!this.hasCapturedAppOpen) {
      this.capture({ event: AnalyticsEvent.APP_OPENED });
    }
  }

  private stopTransport(): void {
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try {
        transport.stop();
      } catch {
        /* Runtime sharing remains off even if the adapter fails to stop. */
      }
      void this.closeTransport(transport);
    }
  }

  private async closeTransport(transport: AnalyticsTransport): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.shutdown(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, analyticsShutdownTimeoutMs);
          timer.unref();
        }),
      ]);
    } catch {
      /* Delivery is best effort and must not block application shutdown. */
    } finally {
      clearTimeout(timer);
      try {
        transport.stop();
      } catch {
        /* All subsequent captures have already been disabled. */
      }
    }
  }
}
