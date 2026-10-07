import type { MaterialDraft, MaterialPage, MaterialSource } from '#contracts/ClassroomMaterials.js';

export interface MaterialFile {
  id: string;
  classId: string;
  name: string;
  bytes: Uint8Array;
}

export interface MaterialExtractor {
  readonly version?: string;
  extract(source: MaterialSource, file: MaterialFile | null): Promise<MaterialPage[]>;
}

export interface MaterialPreparation {
  readonly available: boolean;
  prepare(input: {
    classId?: string;
    collectionVersion?: number;
    jobId?: string;
    previousDraft?: MaterialDraft | null;
    revisionRequest?: string | null;
    extractionVersion?: string | null;
    pages: MaterialPage[];
    sources: MaterialSource[];
    files: MaterialFile[];
    teacherInstructions: string;
    locale: 'en' | 'vi';
  }): Promise<MaterialDraft>;
}
