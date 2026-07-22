import type { OperationProblem, OperationResult } from '../model/index.js';

export interface ManagedRegionMarkers {
  readonly start: string;
  readonly end: string;
  readonly name: string;
}

export interface ManagedRegionMergeInput {
  readonly existingText: string;
  /** The complete replacement region, including both marker lines and a final LF. */
  readonly renderedRegion: string;
  readonly markers: ManagedRegionMarkers;
  readonly appendWhenMissing: boolean;
}

interface ScannedLine {
  readonly text: string;
  readonly start: number;
  readonly endIncludingNewline: number;
  readonly newline: '\n' | '\r\n' | '\r' | '';
}

function problem(
  code: string,
  markers: ManagedRegionMarkers,
  detail: string,
): OperationResult<never> {
  const item: OperationProblem = {
    code,
    message: `Cannot update the ${markers.name} managed region: ${detail}`,
    correctiveAction: `Keep exactly one ${markers.start} line followed by exactly one ${markers.end} line, or remove both markers before retrying.`,
  };
  return { ok: false, problems: [item] };
}

function scanLines(text: string): readonly ScannedLine[] {
  const lines: ScannedLine[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end += 1;
    }
    if (end === text.length) {
      const raw = text.slice(start, end);
      lines.push({
        text: raw,
        start,
        endIncludingNewline: text.length,
        newline: '',
      });
      return lines;
    }

    const crlf = text[end] === '\r' && text[end + 1] === '\n';
    const newline: '\n' | '\r\n' | '\r' = crlf ? '\r\n' : text[end] === '\r' ? '\r' : '\n';
    const next = end + (crlf ? 2 : 1);
    lines.push({
      text: text.slice(start, end),
      start,
      endIncludingNewline: next,
      newline,
    });
    start = next;
  }

  return lines;
}

function preferredNewline(text: string, startLine?: ScannedLine): '\n' | '\r\n' | '\r' {
  if (startLine !== undefined && startLine.newline !== '') {
    return startLine.newline;
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      return '\n';
    }
    if (text[index] === '\r') {
      return text[index + 1] === '\n' ? '\r\n' : '\r';
    }
  }

  return '\n';
}

function convertLf(text: string, newline: '\n' | '\r\n' | '\r'): string {
  const lf = text.replace(/\r\n?|\n/gu, '\n');
  return newline === '\n' ? lf : lf.replaceAll('\n', newline);
}

function appendRegion(existingText: string, renderedRegion: string): string {
  const newline = preferredNewline(existingText);
  const region = convertLf(renderedRegion, newline);
  if (existingText.length === 0) {
    return region;
  }

  const endsWithNewline = existingText.endsWith('\n') || existingText.endsWith('\r');
  const endsWithBlankLine =
    existingText.endsWith('\n\n') ||
    existingText.endsWith('\r\n\r\n') ||
    existingText.endsWith('\r\r');

  if (endsWithBlankLine) {
    return `${existingText}${region}`;
  }

  if (endsWithNewline) {
    return `${existingText}${newline}${region}`;
  }

  return `${existingText}${newline}${newline}${region}`;
}

/**
 * Replaces one valid marker pair without changing bytes outside it. Marker
 * matching is exact after splitting CR, LF, or CRLF line endings.
 */
export function mergeManagedRegion(input: ManagedRegionMergeInput): OperationResult<string> {
  const lines = scanLines(input.existingText);
  const starts = lines.filter((line) => line.text === input.markers.start);
  const ends = lines.filter((line) => line.text === input.markers.end);

  if (starts.length === 0 && ends.length === 0) {
    if (!input.appendWhenMissing) {
      return problem('managed-region-missing', input.markers, 'the required markers are missing');
    }

    return {
      ok: true,
      value: appendRegion(input.existingText, input.renderedRegion),
      warnings: [],
    };
  }

  if (starts.length !== 1 || ends.length !== 1) {
    const code =
      starts.length > 1 || ends.length > 1
        ? 'managed-region-duplicate-markers'
        : 'managed-region-incomplete-markers';
    return problem(
      code,
      input.markers,
      starts.length > 1 || ends.length > 1
        ? 'the marker pair is duplicated or nested'
        : 'only one marker from the pair is present',
    );
  }

  const startLine = starts[0];
  const endLine = ends[0];
  if (startLine === undefined || endLine === undefined || startLine.start >= endLine.start) {
    return problem(
      'managed-region-reversed-markers',
      input.markers,
      'the end marker appears before the start marker',
    );
  }

  const newline = preferredNewline(input.existingText, startLine);
  const region = convertLf(input.renderedRegion, newline);
  const prefix = input.existingText.slice(0, startLine.start);
  const suffix = input.existingText.slice(endLine.endIncludingNewline);
  return {
    ok: true,
    value: `${prefix}${region}${suffix}`,
    warnings: [],
  };
}
