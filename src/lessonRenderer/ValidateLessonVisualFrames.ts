import {
  LessonVisualNodeSchema,
  LessonVisualRenderFailure,
  LessonVisualRenderLimits,
  type LessonVisualNode,
} from '../contracts/LessonRenderProtocol.js';
import { LessonVisualCodeError } from './CompileLessonVisual.js';

/** Reject active SVG, excessive recursion and oversized data before rendering. */
export function validateLessonVisualFrames(
  value: unknown,
  expectedFrames: number,
): LessonVisualNode[] {
  if (!Array.isArray(value) || value.length !== expectedFrames) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.OUTPUT,
      'The visual must produce one SVG tree per frame.',
    );
  }
  return value.map((frame: unknown) => {
    countNodes(frame, 0, { count: 0 });
    const parsed = LessonVisualNodeSchema.safeParse(frame);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LessonVisualCodeError(
        LessonVisualRenderFailure.OUTPUT,
        `Unsupported SVG output at ${issue?.path.map(String).join('.') ?? 'root'}. Use supported numeric attributes, safe colors and SVG elements.`,
      );
    }
    return parsed.data;
  });
}

function countNodes(value: unknown, depth: number, counter: { count: number }): void {
  counter.count += 1;
  if (
    depth > LessonVisualRenderLimits.TREE_DEPTH ||
    counter.count > LessonVisualRenderLimits.FRAME_NODES
  ) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.LIMIT,
      'The SVG tree exceeds the depth or node limit.',
    );
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'children' in value &&
    Array.isArray(value.children)
  ) {
    for (const child of value.children) {
      countNodes(child, depth + 1, counter);
    }
  }
}
