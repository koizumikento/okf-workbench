import type {
  GraphNode,
  GraphPayload,
  GraphStatistics,
  SourcePosition,
  SourceRange,
} from '../model/index.js';

/**
 * Returns the exact UTF-8 byte length of JSON.stringify(payload) without creating an escaped
 * string or encoded payload copy. When stopAfter is exceeded, counting stops and returns a value
 * greater than stopAfter.
 */
export function graphPayloadJsonByteLength(
  payload: GraphPayload,
  stopAfter = Number.MAX_SAFE_INTEGER,
): number {
  const counter = new JsonByteCounter(stopAfter);
  counter.objectStart();
  counter.property('protocolVersion', true);
  counter.nonNegativeInteger(payload.protocolVersion);
  counter.property('revision');
  counter.nonNegativeInteger(payload.revision);
  counter.property('nodes');
  counter.arrayStart();
  for (let index = 0; index < payload.nodes.length && !counter.exceeded; index += 1) {
    if (index > 0) counter.comma();
    const node = payload.nodes[index];
    if (node === undefined) counter.null();
    else countNode(counter, node);
  }
  counter.arrayEnd();
  counter.property('edges');
  counter.arrayStart();
  for (let index = 0; index < payload.edges.length && !counter.exceeded; index += 1) {
    if (index > 0) counter.comma();
    const edge = payload.edges[index];
    if (edge === undefined) {
      counter.null();
      continue;
    }
    counter.objectStart();
    counter.property('id', true);
    counter.string(edge.id);
    counter.property('source');
    counter.string(edge.source);
    counter.property('target');
    counter.string(edge.target);
    counter.property('sourceRange');
    countRange(counter, edge.sourceRange);
    counter.objectEnd();
  }
  counter.arrayEnd();
  counter.property('backlinks');
  counter.objectStart();
  let firstBacklink = true;
  for (const target in payload.backlinks) {
    if (!Object.hasOwn(payload.backlinks, target) || counter.exceeded) continue;
    counter.property(target, firstBacklink);
    firstBacklink = false;
    counter.stringArray(payload.backlinks[target] ?? []);
  }
  counter.objectEnd();
  counter.property('brokenLinks');
  counter.arrayStart();
  for (let index = 0; index < payload.brokenLinks.length && !counter.exceeded; index += 1) {
    if (index > 0) counter.comma();
    const link = payload.brokenLinks[index];
    if (link === undefined) {
      counter.null();
      continue;
    }
    counter.objectStart();
    counter.property('sourceId', true);
    counter.string(link.sourceId);
    counter.property('label');
    counter.string(link.label);
    counter.property('rawTarget');
    counter.string(link.rawTarget);
    counter.property('sourceRange');
    countRange(counter, link.sourceRange);
    counter.objectEnd();
  }
  counter.arrayEnd();
  counter.property('statistics');
  countStatistics(counter, payload.statistics);
  counter.objectEnd();
  return counter.bytes;
}

function countNode(counter: JsonByteCounter, node: GraphNode): void {
  counter.objectStart();
  counter.property('id', true);
  counter.string(node.id);
  if (node.sourceFailed === true) {
    counter.property('sourceFailed');
    counter.boolean(true);
  }
  counter.property('type');
  counter.string(node.type);
  if (node.title !== undefined) {
    counter.property('title');
    counter.string(node.title);
  }
  if (node.description !== undefined) {
    counter.property('description');
    counter.string(node.description);
  }
  if (node.resource !== undefined) {
    counter.property('resource');
    counter.string(node.resource);
  }
  counter.property('tags');
  counter.stringArray(node.tags);
  if (node.timestamp !== undefined) {
    counter.property('timestamp');
    counter.string(node.timestamp);
  }
  counter.property('orphan');
  counter.boolean(node.orphan);
  counter.property('brokenLinkCount');
  counter.nonNegativeInteger(node.brokenLinkCount);
  counter.objectEnd();
}

function countStatistics(counter: JsonByteCounter, statistics: GraphStatistics): void {
  counter.objectStart();
  counter.property('conceptCount', true);
  counter.nonNegativeInteger(statistics.conceptCount);
  counter.property('edgeCount');
  counter.nonNegativeInteger(statistics.edgeCount);
  counter.property('orphanCount');
  counter.nonNegativeInteger(statistics.orphanCount);
  counter.property('brokenLinkCount');
  counter.nonNegativeInteger(statistics.brokenLinkCount);
  counter.property('typeCounts');
  counter.countRecord(statistics.typeCounts);
  counter.property('tagCounts');
  counter.countRecord(statistics.tagCounts);
  counter.objectEnd();
}

function countRange(counter: JsonByteCounter, range: SourceRange): void {
  counter.objectStart();
  counter.property('start', true);
  countPosition(counter, range.start);
  counter.property('end');
  countPosition(counter, range.end);
  counter.objectEnd();
}

function countPosition(counter: JsonByteCounter, position: SourcePosition): void {
  counter.objectStart();
  counter.property('offset', true);
  counter.nonNegativeInteger(position.offset);
  counter.property('line');
  counter.nonNegativeInteger(position.line);
  counter.property('character');
  counter.nonNegativeInteger(position.character);
  counter.objectEnd();
}

class JsonByteCounter {
  public bytes = 0;

  public constructor(readonly stopAfter: number) {}

  public get exceeded(): boolean {
    return this.bytes > this.stopAfter;
  }

  public add(bytes: number): void {
    if (!this.exceeded) this.bytes += bytes;
  }

  public objectStart(): void {
    this.add(1);
  }

  public objectEnd(): void {
    this.add(1);
  }

  public arrayStart(): void {
    this.add(1);
  }

  public arrayEnd(): void {
    this.add(1);
  }

  public comma(): void {
    this.add(1);
  }

  public property(name: string, first = false): void {
    if (!first) this.comma();
    this.string(name);
    this.add(1);
  }

  public boolean(_value: boolean): void {
    this.add(_value ? 4 : 5);
  }

  public null(): void {
    this.add(4);
  }

  public nonNegativeInteger(value: number): void {
    if (value === 0) {
      this.add(1);
      return;
    }
    let digits = 1;
    let threshold = 10;
    while (value >= threshold) {
      digits += 1;
      threshold *= 10;
    }
    this.add(digits);
  }

  public stringArray(values: readonly string[]): void {
    this.arrayStart();
    for (let index = 0; index < values.length && !this.exceeded; index += 1) {
      if (index > 0) this.comma();
      const value = values[index];
      if (value === undefined) this.null();
      else this.string(value);
    }
    this.arrayEnd();
  }

  public countRecord(record: Readonly<Record<string, number>>): void {
    this.objectStart();
    let first = true;
    for (const key in record) {
      if (!Object.hasOwn(record, key) || this.exceeded) continue;
      this.property(key, first);
      first = false;
      this.nonNegativeInteger(record[key] ?? 0);
    }
    this.objectEnd();
  }

  public string(value: string): void {
    this.add(2);
    for (let index = 0; index < value.length && !this.exceeded; index += 1) {
      const current = value.charCodeAt(index);
      if (current === 0x22 || current === 0x5c) {
        this.add(2);
      } else if (
        current === 0x08 ||
        current === 0x09 ||
        current === 0x0a ||
        current === 0x0c ||
        current === 0x0d
      ) {
        this.add(2);
      } else if (current <= 0x1f) {
        this.add(6);
      } else if (current <= 0x7f) {
        this.add(1);
      } else if (current <= 0x7ff) {
        this.add(2);
      } else if (current >= 0xd800 && current <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          this.add(4);
          index += 1;
        } else {
          this.add(6);
        }
      } else if (current >= 0xdc00 && current <= 0xdfff) {
        this.add(6);
      } else {
        this.add(3);
      }
    }
  }
}
