import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDesktopReleaseEnv } from '../../scripts/Env.js';

describe('desktop release settings', () => {
  it('matches production env-file settings and gives the shell precedence', () => {
    expect(
      readDesktopReleaseEnv(
        {},
        { MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/file/' },
      ).updateFeedUrl,
    ).toBe('https://downloads.example.test/file/');
    expect(
      readDesktopReleaseEnv(
        { MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/shell/' },
        { MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/file/' },
      ).updateFeedUrl,
    ).toBe('https://downloads.example.test/shell/');
    expect(readDesktopReleaseEnv({}).updateFeedUrl).toBeUndefined();
    expect(readDesktopReleaseEnv({ MAIN_VITE_UPDATE_FEED_URL: '' }).updateFeedUrl).toBeUndefined();
  });

  it('rejects an unsafe feed without including its value in the failure', () => {
    expect(() =>
      readDesktopReleaseEnv({
        MAIN_VITE_UPDATE_FEED_URL: 'http://private.example.test/?secret=value',
      }),
    ).toThrow('Desktop release configuration is invalid.');
  });
});

describe('macOS release credential boundaries', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/MacRelease.yml', import.meta.url),
    'utf8',
  );
  const credentialSetup =
    workflow
      .split('      - name: Install temporary signing credentials\n')
      .at(1)
      ?.split('      - name: ')
      .at(0) ?? '';
  const packaging =
    workflow
      .split('      - name: Package, notarize and verify distribution files\n')
      .at(1)
      ?.split('      - name: ')
      .at(0) ?? '';

  it('uses the main-only release environment with secrets confined to credential setup', () => {
    expect(workflow).toContain('    environment: release\n');
    expect(workflow).toContain("    if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('    needs: validate');
    for (const name of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
    ]) {
      const secretReference = `\${{ secrets.${name} }}`;
      expect(credentialSetup).toContain(secretReference);
      expect(workflow.replace(credentialSetup, '')).not.toContain(secretReference);
    }
    expect(workflow).toContain('run: pnpm build:cua');
    expect(workflow.indexOf('run: pnpm build:cua')).toBeLessThan(
      workflow.indexOf('      - name: Install temporary signing credentials'),
    );
  });

  it('uses the stored profile for both signing stages and always removes the keychain', () => {
    expect(credentialSetup).toContain(
      'xcrun notarytool store-credentials tro-ci-notary --keychain "$signing_keychain"',
    );
    expect(packaging).toContain('export APPLE_KEYCHAIN="$CSC_KEYCHAIN"');
    expect(packaging).toContain('export APPLE_KEYCHAIN_PROFILE=tro-ci-notary');
    expect(packaging).toContain('pnpm package:desktop');
    expect(packaging).toContain('scripts/VerifyMacRelease.ts --directory release');
    expect(packaging).not.toContain('secrets.');
    expect(packaging).not.toContain('APPLE_API_KEY');
    expect(workflow).not.toContain('AuthKey.p8');
    expect(credentialSetup).toContain(
      'security import "$credential_directory/DeveloperIDG2CA.cer" -t cert -k "$signing_keychain"',
    );
    expect(workflow).not.toContain('add-trusted-cert');
    expect(workflow).toContain(
      '      - name: Remove temporary signing credentials\n        if: always()',
    );
    expect(workflow).toContain('security delete-keychain');
    expect(workflow).not.toContain('contents: write');
  });
});
