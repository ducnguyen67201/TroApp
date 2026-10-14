// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizationLogoLimits } from '#contracts/OrganizationLogo.js';
import { prepareOrganizationLogo } from '../../../../src/desktop/renderer/team/PrepareOrganizationLogo.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('rejects unsupported or oversized local files before decoding', async () => {
  const decode = vi.fn<typeof createImageBitmap>();
  vi.stubGlobal('createImageBitmap', decode);
  for (const file of [
    new File(['<svg />'], 'logo.svg', { type: 'image/svg+xml' }),
    new File([], 'empty.png', { type: 'image/png' }),
    new File([new Uint8Array(OrganizationLogoLimits.SOURCE_BYTES + 1)], 'large.png', {
      type: 'image/png',
    }),
  ]) {
    await expect(prepareOrganizationLogo(file)).rejects.toThrow();
  }
  expect(decode).not.toHaveBeenCalled();
});

it('closes oversized decoded images without drawing them', async () => {
  const close = vi.fn<() => void>();
  vi.stubGlobal(
    'createImageBitmap',
    vi
      .fn<typeof createImageBitmap>()
      .mockResolvedValue({ width: OrganizationLogoLimits.SOURCE_PIXELS + 1, height: 128, close }),
  );
  await expect(
    prepareOrganizationLogo(new File(['pixels'], 'logo.png', { type: 'image/png' })),
  ).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
});
