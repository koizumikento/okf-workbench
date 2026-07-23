import { describe, expect, it } from 'vitest';

import { parseBundle } from '../../../src/core/parser/index.js';

const concept = (title: string, body = ''): string =>
  `---\ntype: concept\ntitle: ${title}\n---\n# ${title}\n${body}`;

describe('provider path identity', () => {
  it('keeps literal percent names distinct in concept IDs and one-decode Markdown links', () => {
    const bundle = parseBundle({
      rootUri: 'memfs://workspace/knowledge',
      revision: 1,
      documents: [
        {
          uri: 'memfs://workspace/knowledge/index.md',
          bundlePath: 'index.md',
          content: '---\nokf_version: "0.1"\n---\n# Knowledge\n',
        },
        {
          uri: 'memfs://workspace/knowledge/source.md',
          bundlePath: 'source.md',
          content: concept(
            'Source',
            [
              '[Literal encoded separator](./encoded%252Fsegment.md)',
              '[Actual nested separator](./encoded/segment.md)',
              '[Literal encoded space](./team%2520knowledge.md)',
              '[Actual space](./team%20knowledge.md)',
              '',
            ].join('\n'),
          ),
        },
        {
          uri: 'memfs://workspace/knowledge/encoded%252Fsegment.md',
          bundlePath: 'encoded%2Fsegment.md',
          content: concept('Literal encoded separator'),
        },
        {
          uri: 'memfs://workspace/knowledge/encoded/segment.md',
          bundlePath: 'encoded/segment.md',
          content: concept('Actual nested separator'),
        },
        {
          uri: 'memfs://workspace/knowledge/team%2520knowledge.md',
          bundlePath: 'team%20knowledge.md',
          content: concept('Literal encoded space'),
        },
        {
          uri: 'memfs://workspace/knowledge/team%20knowledge.md',
          bundlePath: 'team knowledge.md',
          content: concept('Actual space'),
        },
      ],
    });

    expect(bundle.failures).toEqual([]);
    expect(new Set(bundle.concepts.map(({ id }) => id))).toEqual(
      new Set([
        'source',
        'encoded%2Fsegment',
        'encoded/segment',
        'team%20knowledge',
        'team knowledge',
      ]),
    );
    const source = bundle.concepts.find(({ id }) => id === 'source');
    expect(
      source?.links.map(({ classification, targetId }) => ({ classification, targetId })),
    ).toEqual([
      { classification: 'internal', targetId: 'encoded%2Fsegment' },
      { classification: 'internal', targetId: 'encoded/segment' },
      { classification: 'internal', targetId: 'team%20knowledge' },
      { classification: 'internal', targetId: 'team knowledge' },
    ]);
  });
});
