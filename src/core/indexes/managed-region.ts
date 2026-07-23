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

type ManagedNewline = '\n' | '\r\n' | '\r';

interface MarkerLine {
  readonly start: number;
  readonly endIncludingNewline: number;
  readonly newline: ManagedNewline | '';
}

interface MarkerScan {
  readonly startCount: number;
  readonly endCount: number;
  readonly startLine?: MarkerLine;
  readonly endLine?: MarkerLine;
  readonly firstNewline?: ManagedNewline;
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

function scanMarkers(text: string, markers: ManagedRegionMarkers): MarkerScan {
  // A UTF-8 BOM decoded with `ignoreBOM: true` is represented as one leading
  // U+FEFF. It belongs to the file prefix, not to the first marker line. Keep
  // the original offset so replacement slicing preserves the BOM verbatim.
  let start = text.startsWith('\uFEFF') ? 1 : 0;
  let startCount = 0;
  let endCount = 0;
  let startLine: MarkerLine | undefined;
  let endLine: MarkerLine | undefined;
  let firstNewline: ManagedNewline | undefined;

  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end += 1;
    }

    const hasNewline = end < text.length;
    const crlf = hasNewline && text[end] === '\r' && text[end + 1] === '\n';
    const newline: ManagedNewline | '' = !hasNewline
      ? ''
      : crlf
        ? '\r\n'
        : text[end] === '\r'
          ? '\r'
          : '\n';
    const next = hasNewline ? end + (crlf ? 2 : 1) : text.length;
    if (firstNewline === undefined && newline !== '') {
      firstNewline = newline;
    }
    const line: MarkerLine = {
      start,
      endIncludingNewline: next,
      newline,
    };
    if (lineEquals(text, start, end, markers.start)) {
      startCount += 1;
      startLine ??= line;
    }
    if (lineEquals(text, start, end, markers.end)) {
      endCount += 1;
      endLine ??= line;
    }
    if (!hasNewline) {
      break;
    }
    start = next;
  }

  return {
    startCount,
    endCount,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(firstNewline === undefined ? {} : { firstNewline }),
  };
}

function lineEquals(text: string, start: number, end: number, marker: string): boolean {
  return end - start === marker.length && text.startsWith(marker, start);
}

function preferredNewline(scan: MarkerScan, startLine?: MarkerLine): ManagedNewline {
  if (startLine !== undefined && startLine.newline !== '') {
    return startLine.newline;
  }
  return scan.firstNewline ?? '\n';
}

function convertLf(text: string, newline: ManagedNewline): string {
  const lf = text.replace(/\r\n?|\n/gu, '\n');
  return newline === '\n' ? lf : lf.replaceAll('\n', newline);
}

function appendRegion(
  existingText: string,
  renderedRegion: string,
  newline: ManagedNewline,
): string {
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
  const scan = scanMarkers(input.existingText, input.markers);

  if (scan.startCount === 0 && scan.endCount === 0) {
    if (!input.appendWhenMissing) {
      return problem('managed-region-missing', input.markers, 'the required markers are missing');
    }

    return {
      ok: true,
      value: appendRegion(input.existingText, input.renderedRegion, preferredNewline(scan)),
      warnings: [],
    };
  }

  if (scan.startCount !== 1 || scan.endCount !== 1) {
    const code =
      scan.startCount > 1 || scan.endCount > 1
        ? 'managed-region-duplicate-markers'
        : 'managed-region-incomplete-markers';
    return problem(
      code,
      input.markers,
      scan.startCount > 1 || scan.endCount > 1
        ? 'the marker pair is duplicated or nested'
        : 'only one marker from the pair is present',
    );
  }

  const startLine = scan.startLine;
  const endLine = scan.endLine;
  if (startLine === undefined || endLine === undefined || startLine.start >= endLine.start) {
    return problem(
      'managed-region-reversed-markers',
      input.markers,
      'the end marker appears before the start marker',
    );
  }

  const newline = preferredNewline(scan, startLine);
  const region = convertLf(input.renderedRegion, newline);
  const prefix = input.existingText.slice(0, startLine.start);
  const suffix = input.existingText.slice(endLine.endIncludingNewline);
  return {
    ok: true,
    value: `${prefix}${region}${suffix}`,
    warnings: [],
  };
}
