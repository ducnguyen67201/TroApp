import { useLayoutEffect, useState } from 'react';

interface AnchorGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OnboardingPosition {
  left: number;
  top: number;
  width: number;
  anchor: AnchorGeometry;
}

/** Follows the live navbar anchor across resize and scrolling; all coordinates are viewport CSS pixels. */
export function useOnboardingPosition(
  anchor: HTMLElement | null,
  modalRoot: HTMLElement | null,
): OnboardingPosition | null {
  const [position, setPosition] = useState<OnboardingPosition | null>(null);
  useLayoutEffect(() => {
    const panel = modalRoot?.querySelector('[data-modal-content]');
    if (!anchor || !(panel instanceof HTMLElement)) {
      setPosition(null);
      return;
    }

    function measurePosition(): void {
      if (!anchor || !(panel instanceof HTMLElement)) {
        return;
      }
      const rectangle = anchor.getBoundingClientRect();
      if (rectangle.width === 0 || rectangle.height === 0) {
        setPosition(null);
        return;
      }
      /* Mantine forwards Modal refs to its wrapper; the visible content owns height. */
      const width = Math.min(438, window.innerWidth - 32);
      const left = Math.max(16, Math.min(rectangle.right + 18, window.innerWidth - width - 16));
      const top = Math.max(
        16,
        Math.min(rectangle.top - 8, window.innerHeight - panel.offsetHeight - 16),
      );
      setPosition({
        left,
        top,
        width,
        anchor: {
          left: rectangle.left - 3,
          top: rectangle.top - 3,
          width: rectangle.width + 6,
          height: rectangle.height + 6,
        },
      });
    }

    anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    measurePosition();
    const observer = new ResizeObserver(measurePosition);
    observer.observe(anchor);
    observer.observe(panel);
    window.addEventListener('resize', measurePosition);
    window.addEventListener('scroll', measurePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measurePosition);
      window.removeEventListener('scroll', measurePosition, true);
    };
  }, [anchor, modalRoot]);
  return position;
}
