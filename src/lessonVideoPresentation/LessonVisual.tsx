import { createElement, type ReactElement } from 'react';
import type { LessonVisualNode } from '../contracts/LessonRenderProtocol.js';
import { LessonVisualRenderLimits } from '../contracts/LessonRenderProtocol.js';

/** SVG nodes are inert validated data, never generated JavaScript or raw HTML. */
export function LessonVisual({ node }: { node: LessonVisualNode }): ReactElement {
  return (
    <svg
      width={LessonVisualRenderLimits.WIDTH}
      height={350}
      viewBox={`0 0 ${String(LessonVisualRenderLimits.WIDTH)} ${String(LessonVisualRenderLimits.HEIGHT)}`}
      style={{ display: 'block', overflow: 'hidden' }}
    >
      {renderNode(node, 0)}
    </svg>
  );
}

function renderNode(node: LessonVisualNode, key: number): ReactElement {
  return createElement(
    node.tag,
    { ...node.attributes, key },
    ...node.children.map((child, index) =>
      typeof child === 'string' ? child : renderNode(child, index),
    ),
  );
}
