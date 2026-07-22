/** JSON-compatible values used at every core and Webview boundary. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SourcePosition {
  /** Zero-based UTF-16 offset in the decoded document. */
  readonly offset: number;
  /** Zero-based line. */
  readonly line: number;
  /** Zero-based UTF-16 character within the line. */
  readonly character: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface SourceDocument {
  readonly uri: string;
  readonly bundlePath: string;
  readonly contentHash: string;
}

export interface NormalizedFrontmatter {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly resource?: string;
  readonly tags: readonly string[];
  readonly timestamp?: string;
}

export interface ParsedFrontmatter {
  /** Complete JSON-safe producer map, including unknown keys. */
  readonly raw: JsonObject;
  /** Exact source text between the YAML delimiters. */
  readonly source: string;
  readonly range: SourceRange;
  readonly fields: Readonly<Record<string, SourceRange>>;
  readonly normalized: NormalizedFrontmatter;
}

export type LinkClassification =
  'internal' | 'broken' | 'external' | 'out-of-bundle' | 'fragment' | 'directory' | 'invalid';

export interface ConceptLink {
  readonly sourceId: string;
  readonly rawTarget: string;
  readonly label: string;
  readonly classification: LinkClassification;
  readonly range: SourceRange;
  readonly targetId?: string;
  readonly fragment?: string;
  readonly query?: string;
}

export interface Concept {
  readonly kind: 'concept';
  readonly id: string;
  readonly source: SourceDocument;
  /** Empty sentinel data when a source-scoped ParseFailure prevented complete parsing. */
  readonly frontmatter: ParsedFrontmatter;
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly resource?: string;
  readonly tags: readonly string[];
  readonly timestamp?: string;
  readonly body: string;
  readonly bodyRange: SourceRange;
  readonly links: readonly ConceptLink[];
}

export type ReservedDocumentKind = 'index' | 'log';

export interface ReservedDocument {
  readonly kind: 'reserved';
  readonly reservedKind: ReservedDocumentKind;
  readonly source: SourceDocument;
  readonly body: string;
  readonly bodyRange: SourceRange;
  /** Only a bundle-root index may declare OKF version frontmatter. */
  readonly frontmatter?: ParsedFrontmatter;
  readonly okfVersion?: string;
}

export type FindingCategory = 'conformance' | 'curation' | 'compatibility';
export type FindingSeverity = 'error' | 'warning' | 'information';

interface FindingBase {
  readonly code: string;
  readonly uri: string;
  readonly message: string;
  readonly correctiveAction?: string;
  readonly range?: SourceRange;
}

export interface ConformanceFinding extends FindingBase {
  readonly category: 'conformance';
  readonly severity: 'error';
}

export interface CurationFinding extends FindingBase {
  readonly category: 'curation';
  readonly severity: 'warning';
}

export interface CompatibilityFinding extends FindingBase {
  readonly category: 'compatibility';
  readonly severity: 'information' | 'warning';
}

export type Finding = ConformanceFinding | CurationFinding | CompatibilityFinding;

export interface ParseFailure {
  readonly kind: 'parse-failure';
  readonly uri: string;
  readonly bundlePath: string;
  readonly reason: 'decode' | 'frontmatter' | 'markdown' | 'read';
  readonly message: string;
  readonly range?: SourceRange;
}

export interface ParsedBundle {
  readonly rootUri: string;
  readonly revision: number;
  readonly concepts: readonly Concept[];
  readonly reservedDocuments: readonly ReservedDocument[];
  readonly failures: readonly ParseFailure[];
  readonly findings: readonly Finding[];
}

export interface GraphNode {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly resource?: string;
  readonly tags: readonly string[];
  readonly timestamp?: string;
  readonly orphan: boolean;
  readonly brokenLinkCount: number;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceRange: SourceRange;
}

export interface BrokenLinkPresentation {
  readonly sourceId: string;
  readonly label: string;
  readonly rawTarget: string;
  readonly sourceRange: SourceRange;
}

export interface GraphStatistics {
  readonly conceptCount: number;
  readonly edgeCount: number;
  readonly orphanCount: number;
  readonly brokenLinkCount: number;
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly tagCounts: Readonly<Record<string, number>>;
}

export interface GraphPayload {
  readonly protocolVersion: 1;
  readonly revision: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly backlinks: Readonly<Record<string, readonly string[]>>;
  readonly brokenLinks: readonly BrokenLinkPresentation[];
  readonly statistics: GraphStatistics;
}

export interface OperationProblem {
  readonly code: string;
  readonly message: string;
  readonly correctiveAction?: string;
  readonly uri?: string;
  readonly range?: SourceRange;
}

export type OperationResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly OperationProblem[] }
  | { readonly ok: false; readonly problems: readonly OperationProblem[] };

export type ExpectedContent =
  { readonly kind: 'absent' } | { readonly kind: 'sha256'; readonly value: string };

export interface FileChangeProposal {
  readonly targetUri: string;
  readonly relativePath: string;
  /** Present only when the relative path came verbatim from provider enumeration. */
  readonly pathIdentity?: 'provider';
  readonly operation: 'create' | 'update' | 'replace';
  readonly expected: ExpectedContent;
  readonly encoding: 'utf8';
  readonly proposedText: string;
}

export interface ChangeSetProposal {
  readonly operation: string;
  /**
   * Logical directory from which every proposal path is resolved and whose
   * existing descendants are checked before the first write. For ordinary
   * bundle edits this is the bundle root; initialization uses the selected
   * workspace target so a would-be bundle directory cannot hide a symlink.
   */
  readonly writeRootUri: string;
  readonly changes: readonly FileChangeProposal[];
}

export interface ApplyFailure {
  readonly targetUri: string;
  readonly code:
    'collision' | 'content-changed' | 'permission' | 'unsafe-path' | 'write' | 'unknown';
  readonly message: string;
  readonly retryable: boolean;
}

export interface ApplyReport {
  readonly completed: readonly string[];
  readonly failed: readonly ApplyFailure[];
  readonly untouched: readonly string[];
}
