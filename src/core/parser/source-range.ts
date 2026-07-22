import type { SourcePosition, SourceRange } from '../model/index.js';

/** Maps decoded-document UTF-16 offsets to the zero-based source coordinates used by the core. */
export class SourceRangeIndex {
  readonly #textLength: number;
  readonly #lineStarts: readonly number[];

  public constructor(text: string) {
    this.#textLength = text.length;

    const lineStarts = [0];
    for (let offset = 0; offset < text.length; offset += 1) {
      const code = text.charCodeAt(offset);
      if (code === 0x0d) {
        if (text.charCodeAt(offset + 1) === 0x0a) {
          offset += 1;
        }
        lineStarts.push(offset + 1);
      } else if (code === 0x0a) {
        lineStarts.push(offset + 1);
      }
    }
    this.#lineStarts = lineStarts;
  }

  public position(offset: number): SourcePosition {
    const boundedOffset = Math.max(0, Math.min(this.#textLength, offset));
    let low = 0;
    let high = this.#lineStarts.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const lineStart = this.#lineStarts[middle];
      if (lineStart === undefined) {
        break;
      }
      if (lineStart <= boundedOffset) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const line = Math.max(0, high);
    const lineStart = this.#lineStarts[line] ?? 0;
    return {
      offset: boundedOffset,
      line,
      character: boundedOffset - lineStart,
    };
  }

  public range(start: number, end: number): SourceRange {
    const boundedStart = Math.max(0, Math.min(this.#textLength, start));
    const boundedEnd = Math.max(boundedStart, Math.min(this.#textLength, end));
    return {
      start: this.position(boundedStart),
      end: this.position(boundedEnd),
    };
  }
}
