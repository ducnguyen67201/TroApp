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

  it('prepares cached Electron headers before any signing credentials are installed', () => {
    const preparation = 'run: pnpm exec tsx scripts/PrepareElectronHeaders.ts';
    expect(workflow).toContain(preparation);
    expect(workflow.indexOf(preparation)).toBeLessThan(
      workflow.indexOf('      - name: Install temporary signing credentials'),
    );
    const cache =
      workflow
        .split('      - name: Restore Electron header cache\n')
        .at(1)
        ?.split('      - name:')
        .at(0) ?? '';
    expect(cache).toContain('path: ~/.electron-gyp\n');
    expect(cache).toContain(
      "${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml') }}",
    );
    expect(cache).not.toContain('restore-keys:');
    expect(cache).not.toContain('release/');
    expect(cache).not.toContain('keychain');
    const signing = readFileSync(new URL('../../scripts/MacSigning.ts', import.meta.url), 'utf8');
    expect(signing).toContain('buildDependenciesFromSource: true');
  });
});

describe('shared desktop release validation', () => {
  const desktopWorkflow = readFileSync(
    new URL('../../.github/workflows/DesktopRelease.yml', import.meta.url),
    'utf8',
  );
  const validation =
    desktopWorkflow.split('\n  validate:\n').at(1)?.split('\n  windows:').at(0) ?? '';

  it('validates the reserved source and version once before either platform can sign', () => {
    expect(validation).toContain('    needs: prepare\n');
    expect(validation).toContain('ref: ${{ needs.prepare.outputs.commit }}');
    expect(validation).toContain(
      'TRO_DESKTOP_RELEASE_VERSION: ${{ needs.prepare.outputs.version }}',
    );
    expect(validation).toContain('scripts/ApplyDesktopReleaseVersion.ts');
    expect(validation).not.toContain('secrets.');
    expect(validation).not.toContain('contents: write');
    for (const platform of ['windows', 'macos']) {
      expect(desktopWorkflow).toContain(`  ${platform}:\n    needs: [prepare, validate]\n`);
    }
    for (const command of [
      'pnpm lint',
      'pnpm format:check',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm test:integration',
    ]) {
      expect(validation).toContain(`run: ${command}\n`);
      expect(desktopWorkflow.split(`run: ${command}\n`)).toHaveLength(2);
    }
  });

  it.each([
    { filename: 'MacRelease.yml', toolchain: '1.95.0', runner: '${{ matrix.runner }}' },
    { filename: 'WindowsRelease.yml', toolchain: '1.97.1', runner: 'windows-2022' },
  ])(
    'caches unsigned native compilation separately for $filename',
    ({ filename, toolchain, runner }) => {
      const workflow = readFileSync(
        new URL(`../../.github/workflows/${filename}`, import.meta.url),
        'utf8',
      );
      expect(workflow).not.toContain('  validate:\n');
      expect(workflow).not.toContain('run: pnpm typecheck');
      expect(workflow).not.toContain('run: pnpm test\n');
      expect(workflow).toContain("    if: github.ref == 'refs/heads/main'");
      const cache =
        workflow
          .split('      - name: Restore native build cache\n')
          .at(1)
          ?.split('      - name:')
          .at(0) ?? '';
      expect(cache).toContain('~/.cargo/registry');
      expect(cache).toContain('~/.cargo/git');
      expect(cache).toContain('~/.cache/tro/cua-companion-build');
      expect(cache).toContain(`\${{ runner.os }}-\${{ runner.arch }}-${runner}-rust-${toolchain}-`);
      for (const input of [
        'driver-patches/CursorCompanion.patch',
        'src/contracts/CuaCompanionBuild.ts',
        'scripts/BuildCuaCompanion.ts',
      ]) {
        expect(cache).toContain(input);
      }
      expect(cache).not.toContain('~/.cache/tro/cua-companion\n');
      expect(cache).not.toContain('release/');
      expect(cache).not.toContain('keychain');
      expect(workflow).toMatch(/^\s+(?:run: )?pnpm build:cua$/m);
      expect(workflow).toContain('pnpm package:desktop');
    },
  );

  it('reads the shared release environment update feed for both signed platform builds', () => {
    const feed = '${{ vars.MAIN_VITE_UPDATE_FEED_URL }}';
    for (const filename of ['MacRelease.yml', 'WindowsRelease.yml']) {
      const workflow = readFileSync(
        new URL(`../../.github/workflows/${filename}`, import.meta.url),
        'utf8',
      );
      expect(workflow).toContain(`MAIN_VITE_UPDATE_FEED_URL: ${feed}\n`);
      expect(workflow).not.toContain('releases/latest/download');
    }
    const packageScript = readFileSync(
      new URL('../../scripts/PrepareDesktopPackage.ts', import.meta.url),
      'utf8',
    );
    expect(packageScript).toContain("provider: 'generic', url: updateFeedUrl");
    const main = readFileSync(new URL('../../src/desktop/main/Main.ts', import.meta.url), 'utf8');
    expect(main).toContain("bundledUpdateUrl: import.meta.env['MAIN_VITE_UPDATE_FEED_URL']");
    expect(main).toContain('Boolean(environment.UPDATE_FEED_URL)');
  });
});

describe('shared desktop release publication boundaries', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/DesktopRelease.yml', import.meta.url),
    'utf8',
  );
  const publishing = workflow.split('\n  publish:').at(1) ?? '';

  it('publishes only after preparation and both reusable platform workflows succeed', () => {
    expect(publishing).toContain('    needs: [prepare, windows, macos]\n');
    expect(publishing).toContain("    if: github.ref == 'refs/heads/main'\n");
    expect(publishing).toContain('    environment: release\n');
    expect(publishing).toContain('      contents: write\n');
    expect(publishing).not.toContain('always()');
    expect(publishing).not.toContain('continue-on-error');
    expect(publishing).toContain('ref: ${{ needs.prepare.outputs.commit }}');
    expect(publishing).toContain('persist-credentials: false');
    expect(publishing).toContain(
      'TRO_DESKTOP_RELEASE_VERSION: ${{ needs.prepare.outputs.version }}',
    );
    expect(publishing).toContain('scripts/ApplyDesktopReleaseVersion.ts');
    expect(publishing).toContain(
      'pattern: Tro-${{ needs.prepare.outputs.version }}-*-${{ needs.prepare.outputs.commit }}-${{ github.run_id }}-*',
    );
    expect(publishing).toContain('merge-multiple: false');
    expect(publishing).toContain('scripts/PublishDesktopRelease.ts --directory verified-release');
    expect(publishing).toContain('GH_TOKEN: ${{ github.token }}');
    expect(publishing).not.toContain('CSC_LINK');
  });
});
