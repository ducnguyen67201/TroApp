import { z } from 'zod';

export const DesktopLocale = { VIETNAMESE: 'vi', ENGLISH: 'en' } as const;

export type DesktopLocale = (typeof DesktopLocale)[keyof typeof DesktopLocale];

export const DesktopLocaleSchema = z.enum(DesktopLocale);
