import { randomUUID } from 'node:crypto';
import { AsyncUnzipInflate, Unzip } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import {
  MaterialLimits,
  type MaterialPage,
  type MaterialSource,
} from '#contracts/ClassroomMaterials.js';
import type { MaterialExtractor, MaterialFile } from '../application/MaterialPreparation.js';

const textDecoder = new TextDecoder('utf-8', { fatal: true });
/** Files are read as data. ZIP entries are never written to disk or executed. */
export class ExtractMaterial implements MaterialExtractor {
  readonly version = 'source-units-v2';
  async extract(source: MaterialSource, file: MaterialFile | null): Promise<MaterialPage[]> {
    const page = (location: string, text: string, warnings: string[] = []): MaterialPage => ({
      id: randomUUID(),
      materialId: source.id,
      location,
      extractedText: text,
      preparedNote: '',
      teacherNote: null,
      warnings,
    });
    if (source.url) {
      return [
        page('Link', source.url, [
          'Link content has not been fetched. Add source files or teacher notes to explain it.',
        ]),
      ];
    }
    if (!file) {
      throw new Error('Material file missing.');
    }
    const extension = source.name.split('.').pop()?.toLowerCase();
    if (extension === 'pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loading = getDocument({
        data: new Uint8Array(file.bytes),
        useSystemFonts: false,
        verbosity: 0,
      });
      try {
        const pdf = await loading.promise;
        if (pdf.numPages > MaterialLimits.PAGE_COUNT) {
          throw new Error('Too many pages.');
        }
        const pages: MaterialPage[] = [];
        for (let index = 1; index <= pdf.numPages; index += 1) {
          const content = await (await pdf.getPage(index)).getTextContent();
          const text = content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('');
          pages.push(
            page(`Page ${String(index)}`, text, [
              'PDF text order and visual interpretation require review. Original PDF is retained.',
            ]),
          );
        }
        return pages;
      } finally {
        await loading.destroy();
      }
    }
    if (extension === 'sb3') {
      const entries = await readArchive(file.bytes, (name) => name === 'project.json');
      const raw = entries.get('project.json');
      if (!raw) {
        throw new Error('Scratch project is missing.');
      }
      const project: unknown = JSON.parse(textDecoder.decode(raw));
      const parsed = z
        .object({
          targets: z
            .array(
              z.looseObject({
                name: z.string(),
                isStage: z.boolean(),
                blocks: z.record(z.string(), z.unknown()),
                costumes: z.array(z.unknown()).optional(),
                sounds: z.array(z.unknown()).optional(),
                variables: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .min(1)
            .max(100),
          extensions: z.array(z.string()).optional(),
        })
        .parse(project);
      return parsed.targets.map((target) =>
        page(
          `${target.isStage ? 'Stage' : 'Sprite'}: ${target.name}`,
          JSON.stringify({ ...target, projectExtensions: parsed.extensions ?? [] }, null, 2),
          [
            'Block data and asset references retained; costume images and sounds are in the original project. No project code was executed.',
          ],
        ),
      );
    }
    if (extension === 'pptx') {
      const entries = await readArchive(
        file.bytes,
        (name) =>
          /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name) ||
          /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/_rels\/slide\d+\.xml\.rels)$/.test(
            name,
          ),
      );
      const slides = readSlideOrder(entries);
      if (!slides.length || slides.length > MaterialLimits.PAGE_COUNT) {
        throw new Error('Slide count invalid.');
      }
      return slides.map((name) => {
        const raw = entries.get(name);
        if (!raw) {
          throw new Error('Slide missing.');
        }
        const number = name.match(/\d+/)?.[0] ?? '';
        const notePath = readSlideNotesPath(entries, name);
        const notes = notePath ? entries.get(notePath) : undefined;
        return page(
          `Slide ${number}`,
          readXmlText(raw) + (notes ? `\nSpeaker notes:\n${readXmlText(notes)}` : ''),
          [
            'Text extracted; slide diagrams, layout and media require teacher review. Upload a PDF export for visual interpretation.',
          ],
        );
      });
    }
    if (extension && ['py', 'txt', 'md'].includes(extension)) {
      const text = textDecoder.decode(file.bytes);
      const lines = text.split('\n');
      const pages: MaterialPage[] = [];
      for (let offset = 0; offset < lines.length; offset += 150) {
        pages.push(
          page(
            `Lines ${String(offset + 1)}–${String(Math.min(offset + 150, lines.length))}`,
            lines.slice(offset, offset + 150).join('\n') +
              (offset + 150 < lines.length ? '\n' : ''),
          ),
        );
      }
      return pages;
    }
    throw new Error('Unsupported material.');
  }
}

function readXmlDocument(bytes: Uint8Array): unknown {
  const xml = textDecoder.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('XML declarations are not supported.');
  }
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: false,
  }).parse(xml);
  return parsed;
}

function readXmlChildren(value: unknown, name: string): unknown[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  const child: unknown = Object.entries(value).find(([key]) => key.split(':').pop() === name)?.[1];
  return child === undefined ? [] : Array.isArray(child) ? child : [child];
}

function readXmlAttribute(value: unknown, name: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const attribute: unknown = Object.entries(value).find(([key]) => key === `@_${name}`)?.[1];
  return typeof attribute === 'string' ? attribute : null;
}

function readSlideOrder(entries: Map<string, Uint8Array>): string[] {
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const presentation = entries.get('ppt/presentation.xml');
  const relationships = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presentation || !relationships) {
    return slides;
  }
  const items = readXmlChildren(
    readXmlChildren(readXmlDocument(presentation), 'presentation')[0],
    'sldIdLst',
  ).flatMap((value) => readXmlChildren(value, 'sldId'));
  const refs = readXmlChildren(readXmlDocument(relationships), 'Relationships').flatMap((value) =>
    readXmlChildren(value, 'Relationship'),
  );
  const ordered = items.map((item) => {
    const id = readXmlAttribute(item, 'r:id');
    const ref = refs.find((entry) => readXmlAttribute(entry, 'Id') === id);
    const target = readXmlAttribute(ref, 'Target');
    if (!target || !/^slides\/slide\d+\.xml$/.test(target)) {
      throw new Error('Slide relationship invalid.');
    }
    return `ppt/${target}`;
  });
  if (
    ordered.length !== slides.length ||
    new Set(ordered).size !== slides.length ||
    ordered.some((name) => !entries.has(name))
  ) {
    throw new Error('Slide order is incomplete.');
  }
  return ordered;
}

function readSlideNotesPath(entries: Map<string, Uint8Array>, slide: string): string | null {
  const relationships = entries.get(slide.replace('slides/', 'slides/_rels/') + '.rels');
  if (!relationships) {
    return `ppt/notesSlides/notesSlide${slide.match(/\d+/)?.[0] ?? ''}.xml`;
  }
  const refs = readXmlChildren(readXmlDocument(relationships), 'Relationships').flatMap((value) =>
    readXmlChildren(value, 'Relationship'),
  );
  const note = refs.find((ref) => readXmlAttribute(ref, 'Type')?.endsWith('/notesSlide'));
  const target = readXmlAttribute(note, 'Target');
  return target && /^\.\.\/notesSlides\/notesSlide\d+\.xml$/.test(target)
    ? `ppt/${target.slice(3)}`
    : null;
}

function readXmlText(bytes: Uint8Array): string {
  const xml = textDecoder.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('XML declarations are not supported.');
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    processEntities: false,
  });
  const document: unknown = parser.parse(xml);
  const output: string[] = [];

  function collect(value: unknown, key: string): void {
    if (typeof value === 'string' && key === 't') {
      output.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        collect(entry, key);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) {
        collect(child, childKey);
      }
    }
  }

  collect(document, '');
  return output.join('\n');
}

/** Asynchronous inflate workers enforce expanded-size limits even for forged ZIP headers. */
async function readArchive(
  bytes: Uint8Array,
  accepts: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  let expanded = 0;
  const tasks: Promise<void>[] = [];
  const terminators: (() => void)[] = [];
  let count = 0;
  const unzip = new Unzip((file) => {
    count += 1;
    if (count > 2000) {
      throw new Error('Too many ZIP entries.');
    }
    if (!accepts(file.name)) {
      return;
    }
    if (entries.has(file.name) || (file.originalSize ?? 0) > 1_000_000) {
      throw new Error('ZIP entry exceeds limits.');
    }
    entries.set(file.name, new Uint8Array());
    terminators.push(file.terminate);
    tasks.push(
      new Promise<void>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        file.ondata = (error, chunk, final) => {
          size += chunk.length;
          expanded += chunk.length;
          if (error || size > 1_000_000 || expanded > 4_000_000) {
            file.terminate();
            reject(new Error('ZIP extraction failed or exceeded limits.'));
            return;
          }
          chunks.push(chunk);
          if (final) {
            const output = new Uint8Array(size);
            let offset = 0;
            for (const part of chunks) {
              output.set(part, offset);
              offset += part.length;
            }
            entries.set(file.name, output);
            resolve();
          }
        };
        file.start();
      }),
    );
  });
  unzip.register(AsyncUnzipInflate);
  try {
    unzip.push(bytes, true);
    await Promise.all(tasks);
    return entries;
  } finally {
    for (const terminate of terminators) {
      terminate();
    }
  }
}
