import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@openai/agents';
import { TeachingCapture } from '../../../../src/desktop/worker/observation/TeachingCapture.js';

const metadata = {
  capture_id: 'original-capture',
  display: 'primary',
  screen_width: 1200,
  screen_height: 800,
  screenshot_width: 1200,
  screenshot_height: 800,
  scale_factor: 1,
};

function createCapture(): CallToolResult {
  return {
    content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
    structuredContent: metadata,
  };
}

describe('local renewal of every grounded teaching cue', () => {
  it('retains only the latest capture ID and safe options even for a quick model', () => {
    let nowMs = 0;
    const capture = new TeachingCapture(() => nowMs);
    capture.recordDesktopCapture(createCapture(), { max_image_dimension: 1200 });
    nowMs = 500;
    expect(capture.readPresentationCapture({ capture_id: 'original-capture' })).toEqual({
      captureId: 'original-capture',
      ageMs: 500,
      observationArgs: { max_image_dimension: 1200 },
    });
    nowMs = 6000;
    const request = capture.readPresentationCapture({ capture_id: 'original-capture' });
    expect(request?.ageMs).toBe(6000);
    expect(JSON.stringify(request)).not.toContain('aW1hZ2U=');
    expect(capture.readPresentationCapture({ capture_id: 'unobserved-capture' })).toBeNull();
    capture.reset();
    expect(capture.readPresentationCapture({ capture_id: 'original-capture' })).toBeNull();
  });

  it('rejects refused, missing and malformed capture sources', () => {
    const capture = new TeachingCapture();
    for (const invalid of [
      { ...createCapture(), isError: true },
      { content: [], structuredContent: metadata },
      { ...createCapture(), structuredContent: { ...metadata, display: 'external' } },
      { ...createCapture(), structuredContent: { ...metadata, scale_factor: 0 } },
    ] satisfies CallToolResult[]) {
      capture.recordDesktopCapture(invalid, {});
      expect(capture.readPresentationCapture({ capture_id: 'original-capture' })).toBeNull();
    }
  });
});
