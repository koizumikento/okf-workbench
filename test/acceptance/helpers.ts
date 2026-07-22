import type { OperationResult, ParsedBundle } from '../../src/core/model/index.js';
import { parseBundle, type BundleDocumentInput } from '../../src/core/parser/index.js';

export const ACCEPTANCE_ROOT_URI = 'memfs:/workspace/knowledge';
export const ACCEPTANCE_NOW = '2026-07-22T12:00:00Z';

export interface AcceptanceDocument {
  readonly bundlePath: string;
  readonly content: string;
}

export function valueOf<T>(result: OperationResult<T>): T {
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.value;
}

export function rootIndex(content = '# Knowledge\n'): AcceptanceDocument {
  return {
    bundlePath: 'index.md',
    content: `---\nokf_version: "0.1"\n---\n${content}`,
  };
}

export function acceptanceDocument(bundlePath: string, content: string): AcceptanceDocument {
  return { bundlePath, content };
}

export function parseAcceptanceBundle(
  revision: number,
  documents: readonly AcceptanceDocument[],
): ParsedBundle {
  const inputs: BundleDocumentInput[] = documents.map((document) => ({
    uri: `${ACCEPTANCE_ROOT_URI}/${encodeURI(document.bundlePath)}`,
    bundlePath: document.bundlePath,
    content: document.content,
  }));
  return parseBundle({ rootUri: ACCEPTANCE_ROOT_URI, revision, documents: inputs });
}

export function conceptDocument(input: {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly additionalFrontmatter?: string;
  readonly body?: string;
}): string {
  const tags = input.tags === undefined ? '' : `tags: ${JSON.stringify(input.tags)}\n`;
  const additional = input.additionalFrontmatter ?? '';
  return (
    `---\ntype: ${input.type}\ntitle: ${input.title}\ndescription: ${input.description}\n` +
    `${tags}${additional}---\n${input.body ?? ''}`
  );
}
