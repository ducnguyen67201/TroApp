import {
  OrganizationLogoDataUrlSchema,
  OrganizationLogoLimits,
  OrganizationLogoMediaType,
} from '#contracts/OrganizationLogo.js';

/** Local file bytes are reduced to a small static image before crossing the bridge. */
export async function prepareOrganizationLogo(file: File): Promise<string> {
  const isSupported = Object.values(OrganizationLogoMediaType).some((type) => type === file.type);
  if (!isSupported || file.size === 0 || file.size > OrganizationLogoLimits.SOURCE_BYTES) {
    throw new Error('Unsupported logo file');
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > OrganizationLogoLimits.SOURCE_PIXELS ||
      bitmap.height > OrganizationLogoLimits.SOURCE_PIXELS
    ) {
      throw new Error('Unsupported logo dimensions');
    }
    const canvas = document.createElement('canvas');
    canvas.width = OrganizationLogoLimits.PIXELS;
    canvas.height = OrganizationLogoLimits.PIXELS;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Logo preparation unavailable');
    }
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    );
    return OrganizationLogoDataUrlSchema.parse(canvas.toDataURL(OrganizationLogoMediaType.PNG));
  } finally {
    bitmap.close();
  }
}
