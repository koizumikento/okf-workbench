import { describe, expect, it } from 'vitest';

import type {
  ApplyReport,
  ChangeSetProposal,
  GraphPayload,
  JsonObject,
  OperationResult,
  ParsedBundle,
  SourceRange,
} from '../../../src/core/model/index.js';
import { YAML_TAGGED_VALUE_KEY } from '../../../src/core/parser/index.js';

const documentRange: SourceRange = {
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 150, line: 10, character: 0 },
};

function roundTrip<T>(value: T): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Expected a JSON-serializable model');
  }
  const parsed: unknown = JSON.parse(serialized);
  return parsed;
}

describe('serializable core models', () => {
  it('preserves representative bundle, graph, and write-operation fields', () => {
    const producerFields: JsonObject = {
      type: 'experiment-result',
      title: 'Unicode 知識',
      resource: 'urn:okf:experiment:unicode-result',
      tags: ['alpha', 'beta'],
      timestamp: '2026-07-22T09:30:00+09:00',
      custom: {
        enabled: true,
        threshold: 0.75,
        nested: [null, 'unchanged'],
      },
      tagged_timestamp: {
        [YAML_TAGGED_VALUE_KEY]: {
          tag: 'tag:yaml.org,2002:timestamp',
          value: '2001-12-15T02:59:43.100Z',
          source: '2001-12-15T02:59:43.1Z',
        },
      },
    };
    const bundle: ParsedBundle = {
      rootUri: 'vscode-remote://ssh-remote+host/workspace/knowledge',
      revision: 7,
      concepts: [
        {
          kind: 'concept',
          id: 'experiments/unicode-result',
          source: {
            uri: 'vscode-remote://ssh-remote+host/workspace/knowledge/experiments/unicode-result.md',
            bundlePath: 'experiments/unicode-result.md',
            contentHash: 'sha256:current',
          },
          frontmatter: {
            raw: producerFields,
            source:
              'type: experiment-result\ntitle: Unicode 知識\ntags: [alpha, beta]\ncustom:\n  enabled: true\n',
            range: documentRange,
            fields: { type: documentRange, custom: documentRange },
            normalized: {
              type: 'experiment-result',
              title: 'Unicode 知識',
              resource: 'urn:okf:experiment:unicode-result',
              tags: ['alpha', 'beta'],
              timestamp: '2026-07-22T09:30:00+09:00',
            },
          },
          type: 'experiment-result',
          title: 'Unicode 知識',
          resource: 'urn:okf:experiment:unicode-result',
          tags: ['alpha', 'beta'],
          timestamp: '2026-07-22T09:30:00+09:00',
          body: 'See [result](../results/final.md).',
          bodyRange: documentRange,
          links: [
            {
              sourceId: 'experiments/unicode-result',
              rawTarget: '../results/final.md',
              label: 'result',
              classification: 'internal',
              range: documentRange,
              targetId: 'results/final',
            },
          ],
        },
      ],
      reservedDocuments: [
        {
          kind: 'reserved',
          reservedKind: 'index',
          source: {
            uri: 'vscode-remote://ssh-remote+host/workspace/knowledge/index.md',
            bundlePath: 'index.md',
            contentHash: 'sha256:index',
          },
          body: '# Knowledge\n',
          bodyRange: documentRange,
          okfVersion: '0.1',
        },
      ],
      failures: [
        {
          kind: 'parse-failure',
          uri: 'vscode-remote://ssh-remote+host/workspace/knowledge/broken.md',
          bundlePath: 'broken.md',
          reason: 'frontmatter',
          message: 'YAML frontmatter is not parseable.',
          range: documentRange,
        },
      ],
      findings: [
        {
          category: 'conformance',
          severity: 'error',
          code: 'okf.frontmatter.invalid',
          uri: 'vscode-remote://ssh-remote+host/workspace/knowledge/broken.md',
          message: 'Fix the YAML frontmatter.',
          correctiveAction: 'Close the unterminated YAML sequence.',
          range: documentRange,
        },
        {
          category: 'curation',
          severity: 'warning',
          code: 'okf.link.broken',
          uri: 'vscode-remote://ssh-remote+host/workspace/knowledge/experiments/unicode-result.md',
          message: 'The linked concept does not exist.',
        },
      ],
    };
    const graph: GraphPayload = {
      protocolVersion: 1,
      revision: 7,
      nodes: [
        {
          id: 'experiments/unicode-result',
          type: 'experiment-result',
          title: 'Unicode 知識',
          resource: 'urn:okf:experiment:unicode-result',
          tags: ['alpha', 'beta'],
          timestamp: '2026-07-22T09:30:00+09:00',
          orphan: false,
          brokenLinkCount: 1,
        },
      ],
      edges: [
        {
          id: 'experiments/unicode-result->results/final#0',
          source: 'experiments/unicode-result',
          target: 'results/final',
          sourceRange: documentRange,
        },
      ],
      backlinks: { 'results/final': ['experiments/unicode-result'] },
      brokenLinks: [
        {
          sourceId: 'experiments/unicode-result',
          label: 'missing',
          rawTarget: './missing.md',
          sourceRange: documentRange,
        },
      ],
      statistics: {
        conceptCount: 2,
        edgeCount: 1,
        orphanCount: 0,
        brokenLinkCount: 1,
        typeCounts: { 'experiment-result': 1, reference: 1 },
        tagCounts: { alpha: 1, beta: 1 },
      },
    };
    const proposal: ChangeSetProposal = {
      operation: 'regenerate-indexes',
      writeRootUri: bundle.rootUri,
      changes: [
        {
          targetUri: `${bundle.rootUri}/index.md`,
          relativePath: 'index.md',
          operation: 'update',
          expected: { kind: 'sha256', value: 'current-index-hash' },
          encoding: 'utf8',
          proposedText: '# Knowledge\n\n<!-- managed -->\n',
        },
        {
          targetUri: `${bundle.rootUri}/nested/index.md`,
          relativePath: 'nested/index.md',
          operation: 'create',
          expected: { kind: 'absent' },
          encoding: 'utf8',
          proposedText: '# Nested\n',
        },
      ],
    };
    const applyReport: ApplyReport = {
      completed: [`${bundle.rootUri}/index.md`],
      failed: [
        {
          targetUri: `${bundle.rootUri}/nested/index.md`,
          code: 'content-changed',
          message: 'The target changed after preview.',
          retryable: true,
        },
      ],
      untouched: [`${bundle.rootUri}/later/index.md`],
    };

    expect(roundTrip(bundle)).toEqual(bundle);
    expect(roundTrip(graph)).toEqual(graph);
    expect(JSON.stringify(graph)).not.toContain(bundle.rootUri);
    expect(graph.nodes[0]).toMatchObject({
      resource: 'urn:okf:experiment:unicode-result',
      timestamp: '2026-07-22T09:30:00+09:00',
    });
    expect(roundTrip(proposal)).toEqual(proposal);
    expect(roundTrip(applyReport)).toEqual(applyReport);
  });

  it('represents expected parse and validation failures as discriminated data', () => {
    const result: OperationResult<ParsedBundle> = {
      ok: false,
      problems: [
        {
          code: 'okf.frontmatter.invalid',
          message: 'Unable to parse YAML frontmatter.',
          correctiveAction: 'Repair the YAML and validate again.',
          uri: 'file:///workspace/knowledge/broken.md',
          range: documentRange,
        },
      ],
    };

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected an operation failure');
    }
    expect(result.problems).toEqual([expect.objectContaining({ code: 'okf.frontmatter.invalid' })]);
    expect(roundTrip(result)).toEqual(result);
  });
});
