import { z } from 'zod';

const IdentifierSchema = z.union([z.string().min(1), z.number().int()]);

export const TargetFieldsSchema = z.object({
  pid: z.number().int().optional(),
  window_id: IdentifierSchema.optional(),
  tab_id: IdentifierSchema.optional(),
  display_id: IdentifierSchema.optional(),
  target_id: IdentifierSchema.optional(),
});

export type ObservationTarget = z.infer<typeof TargetFieldsSchema>;

/** Conservative facts: unsupported driver fields are not guessed or coerced. */
export const ObservationFieldsSchema = TargetFieldsSchema.extend({
  url: z.url().optional(),
  is_loading: z.boolean().optional(),
  is_visible: z.boolean().optional(),
  is_focused: z.boolean().optional(),
  status: z.enum(['satisfied', 'unsatisfied', 'unknown', 'refused']).optional(),
});

export const ObservationScope = {
  WINDOW: 'window',
  BROWSER: 'browser',
  DESKTOP: 'desktop',
  VERIFICATION: 'verification',
} as const;

const ObservationTools = new Map<string, (typeof ObservationScope)[keyof typeof ObservationScope]>([
  ['get_window_state', ObservationScope.WINDOW],
  ['get_accessibility_tree', ObservationScope.WINDOW],
  ['get_browser_state', ObservationScope.BROWSER],
  ['get_desktop_state', ObservationScope.DESKTOP],
  ['verify_state', ObservationScope.VERIFICATION],
]);

export const ObservationCategory = {
  WINDOW_CONTENT: 'window_content',
  WINDOW_VISIBILITY: 'window_visibility',
  BROWSER_STATE: 'browser_state',
  DESKTOP_STATE: 'desktop_state',
  VERIFICATION: 'verification',
} as const;

export interface CuaObservation {
  category: (typeof ObservationCategory)[keyof typeof ObservationCategory];
  target: ObservationTarget;
  scope: (typeof ObservationScope)[keyof typeof ObservationScope];
  fields: z.infer<typeof ObservationFieldsSchema>;
  hasImage: boolean;
  hasText: boolean;
}

const ScreenTextSchema = z.object({
  tree_markdown: z.string().optional(),
  elements: z.array(z.unknown()).optional(),
});

/** Metadata-only JSON and empty accessibility snapshots are not page content. */
export function readObservationText(text: string): string {
  try {
    const decoded: unknown = JSON.parse(text);
    const parsed = ScreenTextSchema.safeParse(decoded);
    if (!parsed.success) {
      return '';
    }
    return (
      parsed.data.tree_markdown?.trim() ||
      (parsed.data.elements?.length ? JSON.stringify(parsed.data.elements) : '')
    );
  } catch {
    return text.trim();
  }
}

export function readObservationTarget(argumentsValue: unknown): ObservationTarget {
  const parsed = TargetFieldsSchema.safeParse(argumentsValue);
  return parsed.success ? parsed.data : {};
}

/** Extract conservative facts without interpreting task satisfaction. */
export function parseCuaObservation(
  toolName: string,
  argumentsValue: unknown,
  result: {
    structuredContent?: unknown;
    content: readonly { type: string; text?: string }[];
    isError?: boolean;
  },
): CuaObservation | null {
  const scope = ObservationTools.get(toolName);
  if (!scope || result.isError === true) {
    return null;
  }
  const parsed = ObservationFieldsSchema.safeParse(result.structuredContent);
  if (result.structuredContent !== undefined && !parsed.success) {
    return null;
  }
  const fields = parsed.success ? parsed.data : {};
  if (fields.status === 'refused') {
    return null;
  }
  const argumentTarget = readObservationTarget(argumentsValue);
  const resultTarget = readObservationTarget(fields);
  for (const key of ['pid', 'window_id', 'tab_id', 'display_id', 'target_id'] as const) {
    if (
      argumentTarget[key] !== undefined &&
      resultTarget[key] !== undefined &&
      argumentTarget[key] !== resultTarget[key]
    ) {
      return null;
    }
  }
  const hasImage = result.content.some((item) => item.type === 'image');
  const hasText = result.content.some(
    (item) =>
      item.type === 'text' &&
      typeof item.text === 'string' &&
      readObservationText(item.text).length > 0,
  );
  if (!hasImage && !hasText && Object.keys(fields).length === 0) {
    return null;
  }
  const category =
    scope === ObservationScope.WINDOW
      ? ObservationCategory.WINDOW_CONTENT
      : scope === ObservationScope.BROWSER
        ? ObservationCategory.BROWSER_STATE
        : scope === ObservationScope.DESKTOP
          ? ObservationCategory.DESKTOP_STATE
          : ObservationCategory.VERIFICATION;
  return {
    target: { ...argumentTarget, ...resultTarget },
    scope,
    category,
    fields,
    hasImage,
    hasText,
  };
}

const WindowListSchema = z.object({
  windows: z.array(
    z.object({
      pid: z.number().int(),
      window_id: IdentifierSchema,
      is_on_screen: z.boolean(),
      on_current_space: z.boolean().nullable().optional(),
    }),
  ),
});

/** v0.30.4 list_windows supplies visibility across windows, including other displays. */
export function parseWindowObservations(result: {
  structuredContent?: unknown;
  isError?: boolean;
}): CuaObservation[] {
  const parsed = WindowListSchema.safeParse(result.structuredContent);
  if (result.isError === true || !parsed.success) {
    return [];
  }
  return parsed.data.windows.slice(0, maximumWindowObservations).map((window) => ({
    target: { pid: window.pid, window_id: window.window_id },
    scope: ObservationScope.WINDOW,
    category: ObservationCategory.WINDOW_VISIBILITY,
    fields: { is_visible: window.is_on_screen && window.on_current_space !== false },
    hasImage: false,
    hasText: false,
  }));
}

const maximumWindowObservations = 128;

const RefusalSchema = z.object({ status: z.literal('refused') });

export function isRefusedCuaResult(result: { structuredContent?: unknown }): boolean {
  return RefusalSchema.safeParse(result.structuredContent).success;
}
