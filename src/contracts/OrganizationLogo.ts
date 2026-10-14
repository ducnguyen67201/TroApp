import { z } from 'zod';

export const OrganizationLogoLimits = {
  SOURCE_BYTES: 2 * 1024 * 1024,
  SOURCE_PIXELS: 4096,
  PIXELS: 128,
  PNG_BYTES: 96 * 1024,
  DATA_URL_LENGTH: 22 + 128 * 1024,
  REQUEST_BYTES: 140_000,
} as const;

export const OrganizationLogoMediaType = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp',
} as const;

/** Only embedded raster PNGs are displayed; URLs and executable image formats are excluded. */
export const OrganizationLogoDataUrlSchema = z
  .string()
  .max(OrganizationLogoLimits.DATA_URL_LENGTH)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
