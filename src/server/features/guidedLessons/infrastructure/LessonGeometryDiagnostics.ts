import { LessonGeometrySchema, validateLessonGeometry } from './LessonRenderProtocol.js';

const MaximumDiagnosticMessages = 8;
const MaximumDiagnosticCharacters = 1000;

/** Explain canonical quality failures using only bounded measurement indexes and numbers, never source text. */
export function readLessonGeometryIssues(raw: unknown): string[] {
  try {
    validateLessonGeometry(raw);
    return [];
  } catch {
    /* The canonical validator remains the gate; diagnostic comparisons below cannot authorize a preview. */
  }

  const parsed = LessonGeometrySchema.safeParse(raw);
  if (!parsed.success) {
    return ['The preview geometry does not match the required finite numeric measurement schema.'];
  }
  const messages: string[] = [];
  let issueCount = 0;
  const addMessage = (message: string): void => {
    issueCount += 1;
    if (messages.length < MaximumDiagnosticMessages) {
      messages.push(message.slice(0, MaximumDiagnosticCharacters));
    }
  };
  for (const [index, box] of parsed.data.entries()) {
    const constraints: string[] = [];
    if (box.fontPx < 48) {
      constraints.push(`fontPx=${String(box.fontPx)} < minimumFontPx=48`);
    }
    if (box.x < -1 || box.y < -1 || box.x + box.width > 1921 || box.y + box.height > 1081) {
      constraints.push(
        `viewport bounds: left=${String(box.x)}, top=${String(box.y)}, right=${String(box.x + box.width)}, bottom=${String(box.y + box.height)}; allowed left/top >= -1 and right <= 1921, bottom <= 1081`,
      );
    }
    if (box.scrollWidth > box.clientWidth + 2) {
      constraints.push(
        `horizontal overflow: scrollWidth=${String(box.scrollWidth)} > clientWidth=${String(box.clientWidth)} + tolerancePx=2 (overflowPx=${String(box.scrollWidth - box.clientWidth)})`,
      );
    }
    if (box.scrollHeight > box.clientHeight + 2) {
      constraints.push(
        `vertical overflow: scrollHeight=${String(box.scrollHeight)} > clientHeight=${String(box.clientHeight)} + tolerancePx=2 (overflowPx=${String(box.scrollHeight - box.clientHeight)})`,
      );
    }
    if ((box.clippedWidth ?? 0) > 2) {
      constraints.push(
        `ancestor horizontal clipping: clippedWidth=${String(box.clippedWidth)} > tolerancePx=2`,
      );
    }
    if ((box.clippedHeight ?? 0) > 2) {
      constraints.push(
        `ancestor vertical clipping: clippedHeight=${String(box.clippedHeight)} > tolerancePx=2`,
      );
    }
    if (constraints.length !== 0) {
      addMessage(
        `measurement[${String(index)}]: ${constraints.join('; ')}. Measured box: fontPx=${String(box.fontPx)}, x=${String(box.x)}, y=${String(box.y)}, width=${String(box.width)}, height=${String(box.height)}, scrollWidth=${String(box.scrollWidth)}, clientWidth=${String(box.clientWidth)}, scrollHeight=${String(box.scrollHeight)}, clientHeight=${String(box.clientHeight)}.`,
      );
    }
    for (let secondIndex = index + 1; secondIndex < parsed.data.length; secondIndex += 1) {
      const second = parsed.data[secondIndex];
      if (!second) {
        continue;
      }
      const overlapWidth =
        Math.min(box.x + box.width, second.x + second.width) - Math.max(box.x, second.x);
      const overlapHeight =
        Math.min(box.y + box.height, second.y + second.height) - Math.max(box.y, second.y);
      if (overlapWidth > 2 && overlapHeight > 2) {
        addMessage(
          `measurement[${String(index)}] overlaps measurement[${String(secondIndex)}]: overlapWidth=${String(overlapWidth)}, overlapHeight=${String(overlapHeight)}; both exceed tolerancePx=2. First box: x=${String(box.x)}, y=${String(box.y)}, width=${String(box.width)}, height=${String(box.height)}. Second box: x=${String(second.x)}, y=${String(second.y)}, width=${String(second.width)}, height=${String(second.height)}. Move or resize the visible text regions to separate them.`,
        );
      }
    }
  }
  if (issueCount > messages.length) {
    messages.push(
      `${String(issueCount - messages.length)} additional measured layout failures omitted. Inspect the full measurements and repair every failure before encoding.`,
    );
  }
  return messages.length !== 0
    ? messages
    : [
        'The preview failed canonical layout quality. Inspect the supplied measurements and images.',
      ];
}
