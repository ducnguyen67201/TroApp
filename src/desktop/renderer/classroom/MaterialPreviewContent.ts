import { MaterialLimits } from '#contracts/ClassroomMaterials.js';

export const MaterialPreviewKind = {
  PDF: 'pdf',
  TEXT: 'text',
  DOWNLOAD: 'download',
} as const;

export type MaterialPreviewKind = (typeof MaterialPreviewKind)[keyof typeof MaterialPreviewKind];

const textPreviewCharacters = 120_000;

export function readMaterialPreviewKind(name: string): MaterialPreviewKind {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') {
    return MaterialPreviewKind.PDF;
  }
  if (extension && ['py', 'txt', 'md'].includes(extension)) {
    return MaterialPreviewKind.TEXT;
  }
  return MaterialPreviewKind.DOWNLOAD;
}

/** Decodes a bounded original. HTML, Markdown and Python remain inert text. */
export function decodeMaterialPreview(data: string): Uint8Array {
  if (data.length > Math.ceil(MaterialLimits.FILE_BYTES / 3) * 4) {
    throw new Error('Material exceeds preview limit.');
  }
  const binary = atob(data);
  if (binary.length > MaterialLimits.FILE_BYTES) {
    throw new Error('Material exceeds preview limit.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function readMaterialTextPreview(bytes: Uint8Array): { text: string; truncated: boolean } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return {
    text: text.slice(0, textPreviewCharacters),
    truncated: text.length > textPreviewCharacters,
  };
}
