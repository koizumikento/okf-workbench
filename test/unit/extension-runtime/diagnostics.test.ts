import { describe, expect, it } from 'vitest';

import type { Finding, SourceRange } from '../../../src/core/model/index.js';
import {
  findingToDiagnostic,
  type FindingDiagnostic,
} from '../../../src/extension/diagnostics/findingDiagnostic.js';
import {
  FindingDiagnosticsPublisher,
  type DiagnosticCollectionPort,
} from '../../../src/extension/diagnostics/publisher.js';

const range: SourceRange = {
  start: { offset: 4, line: 1, character: 1 },
  end: { offset: 8, line: 1, character: 5 },
};

describe('finding diagnostics', () => {
  it('preserves precise ranges and visibly distinguishes finding categories', () => {
    const conformance: Finding = {
      category: 'conformance',
      severity: 'error',
      code: 'okf.conformance.frontmatter',
      uri: 'memfs://bundle/broken.md',
      range,
      message: 'OKF conformance: YAML is invalid.',
      correctiveAction: 'Repair the frontmatter.',
    };
    const curation: Finding = {
      category: 'curation',
      severity: 'warning',
      code: 'okf.curation.broken-link',
      uri: 'memfs://bundle/source.md',
      message: 'OKF curation: a link is broken.',
    };

    expect(findingToDiagnostic(conformance)).toEqual({
      uri: conformance.uri,
      range,
      severity: 'error',
      source: 'OKF Conformance',
      code: conformance.code,
      message: 'OKF conformance: YAML is invalid. Next step: Repair the frontmatter.',
    });
    expect(findingToDiagnostic(curation)).toMatchObject({
      severity: 'warning',
      source: 'OKF Curation',
      range: undefined,
    });
  });

  it('clears stale entries and omits orphan state from editor diagnostics', () => {
    class FakeCollection implements DiagnosticCollectionPort<string, FindingDiagnostic> {
      public clearCount = 0;
      public readonly values = new Map<string, readonly FindingDiagnostic[]>();

      public clear(): void {
        this.clearCount += 1;
        this.values.clear();
      }

      public set(uri: string, diagnostics: readonly FindingDiagnostic[]): void {
        this.values.set(uri, diagnostics);
      }
    }

    const collection = new FakeCollection();
    collection.values.set('memfs://bundle/stale.md', []);
    const publisher = new FindingDiagnosticsPublisher(
      collection,
      (uri) => uri,
      (diagnostic) => diagnostic,
    );
    publisher.replace([
      {
        category: 'compatibility',
        severity: 'information',
        code: 'okf.compatibility.future-minor-version',
        uri: 'memfs://bundle/index.md',
        message: 'OKF compatibility: a future minor version is declared.',
      },
      {
        category: 'curation',
        severity: 'warning',
        code: 'okf.curation.orphan-concept',
        uri: 'memfs://bundle/isolated.md',
        message: 'OKF curation: this concept is isolated.',
      },
      {
        category: 'curation',
        severity: 'warning',
        code: 'okf.curation.missing-description',
        uri: 'memfs://bundle/concept.md',
        message: 'OKF curation: this concept is missing a description.',
      },
    ]);

    expect(collection.clearCount).toBe(1);
    expect(collection.values.has('memfs://bundle/stale.md')).toBe(false);
    expect(collection.values.has('memfs://bundle/isolated.md')).toBe(false);
    expect([...collection.values.keys()]).toEqual([
      'memfs://bundle/concept.md',
      'memfs://bundle/index.md',
    ]);
    expect(collection.values.get('memfs://bundle/concept.md')).toEqual([
      expect.objectContaining({ code: 'okf.curation.missing-description' }),
    ]);
  });
});
