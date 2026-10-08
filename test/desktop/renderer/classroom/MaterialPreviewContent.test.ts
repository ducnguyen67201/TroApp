import { expect, it } from 'vitest';
import { MaterialLimits } from '#contracts/ClassroomMaterials.js';
import {
  decodeMaterialPreview,
  readMaterialPreviewKind,
  readMaterialTextPreview,
} from '../../../../src/desktop/renderer/classroom/MaterialPreviewContent.js';

it('recognizes extensions without executing or interpreting markup', () => {
  expect(readMaterialPreviewKind('Lesson.PDF')).toBe('pdf');
  expect(readMaterialPreviewKind('Lesson.py')).toBe('text');
  expect(readMaterialPreviewKind('Lesson.md')).toBe('text');
  expect(readMaterialPreviewKind('Lesson.sb3')).toBe('download');
  const text = '# Hello\n<script>danger()</script>\nXin chào';
  const bytes = new TextEncoder().encode(text);
  expect(readMaterialTextPreview(bytes)).toEqual({ text, truncated: false });
});

it('rejects invalid encodings and oversized original data and labels shortened text', () => {
  expect(() => decodeMaterialPreview('invalid@')).toThrow();
  expect(() =>
    decodeMaterialPreview('A'.repeat(Math.ceil(MaterialLimits.FILE_BYTES / 3) * 4 + 4)),
  ).toThrow();
  expect(() => readMaterialTextPreview(new Uint8Array([255]))).toThrow();
  const preview = readMaterialTextPreview(new TextEncoder().encode('a'.repeat(120_001)));
  expect(preview.truncated).toBe(true);
  expect(preview.text.length).toBe(120_000);
});
