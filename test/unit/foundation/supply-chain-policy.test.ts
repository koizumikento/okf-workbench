import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  EXPECTED_INSTALL_SCRIPT_DECISIONS,
  installScriptPolicyFailures,
  licenseNoticeWorkflowFailures,
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
