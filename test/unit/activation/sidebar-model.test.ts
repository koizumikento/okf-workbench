import { describe, expect, it } from 'vitest';

import type {
  Concept,
  Finding,
  GraphPayload,
  ParsedBundle,
  ParsedFrontmatter,
  ReservedDocument,
  SourceRange,
} from '../../../src/core/model/index.js';
import {
  buildSidebarBundleSummary,
  buildSidebarResourceTree,
  displayText,
} from '../../../src/extension/sidebar/model.js';

const range: SourceRange = {
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 1, line: 0, character: 1 },
};

function frontmatter(type: string, title?: string): ParsedFrontmatter {
  return {
    raw: { type, ...(title === undefined ? {} : { title }) },
    explicitTags: {},
    source: `type: ${type}`,
    range,
    fields: { type: range, ...(title === undefined ? {} : { title: range }) },
    normalized: { type, tags: [], ...(title === undefined ? {} : { title }) },
  };
}

function concept(id: string, bundlePath: string, type: string, title?: string): Concept {
  const uri = `okfmem://workspace/knowledge/${bundlePath}`;
  return {
    kind: 'concept',
    id,
    source: { uri, bundlePath, contentHash: `hash-${id}` },
    frontmatter: frontmatter(type, title),
    type,
    ...(title === undefined ? {} : { title }),
    tags: [],
    body: '',
    bodyRange: range,
    links: [],
  };
}

function reserved(bundlePath: string, reservedKind: 'index' | 'log'): ReservedDocument {
  return {
    kind: 'reserved',
    reservedKind,
    source: {
      uri: `okfmem://workspace/knowledge/${bundlePath}`,
      bundlePath,
      contentHash: `hash-${bundlePath}`,
    },
    body: '',
    bodyRange: range,
  };
}

const concepts = [
  concept('root', 'root.md', 'experiment-result', 'Root concept'),
  concept(
    'decisions/architecture',
    'decisions/architecture.md',
    'decision',
    ' Architecture\nDecision ',
  ),
  concept('metrics/latency', 'metrics/latency.md', 'metric'),
] as const;
const reservedDocuments = [
  reserved('index.md', 'index'),
  reserved('decisions/log.md', 'log'),
] as const;
const findings: readonly Finding[] = [
  {
    category: 'conformance',
    severity: 'error',
    code: 'invalid-frontmatter',
    uri: concepts[1].source.uri,
    message: 'Invalid frontmatter.',
  },
  {
    category: 'curation',
    severity: 'warning',
    code: 'broken-internal-link',
    uri: concepts[1].source.uri,
    message: 'Broken link.',
  },
  {
    category: 'curation',
    severity: 'warning',
    code: 'okf.curation.orphan-concept',
    uri: concepts[0].source.uri,
    message: 'Orphan.',
  },
  {
    category: 'compatibility',
    severity: 'warning',
    code: 'unsupported-version',
    uri: reservedDocuments[0].source.uri,
    message: 'Unsupported version.',
  },
];
const graph: GraphPayload = {
  protocolVersion: 1,
  revision: 4,
  nodes: [
    {
      id: 'root',
      type: 'experiment-result',
      title: 'Root concept',
      tags: [],
      orphan: true,
      brokenLinkCount: 0,
    },
    {
      id: 'decisions/architecture',
      type: 'decision',
      title: ' Architecture\nDecision ',
      tags: [],
      orphan: false,
      brokenLinkCount: 1,
    },
    {
      id: 'metrics/latency',
      type: 'metric',
      tags: [],
      orphan: false,
      brokenLinkCount: 0,
    },
  ],
  edges: [],
  backlinks: {},
  brokenLinks: [],
  statistics: {
    conceptCount: 3,
    edgeCount: 0,
    orphanCount: 1,
    brokenLinkCount: 1,
    typeCounts: { decision: 1, 'experiment-result': 1, metric: 1 },
    tagCounts: {},
  },
};
const bundle: ParsedBundle = {
  rootUri: 'okfmem://workspace/knowledge',
  revision: 4,
  concepts,
  reservedDocuments,
  failures: [],
  findings,
};

describe('sidebar presentation model', () => {
  it('summarizes actionable validation separately from orphan state', () => {
    expect(buildSidebarBundleSummary(bundle, findings, graph)).toEqual({
      conceptCount: 3,
      conformanceErrors: 1,
      curationWarnings: 1,
      orphanCount: 1,
    });
  });

  it('builds a deterministic folder-first resource tree without semantic folder nodes', () => {
    const tree = buildSidebarResourceTree(bundle, findings, graph);

    expect(tree.map((resource) => [resource.kind, resource.label])).toEqual([
      ['folder', 'decisions'],
      ['folder', 'metrics'],
      ['reserved', 'index.md'],
      ['concept', 'Root concept'],
    ]);

    const decisions = tree[0];
    expect(decisions).toMatchObject({
      kind: 'folder',
      relativePath: 'decisions',
      conceptCount: 1,
      conformanceErrors: 1,
      curationWarnings: 1,
    });
    if (decisions?.kind !== 'folder') {
      throw new Error('Expected the first resource to be the decisions folder.');
    }
    expect(decisions.children.map((resource) => [resource.kind, resource.label])).toEqual([
      ['concept', 'Architecture Decision'],
      ['reserved', 'log.md'],
    ]);
    expect(decisions.children[0]).toMatchObject({
      kind: 'concept',
      conceptId: 'decisions/architecture',
      type: 'decision',
      orphan: false,
    });

    const rootConcept = tree[3];
    expect(rootConcept).toMatchObject({
      kind: 'concept',
      conceptId: 'root',
      type: 'experiment-result',
      orphan: true,
      curationWarnings: 0,
    });
    expect(graph.nodes).toHaveLength(3);
  });

  it('compacts and bounds user-controlled labels without splitting code points', () => {
    expect(displayText('  Alpha\n\tBeta  ')).toBe('Alpha Beta');
    expect(displayText('')).toBeUndefined();
    expect(displayText(`${'a'.repeat(159)}😀tail`)).toBe(`${'a'.repeat(159)}…`);
  });
});
