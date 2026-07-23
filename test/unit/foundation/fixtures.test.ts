import { TextDecoder } from 'node:util';

import { describe, expect, test } from 'vitest';

import { buildGraphPayload } from '../../../src/core/graph/index.js';
import type { Concept } from '../../../src/core/model/index.js';
import { conceptIdFromBundlePath, parseBundle } from '../../../src/core/parser/index.js';
import { validateBundle } from '../../../src/core/validation/index.js';
import {
  listFixtureNames,
  loadFixture,
  readFixtureFiles,
  type FixtureExpectedContract,
} from '../../helpers/fixtures.js';

const expectedFixtureNames = [
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

function requireBytes(value: Uint8Array | undefined, path: string): Uint8Array {
  if (value === undefined) {
    throw new Error(`Fixture file was not materialized: ${path}`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fixtureFileUri(rootUri: string, path: string): string {
  return `${rootUri}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function requireFixturePath(pathByUri: ReadonlyMap<string, string>, uri: string): string {
  const path = pathByUri.get(uri);
  if (path === undefined) {
    throw new Error(`Parser or validator returned an unknown fixture URI: ${uri}`);
  }
  return path;
}

function requireConcept(
  concepts: readonly Concept[],
  conceptId: string,
  fixtureName: string,
): Concept {
  const concept = concepts.find(({ id }) => id === conceptId);
  if (concept === undefined) {
    throw new Error(
      `Fixture ${fixtureName} expected frontmatter for missing concept ${conceptId}.`,
    );
  }
  return concept;
}

function asPlainJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

interface FixtureGraphProjection {
  readonly nodeIds: readonly string[];
  readonly edges: readonly {
    readonly sourceId: string;
    readonly targetId: string;
  }[];
  readonly orphanIds: readonly string[];
  readonly backlinks: Readonly<Record<string, readonly string[]>>;
  readonly brokenLinks: readonly {
    readonly sourceId: string;
    readonly rawTarget: string;
  }[];
  readonly statistics: {
    readonly conceptCount: number;
    readonly edgeCount: number;
    readonly orphanCount: number;
    readonly brokenLinkCount: number;
  };
}

function expectedGraphProjection(expected: FixtureExpectedContract): FixtureGraphProjection {
  const edges = expected.links.flatMap((link) =>
    link.kind === 'internal' && link.targetId !== undefined
      ? [{ sourceId: link.sourceId, targetId: link.targetId }]
      : [],
  );
  const connectedIds = new Set(edges.flatMap(({ sourceId, targetId }) => [sourceId, targetId]));
  const backlinkSets = new Map(
    expected.conceptIds.map((conceptId) => [conceptId, new Set<string>()]),
  );
  for (const { sourceId, targetId } of edges) {
    backlinkSets.get(targetId)?.add(sourceId);
  }

  const failedConceptIds = new Set(
    expected.parseFailures
      .map(({ path }) => conceptIdFromBundlePath(path))
      .filter((conceptId): conceptId is string => conceptId !== undefined),
  );
  const orphanIds = expected.conceptIds.filter(
    (conceptId) => !connectedIds.has(conceptId) && !failedConceptIds.has(conceptId),
  );
  const brokenLinks = expected.links.flatMap((link) =>
    link.kind === 'broken' ? [{ sourceId: link.sourceId, rawTarget: link.rawTarget }] : [],
  );

  return {
    nodeIds: expected.conceptIds,
    edges,
    orphanIds,
    backlinks: Object.fromEntries(
      expected.conceptIds.map((conceptId) => [
        conceptId,
        [...(backlinkSets.get(conceptId) ?? [])].sort(compareText),
      ]),
    ),
    brokenLinks,
    statistics: {
      conceptCount: expected.conceptIds.length,
      edgeCount: edges.length,
      orphanCount: orphanIds.length,
      brokenLinkCount: brokenLinks.length,
    },
  };
}

async function evaluateFixture(name: string): Promise<{
  readonly actual: FixtureExpectedContract;
  readonly expected: FixtureExpectedContract;
  readonly actualGraph: FixtureGraphProjection;
  readonly expectedGraph: FixtureGraphProjection;
}> {
  const fixture = await loadFixture(name);
  const files = await readFixtureFiles(fixture);
  const entries = [...files.entries()].sort(([left], [right]) => compareText(left, right));
  const rootUri = `fixture:/${encodeURIComponent(name)}`;
  const uriByPath = new Map(
    entries.map(([path]) => [path, fixtureFileUri(rootUri, path)] as const),
  );
  const pathByUri = new Map([...uriByPath].map(([path, uri]) => [uri, path] as const));
  const bundle = parseBundle({
    rootUri,
    revision: 1,
    documents: entries.map(([bundlePath, content]) => ({
      bundlePath,
      content,
      uri: uriByPath.get(bundlePath) ?? fixtureFileUri(rootUri, bundlePath),
    })),
  });
  const findings = validateBundle(bundle, { now: '2026-07-22T12:00:00Z' });
  const graph = buildGraphPayload(bundle);
  const expected = fixture.manifest.expected;

  const actual: FixtureExpectedContract = {
    conceptIds: bundle.concepts.map(({ id }) => id),
    reservedFiles: bundle.reservedDocuments.map(({ source }) => source.bundlePath),
    parseFailures: bundle.failures.map(({ uri, reason }) => ({
      path: requireFixturePath(pathByUri, uri),
      reason,
    })),
    findings: findings.map(({ uri, category, code }) => ({
      category,
      code,
      path: requireFixturePath(pathByUri, uri),
    })),
    links: bundle.concepts.flatMap(({ links }) =>
      links.map(({ sourceId, rawTarget, classification, targetId, fragment, query }) => ({
        sourceId,
        rawTarget,
        kind: classification,
        ...(targetId === undefined ? {} : { targetId }),
        ...(fragment === undefined ? {} : { fragment }),
        ...(query === undefined ? {} : { query }),
      })),
    ),
    ...(expected.frontmatterByConceptId === undefined
      ? {}
      : {
          frontmatterByConceptId: Object.fromEntries(
            Object.keys(expected.frontmatterByConceptId).map((conceptId) => [
              conceptId,
              asPlainJson(requireConcept(bundle.concepts, conceptId, name).frontmatter.raw),
            ]),
          ) as Readonly<Record<string, Readonly<Record<string, unknown>>>>,
        }),
    ...(expected.pathCases === undefined
      ? {}
      : {
          pathCases: expected.pathCases.map(({ input }) => ({
            input,
            normalizedConceptId: conceptIdFromBundlePath(input) ?? '<invalid>',
          })),
        }),
  };

  return {
    actual: asPlainJson(actual) as FixtureExpectedContract,
    expected: asPlainJson(expected) as FixtureExpectedContract,
    actualGraph: asPlainJson({
      nodeIds: graph.nodes.map(({ id }) => id),
      edges: graph.edges.map(({ source, target }) => ({ sourceId: source, targetId: target })),
      orphanIds: graph.nodes.filter(({ orphan }) => orphan).map(({ id }) => id),
      backlinks: graph.backlinks,
      brokenLinks: graph.brokenLinks.map(({ sourceId, rawTarget }) => ({ sourceId, rawTarget })),
      statistics: {
        conceptCount: graph.statistics.conceptCount,
        edgeCount: graph.statistics.edgeCount,
        orphanCount: graph.statistics.orphanCount,
        brokenLinkCount: graph.statistics.brokenLinkCount,
      },
    }) as FixtureGraphProjection,
    expectedGraph: asPlainJson(expectedGraphProjection(expected)) as FixtureGraphProjection,
  };
}

describe('canonical fixture corpus', () => {
  test('has the complete documented corpus', async () => {
    await expect(listFixtureNames()).resolves.toEqual(expectedFixtureNames);
  });

  test.each(expectedFixtureNames)('%s loads every declared file as bytes', async (name) => {
    const fixture = await loadFixture(name);
    const files = await readFixtureFiles(fixture);
    const declaredPaths = [
      ...fixture.manifest.files,
      ...fixture.manifest.virtualFiles.map(({ path }) => path),
    ].sort();

    expect([...files.keys()].sort()).toEqual(declaredPaths);
    expect(fixture.manifest.name).toBe(name);
    expect(fixture.manifest.description).not.toHaveLength(0);
  });

  test.each(expectedFixtureNames)(
    '%s exactly matches its parser, validator, and graph contract',
    async (name) => {
      const { actual, expected, actualGraph, expectedGraph } = await evaluateFixture(name);
      expect(actual).toEqual(expected);
      expect(actualGraph).toEqual(expectedGraph);
    },
  );

  test('materializes invalid UTF-8 without blocking valid files', async () => {
    const fixture = await loadFixture('invalid-documents');
    const files = await readFixtureFiles(fixture);
    const invalidBytes = requireBytes(files.get('invalid-utf8.md'), 'invalid-utf8.md');
    const validBytes = requireBytes(files.get('valid.md'), 'valid.md');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(invalidBytes)).toThrow();
    expect(new TextDecoder('utf-8', { fatal: true }).decode(validBytes)).toContain('type: concept');
  });
});
