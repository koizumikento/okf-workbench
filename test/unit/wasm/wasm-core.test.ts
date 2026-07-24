import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

import {
  createWasmOkfCore,
  typescriptOkfCore,
  type OkfCore,
} from '../../../src/core/wasm/index.js';
import {
  AGENT_SKILL_PATH,
  CONCEPT_TEMPLATES,
  renderAgentSkill,
  renderAgentsManagedBlock,
  renderBundlePreset,
  renderConceptTemplate,
} from '../../../src/core/templates/index.js';
import { loadFixture, readFixtureFiles } from '../../helpers/fixtures.js';

const fixtureNames = [
  'broken-links',
  'curation',
  'custom-metadata',
  'invalid-documents',
  'minimal-valid',
  'nested-links',
  'path-portability',
  'reserved-documents',
  'yaml-standard-tags',
];
let core: OkfCore;

beforeAll(() => {
  execFileSync(
    'cargo',
    [
      'build',
      '--locked',
      '--target',
      'wasm32-unknown-unknown',
      '--release',
      '--package',
      'okf-wasm',
    ],
    { stdio: 'pipe' },
  );
  core = createWasmOkfCore(
    readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm')),
  );
});

describe('Rust/Wasm core boundary', () => {
  test('is capability-free and reports the versioned ABI', () => {
    const bytes = readFileSync(resolve('target/wasm32-unknown-unknown/release/okf_wasm.wasm'));
    const module = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(core.abiVersion).toBe(1);
    expect(core.coreVersion).toBe('0.1.0');
  });

  test.each(fixtureNames)('%s preserves the canonical semantic projection', async (name) => {
    const fixture = await loadFixture(name);
    const files = await readFixtureFiles(fixture);
    const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
    const rootUri = `fixture:/${encodeURIComponent(name)}`;
    const pathByUri = new Map(
      entries.map(([path]) => [
        `${rootUri}/${path.split('/').map(encodeURIComponent).join('/')}`,
        path,
      ]),
    );
    const inspection = core.inspect(
      {
        rootUri,
        revision: 7,
        documents: entries.map(([bundlePath, content]) => ({
          bundlePath,
          content,
          uri: `${rootUri}/${bundlePath.split('/').map(encodeURIComponent).join('/')}`,
        })),
      },
      '2026-07-22T12:00:00Z',
    );
    const oracle = typescriptOkfCore.inspect(inputFor(entries, rootUri), '2026-07-22T12:00:00Z');

    expect(inspection).toEqual(oracle);

    expect(inspection.bundle.concepts.map(({ id }) => id)).toEqual(
      fixture.manifest.expected.conceptIds,
    );
    expect(inspection.bundle.reservedDocuments.map(({ source }) => source.bundlePath)).toEqual(
      fixture.manifest.expected.reservedFiles,
    );
    expect(
      inspection.bundle.failures.map(({ uri, reason }) => ({
        path: pathByUri.get(uri),
        reason,
      })),
    ).toEqual(fixture.manifest.expected.parseFailures);
    expect(
      inspection.findings.map(({ uri, category, code }) => ({
        category,
        code,
        path: pathByUri.get(uri),
      })),
    ).toEqual(fixture.manifest.expected.findings);
    expect(
      inspection.bundle.concepts.flatMap(({ links }) =>
        links.map(({ sourceId, rawTarget, classification, targetId, fragment, query }) => ({
          sourceId,
          rawTarget,
          kind: classification,
          ...(targetId === undefined ? {} : { targetId }),
          ...(fragment === undefined ? {} : { fragment }),
          ...(query === undefined ? {} : { query }),
        })),
      ),
    ).toEqual(fixture.manifest.expected.links);
    if (fixture.manifest.expected.frontmatterByConceptId !== undefined) {
      expect(
        Object.fromEntries(
          Object.keys(fixture.manifest.expected.frontmatterByConceptId).map((conceptId) => [
            conceptId,
            inspection.bundle.concepts.find(({ id }) => id === conceptId)?.frontmatter.raw,
          ]),
        ),
      ).toEqual(fixture.manifest.expected.frontmatterByConceptId);
    }
    expect(inspection.graph.revision).toBe(7);
    expect(inspection.graph.statistics.conceptCount).toBe(
      fixture.manifest.expected.conceptIds.length,
    );
  });

  test('rejects a corrupted module instead of falling back', () => {
    expect(() => createWasmOkfCore(Uint8Array.from([0, 1, 2]))).toThrow('not valid WebAssembly');
  });

  test.each(['minimal', 'software-project', 'data-analytics'] as const)(
    'bundle preset %s is byte-identical to the migration oracle',
    (preset) => {
      const timestamp = '2026-07-24T12:34:56Z';
      const oracle = renderBundlePreset({ preset, timestamp });
      if (!oracle.ok) throw new Error('TypeScript oracle refused a built-in preset.');
      expect(core.renderBundle(preset, timestamp)).toEqual(oracle.value);
    },
  );

  test.each(CONCEPT_TEMPLATES)(
    'concept template %s is byte-identical to the migration oracle',
    (template) => {
      const input = {
        template,
        relativePath: 'nested/example.md',
        type: 'custom-type',
        title: 'Example concept',
        description: 'A deterministic generated concept.',
        tags: ['one', '日本語'],
        timestamp: '2026-07-24T12:34:56Z',
      };
      const oracle = renderConceptTemplate(input);
      if (!oracle.ok) throw new Error('TypeScript oracle refused a built-in template.');
      expect(core.renderConcept(input)).toEqual(oracle.value);
    },
  );

  test('agent templates are byte-identical to the migration oracle', () => {
    const agents = renderAgentsManagedBlock('knowledge');
    const skill = renderAgentSkill('knowledge');
    if (!agents.ok || !skill.ok) throw new Error('TypeScript oracle refused agent templates.');
    expect(core.renderAgent('both', 'knowledge')).toEqual([
      { relativePath: 'AGENTS.md', encoding: 'utf8', content: agents.value },
      { relativePath: AGENT_SKILL_PATH, encoding: 'utf8', content: skill.value },
    ]);
  });

  test.each(fixtureNames)(
    '%s index rendering is byte-identical to the migration oracle',
    async (name) => {
      const fixture = await loadFixture(name);
      const files = await readFixtureFiles(fixture);
      const rootUri = `fixture:/${encodeURIComponent(name)}`;
      const input = {
        rootUri,
        revision: 1,
        documents: [...files.entries()].map(([bundlePath, content]) => ({
          bundlePath,
          content,
          uri: `${rootUri}/${bundlePath.split('/').map(encodeURIComponent).join('/')}`,
        })),
      };
      expect(core.renderIndexes(input, 'all')).toEqual(
        typescriptOkfCore.renderIndexes(input, 'all'),
      );
    },
  );
});

function inputFor(
  entries: readonly (readonly [string, string | Uint8Array])[],
  rootUri: string,
): {
  readonly rootUri: string;
  readonly revision: number;
  readonly documents: readonly {
    readonly bundlePath: string;
    readonly content: string | Uint8Array;
    readonly uri: string;
  }[];
} {
  return {
    rootUri,
    revision: 7,
    documents: entries.map(([bundlePath, content]) => ({
      bundlePath,
      content,
      uri: `${rootUri}/${bundlePath.split('/').map(encodeURIComponent).join('/')}`,
    })),
  };
}
