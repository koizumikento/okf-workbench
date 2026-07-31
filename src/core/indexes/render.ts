import { encodeMarkdownPathSegment } from '../templates/path.js';

export const INDEX_START_MARKER = '<!-- okf-workbench:index:start -->';
export const INDEX_END_MARKER = '<!-- okf-workbench:index:end -->';

export interface IndexConceptEntry {
  readonly kind: 'concept';
  readonly filename: string;
  readonly title?: string;
  readonly description?: string;
}

export interface IndexDirectoryEntry {
  readonly kind: 'directory';
  readonly name: string;
}

export type IndexEntry = IndexConceptEntry | IndexDirectoryEntry;

function oneLine(value: string): string {
  return value
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function fallbackTitle(filename: string): string {
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
}

function renderEntry(entry: IndexEntry): string {
  if (entry.kind === 'directory') {
    const label = escapeLabel(oneLine(entry.name));
    return `- [${label}](./${encodeMarkdownPathSegment(entry.name)}/)`;
  }

  const candidateTitle = entry.title === undefined ? '' : oneLine(entry.title);
  const title = escapeLabel(
    candidateTitle.length === 0 ? fallbackTitle(entry.filename) : candidateTitle,
  );
  const path = encodeMarkdownPathSegment(entry.filename);
  const description = entry.description === undefined ? '' : oneLine(entry.description);
  return description.length === 0
    ? `- [${title}](./${path})`
    : `- [${title}](./${path}) - ${escapeLabel(description)}`;
}

export function renderManagedIndexRegion(entries: readonly IndexEntry[]): string {
  const lines = [
    INDEX_START_MARKER,
    '## Contents',
    '',
    ...entries.map(renderEntry),
    INDEX_END_MARKER,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderNewIndexDocument(
  directoryPath: string,
  entries: readonly IndexEntry[],
): string {
  const region = renderManagedIndexRegion(entries);
  if (directoryPath.length > 0) {
    return region;
  }

  return `---\nokf_version: "0.2"\n---\n${region}`;
}
