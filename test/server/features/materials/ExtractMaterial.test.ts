import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { randomUUID } from 'node:crypto';
import { ExtractMaterial } from '../../../../src/server/features/materials/infrastructure/ExtractMaterial.js';
import { MaterialExtractorWorker } from '../../../../src/server/features/materials/infrastructure/MaterialExtractorWorker.js';
import type { MaterialSource } from '#contracts/ClassroomMaterials.js';

function source(name: string): MaterialSource {
  return { id: randomUUID(), name, bytes: 0, digest: '', url: null };
}

async function extract(name: string, bytes: Uint8Array) {
  const material = source(name);
  return new ExtractMaterial().extract(material, {
    id: material.id,
    classId: randomUUID(),
    name,
    bytes,
  });
}

function createPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['Setup first', 'Then practice'].map((text) => {
      const stream = `BT /F1 12 Tf 20 250 Td (${text}) Tj ET`;
      return `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const start = pdf.length;
  pdf +=
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('');
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(start)}\n%%EOF`;
  return strToU8(pdf);
}

describe('material extraction boundaries', () => {
  it('retains every PDF page in order with visual-review warnings', async () => {
    const pages = await extract('Slides.pdf', createPdf());
    expect(pages.map((page) => page.location)).toEqual(['Page 1', 'Page 2']);
    expect(pages[0]?.extractedText).toContain('Setup first');
    expect(pages[1]?.extractedText).toContain('Then practice');
    expect(pages[0]?.warnings.length).toBeGreaterThan(0);
  });
  it('retains slide text and speaker notes without executing XML entities', async () => {
    const bytes = zipSync({
      'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>Move</a:t><a:t>10 steps</a:t></p:sld>'),
      'ppt/notesSlides/notesSlide1.xml': strToU8(
        '<p:notes><a:t>Attach start event</a:t></p:notes>',
      ),
    });
    expect((await extract('Slides.pptx', bytes))[0]?.extractedText).toContain('Attach start event');
    await expect(
      extract(
        'Unsafe.pptx',
        zipSync({
          'ppt/slides/slide1.xml': strToU8(
            '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><a:t>&a;</a:t>',
          ),
        }),
      ),
    ).rejects.toThrow();
  });
  it('retains Scratch graph connectivity and ignores executable-looking archive paths', async () => {
    const blocks = {
      trigger: { opcode: 'event_whenflagclicked', next: 'move' },
      move: { opcode: 'motion_movesteps', parent: 'trigger', inputs: { STEPS: [1, [4, '10']] } },
    };
    const bytes = zipSync({
      'project.json': strToU8(
        JSON.stringify({ targets: [{ name: 'Cat', isStage: false, blocks }] }),
      ),
      '../Run.py': strToU8('raise Exception("must never run")'),
    });
    const pages = await extract('Starter.sb3', bytes);
    expect(pages[0]?.extractedText).toContain('event_whenflagclicked');
    expect(pages[0]?.extractedText).toContain('"parent": "trigger"');
    expect(pages).toHaveLength(1);
  });
  it('rejects oversized expanded entries and unsupported files instead of truncating them', async () => {
    await expect(
      extract('Huge.sb3', zipSync({ 'project.json': strToU8('x'.repeat(1_000_001)) })),
    ).rejects.toThrow();
    await expect(extract('Unknown.exe', strToU8('payload'))).rejects.toThrow();
    await expect(extract('Invalid.py', new Uint8Array([255]))).rejects.toThrow();
    const pages = await extract(
      'Code.py',
      strToU8('raise Exception("this is source, not executed")'),
    );
    expect(pages[0]?.extractedText).toContain('raise Exception');
  });
  it('isolates parsing in a bounded worker and keeps links as unfetched references', async () => {
    const material = source('Code.py');
    const pages = await new MaterialExtractorWorker().extract(material, {
      id: material.id,
      classId: randomUUID(),
      name: material.name,
      bytes: strToU8('print("Hi")'),
    });
    expect(pages[0]?.extractedText).toBe('print("Hi")');
    const linkPages = await new ExtractMaterial().extract(
      { ...source('Video'), url: 'https://youtube.com/watch?v=example' },
      null,
    );
    expect(linkPages[0]?.warnings[0]).toContain('not been fetched');
  }, 35_000);
});
