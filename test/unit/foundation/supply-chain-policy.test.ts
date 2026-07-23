import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  EXPECTED_INSTALL_SCRIPT_DECISIONS,
  installScriptPolicyFailures,
  licenseNoticeWorkflowFailures,
  releaseWorkflowSafetyFailures,
  securityPackageScriptFailures,
  securityWorkflowGateFailures,
  validateRepositorySupplyChainPolicy,
  workflowActionReferenceFailures,
} from '../../../scripts/supply-chain-policy.mjs';

const fixtureRoot = new URL('./fixtures/', import.meta.url);

describe('supply-chain policy', () => {
  test('accepts the repository workflow and install-script governance', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

    await expect(validateRepositorySupplyChainPolicy(repositoryRoot)).resolves.toEqual({
      installScriptDecisionCount: Object.keys(EXPECTED_INSTALL_SCRIPT_DECISIONS).length,
      workflowCount: 4,
    });
  });

  test('rejects a mutable action tag from the negative workflow fixture', async () => {
    const source = await readFile(new URL('mutable-action-ref.yml', fixtureRoot), 'utf8');

    expect(workflowActionReferenceFailures('mutable-action-ref.yml', source)).toEqual([
      expect.stringContaining('actions/checkout@v6'),
      expect.stringContaining('actions/setup-node@main'),
    ]);
  });

  test('rejects an unknown dependency lifecycle script from the negative lock fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('unknown-install-script-policy.json', fixtureRoot), 'utf8'),
    ) as {
      readonly npmrc: string;
      readonly packageLock: Readonly<Record<string, unknown>>;
      readonly packageManifest: Readonly<Record<string, unknown>>;
    };

    expect(installScriptPolicyFailures(fixture)).toContain(
      'package-lock.json contains unreviewed install script unknown-native-helper@1.0.0.',
    );
  });

  test('requires the same post-install license and notice gate in CI and release workflows', () => {
    const missingGate = [
      'jobs:',
      '  quality-and-package:',
      '    steps:',
      '      - run: npm ci',
    ].join('\n');
    const gateBeforeInstall = [
      'jobs:',
      '  build-candidate:',
      '    steps:',
      '      - run: node scripts/security-check.mjs --check-notices',
      '      - run: npm ci',
    ].join('\n');

    expect(licenseNoticeWorkflowFailures('.github/workflows/ci.yml', missingGate)).toEqual([
      expect.stringContaining('exactly one canonical production license and notice gate'),
    ]);
    expect(
      licenseNoticeWorkflowFailures('.github/workflows/open-vsx-release.yml', gateBeforeInstall),
    ).toEqual([expect.stringContaining('after npm ci')]);
  });

  test('requires each hosted security boundary exactly once in its owning job', () => {
    const wrongCompatibilityJob = [
      'jobs:',
      '  candidate:',
      '    steps:',
      '      - run: npm run test:security:webview',
      '  acceptance:',
      '    steps:',
      '      - run: npm run test:security',
    ].join('\n');
    const duplicateCiGate = [
      'jobs:',
      '  quality-and-package:',
      '    steps:',
      '      - run: npm run test:security',
      '      - run: npm run test:security',
      '  webview-browser:',
      '    steps:',
      '      - run: npm run test:security:webview',
    ].join('\n');

    expect(
      securityWorkflowGateFailures('.github/workflows/compatibility.yml', wrongCompatibilityJob),
    ).toEqual([
      expect.stringContaining('jobs.candidate'),
      expect.stringContaining('jobs.acceptance'),
    ]);
    expect(securityWorkflowGateFailures('.github/workflows/ci.yml', duplicateCiGate)).toEqual([
      expect.stringContaining('found 2'),
    ]);
  });

  test('runs Node security in every Package smoke OS lane behind the browser security job', () => {
    const missingDependency = [
      'jobs:',
      '  security-boundaries:',
      '    steps:',
      '      - run: npm run test:security:webview',
      '  package-smoke:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-24.04, macos-15, windows-2025]',
      '    steps:',
      '      - run: npm run test:security',
      '      - run: npm run package',
    ].join('\n');

    expect(
      securityWorkflowGateFailures('.github/workflows/package-smoke.yml', missingDependency),
    ).toEqual([expect.stringContaining('must need security-boundaries')]);
  });

  test('rejects conditional or non-blocking hosted security gates', () => {
    const bypassablePackageSmoke = [
      'jobs:',
      '  security-boundaries:',
      '    steps:',
      '      - if: ${{ false }}',
      '        run: npm run test:security:webview',
      '  package-smoke:',
      '    needs: security-boundaries',
      '    steps:',
      '      - continue-on-error: true',
      '        run: npm run test:security',
    ].join('\n');

    expect(
      securityWorkflowGateFailures('.github/workflows/package-smoke.yml', bypassablePackageSmoke),
    ).toEqual([
      expect.stringContaining('test:security'),
      expect.stringContaining('test:security:webview'),
    ]);
  });

  test('requires durable pre-publication evidence before the irreversible Open VSX command', () => {
    const unsafeRelease = [
      'jobs:',
      '  publish:',
      '    steps:',
      '      - name: Verify',
      '        env:',
      '          OVSX_PAT: ${{ secrets.OVSX_PAT }}',
      '        run: ./node_modules/.bin/ovsx verify-pat straydog',
      '      - name: Create evidence',
      '        run: |',
      "          approvalBinding='matched'",
      "          namespaceAuthorization='passed'",
      "          output='prepublication-evidence.json'",
      '      - name: Publish',
      '        env:',
      '          OVSX_PAT: ${{ secrets.OVSX_PAT }}',
      '        run: ./node_modules/.bin/ovsx publish "${VSIX_NAME}"',
      '      - name: Too-late evidence',
      '        uses: actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '        with:',
      '          path: |',
      '            release-candidate/prepublication-evidence.json',
      '            release-candidate/open-vsx-registry-publish.json',
      '          if-no-files-found: error',
    ].join('\n');

    expect(
      releaseWorkflowSafetyFailures('.github/workflows/open-vsx-release.yml', unsafeRelease),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('before the irreversible publish command'),
        expect.stringContaining('post-publish artifact upload'),
        expect.stringContaining('publication-attempt receipt'),
      ]),
    );
  });

  test('rejects release-job error tolerance, bypassable PAT verification, and bracket secret leakage', async () => {
    const source = await readFile(
      new URL('../../../.github/workflows/open-vsx-release.yml', import.meta.url),
      'utf8',
    );
    expect(releaseWorkflowSafetyFailures('.github/workflows/open-vsx-release.yml', source)).toEqual(
      [],
    );

    const tolerantJob = source.replace(
      [
        '  publish:',
        '    name: Verify namespace and publish the retained VSIX',
        '    needs: build-candidate',
        '    runs-on: ubuntu-24.04',
      ].join('\n'),
      [
        '  publish:',
        '    name: Verify namespace and publish the retained VSIX',
        '    needs: build-candidate',
        '    runs-on: ubuntu-24.04',
        '    continue-on-error: true',
      ].join('\n'),
    );
    expect(
      releaseWorkflowSafetyFailures('.github/workflows/open-vsx-release.yml', tolerantJob),
    ).toContainEqual(expect.stringContaining('unconditional fail-closed protected job'));

    const bypassablePat = source.replace(
      '      - name: Verify straydog namespace authorization\n',
      '      - name: Verify straydog namespace authorization\n        continue-on-error: true\n',
    );
    expect(
      releaseWorkflowSafetyFailures('.github/workflows/open-vsx-release.yml', bypassablePat),
    ).toContainEqual(expect.stringContaining('PAT verification step'));

    const leakedBracketSecret = source.replace(
      '          APPROVAL: ${{ inputs.approval }}\n',
      [
        "          LEAKED_PAT: ${{ secrets['OVSX_PAT'] }}",
        '          APPROVAL: ${{ inputs.approval }}',
        '',
      ].join('\n'),
    );
    expect(
      releaseWorkflowSafetyFailures('.github/workflows/open-vsx-release.yml', leakedBracketSecret),
    ).toContainEqual(expect.stringContaining('OVSX_PAT must be exposed only'));

    const duplicatePublish = source.replace(
      '        run: ./node_modules/.bin/ovsx publish "${VSIX_NAME}"',
      [
        '        run: |',
        '          ./node_modules/.bin/ovsx publish other.vsix',
        '          ./node_modules/.bin/ovsx publish "${VSIX_NAME}"',
      ].join('\n'),
    );
    expect(
      releaseWorkflowSafetyFailures('.github/workflows/open-vsx-release.yml', duplicatePublish),
    ).toContainEqual(expect.stringContaining('exactly one Open VSX publish invocation'));
  });

  test('requires the local aggregate to build between the disjoint security suites', () => {
    const validScripts = {
      scripts: {
        check: 'npm run format && npm run test:security:all',
        'test:security': 'vitest run --config test/security/vitest.config.ts',
        'test:security:all':
          'npm run test:security && npm run build && npm run test:security:webview',
        'test:security:webview': 'playwright test --config test/security/playwright.config.ts',
      },
    };

    expect(securityPackageScriptFailures(validScripts)).toEqual([]);
    expect(
      securityPackageScriptFailures({
        scripts: {
          ...validScripts.scripts,
          check:
            'npm run test:security && npm run test:security:all && npm run test:security:webview',
          'test:security:all':
            'npm run test:security:webview && npm run build && npm run test:security',
        },
      }),
    ).toEqual([
      expect.stringContaining('exactly once and in that order'),
      expect.stringContaining('instead of duplicating'),
    ]);
  });

  test('requires strict npm enforcement and exact reviewed decisions', () => {
    const packageLock = {
      packages: Object.fromEntries(
        Object.keys(EXPECTED_INSTALL_SCRIPT_DECISIONS).map((identity) => {
          const separator = identity.lastIndexOf('@');
          const name = identity.slice(0, separator);
          const version = identity.slice(separator + 1);
          return [`node_modules/${name}`, { hasInstallScript: true, version }];
        }),
      ),
    };
    const failures = installScriptPolicyFailures({
      npmrc: 'strict-allow-scripts=false\n',
      packageManifest: {
        allowScripts: {
          ...EXPECTED_INSTALL_SCRIPT_DECISIONS,
          'new-helper@1.0.0': true,
        },
      },
      packageLock,
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('strict-allow-scripts=true'),
        'package.json allowScripts contains unreviewed entry new-helper@1.0.0.',
      ]),
    );
  });
});
