/** Four concise instructions share a ten-second preview. */
export function readShotDuration(fps: number): number {
  return Math.round(2.5 * fps);
}
