import type { Finding, GraphPayload, ParsedBundle } from '../../core/model/index.js';
import { ORPHAN_CONCEPT_FINDING_CODE } from '../diagnostics/findingCodes.js';

const MAX_DISPLAY_CODE_POINTS = 160;

export interface SidebarFindingCounts {
  readonly conformanceErrors: number;
  readonly curationWarnings: number;
}

export interface SidebarBundleSummary extends SidebarFindingCounts {
  readonly conceptCount: number;
  readonly orphanCount: number;
}

interface SidebarResourceBase extends SidebarFindingCounts {
  readonly id: string;
  readonly label: string;
  readonly relativePath: string;
}

export interface SidebarFolderResource extends SidebarResourceBase {
  readonly kind: 'folder';
  readonly children: readonly SidebarResource[];
  readonly conceptCount: number;
}

export interface SidebarConceptResource extends SidebarResourceBase {
  readonly kind: 'concept';
  readonly conceptId: string;
  readonly sourceFailed: boolean;
  readonly sourceUri: string;
  readonly type: string;
  readonly orphan: boolean;
}

export interface SidebarReservedResource extends SidebarResourceBase {
  readonly kind: 'reserved';
  readonly reservedKind: 'index' | 'log';
  readonly sourceUri: string;
}

export type SidebarResource =
  SidebarFolderResource | SidebarConceptResource | SidebarReservedResource;

interface MutableFolder {
  readonly childFolders: Map<string, MutableFolder>;
  readonly directResources: (SidebarConceptResource | SidebarReservedResource)[];
  readonly label: string;
  readonly relativePath: string;
}

export function buildSidebarBundleSummary(
  bundle: ParsedBundle,
  findings: readonly Finding[],
  graph: GraphPayload,
): SidebarBundleSummary {
  const counts = findingCounts(findings);
  return {
    conceptCount: bundle.concepts.length,
    conformanceErrors: counts.conformanceErrors,
    curationWarnings: counts.curationWarnings,
    orphanCount: graph.statistics.orphanCount,
  };
}

export function buildSidebarResourceTree(
  bundle: ParsedBundle,
  findings: readonly Finding[],
  graph: GraphPayload,
): readonly SidebarResource[] {
  const countsByUri = findingCountsByUri(findings);
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const root: MutableFolder = {
    childFolders: new Map(),
    directResources: [],
    label: '',
    relativePath: '',
  };

  for (const concept of bundle.concepts) {
    const relativePath = concept.source.bundlePath;
    const parent = ensureFolder(root, parentPath(relativePath));
    const counts = countsByUri.get(concept.source.uri) ?? emptyFindingCounts();
    const graphNode = graphNodes.get(concept.id);
    parent.directResources.push({
      kind: 'concept',
      id: `concept:${concept.id}`,
      conceptId: concept.id,
      label: displayText(concept.title) ?? displayText(baseName(concept.id)) ?? 'Concept',
      relativePath,
      sourceUri: concept.source.uri,
      type: displayText(concept.type) ?? '',
      orphan: graphNode?.orphan ?? false,
      sourceFailed: graphNode?.sourceFailed === true,
      ...counts,
    });
  }

  for (const document of bundle.reservedDocuments) {
    const relativePath = document.source.bundlePath;
    const parent = ensureFolder(root, parentPath(relativePath));
    const counts = countsByUri.get(document.source.uri) ?? emptyFindingCounts();
    parent.directResources.push({
      kind: 'reserved',
      id: `reserved:${relativePath}`,
      label: displayText(baseName(relativePath)) ?? `${document.reservedKind}.md`,
      relativePath,
      sourceUri: document.source.uri,
      reservedKind: document.reservedKind,
      ...counts,
    });
  }

  return materializeChildren(root);
}

function findingCounts(findings: readonly Finding[]): SidebarFindingCounts {
  let conformanceErrors = 0;
  let curationWarnings = 0;
  for (const finding of findings) {
    if (finding.category === 'conformance') {
      conformanceErrors += 1;
    } else if (finding.category === 'curation' && finding.code !== ORPHAN_CONCEPT_FINDING_CODE) {
      curationWarnings += 1;
    }
  }
  return { conformanceErrors, curationWarnings };
}

function findingCountsByUri(
  findings: readonly Finding[],
): ReadonlyMap<string, SidebarFindingCounts> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const current = grouped.get(finding.uri);
    if (current === undefined) {
      grouped.set(finding.uri, [finding]);
    } else {
      current.push(finding);
    }
  }
  return new Map(
    [...grouped].map(([uri, sourceFindings]) => [uri, findingCounts(sourceFindings)] as const),
  );
}

function emptyFindingCounts(): SidebarFindingCounts {
  return { conformanceErrors: 0, curationWarnings: 0 };
}

function ensureFolder(root: MutableFolder, path: string): MutableFolder {
  if (path.length === 0) {
    return root;
  }
  let current = root;
  let currentPath = '';
  for (const segment of path.split('/')) {
    currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
    let child = current.childFolders.get(segment);
    if (child === undefined) {
      child = {
        childFolders: new Map(),
        directResources: [],
        label: segment,
        relativePath: currentPath,
      };
      current.childFolders.set(segment, child);
    }
    current = child;
  }
  return current;
}

function materializeChildren(folder: MutableFolder): readonly SidebarResource[] {
  const folders = [...folder.childFolders.values()]
    .sort((left, right) => compareText(left.label, right.label))
    .map((child): SidebarFolderResource => {
      const children = materializeChildren(child);
      return {
        kind: 'folder',
        id: `folder:${child.relativePath}`,
        label: displayText(child.label) ?? 'Folder',
        relativePath: child.relativePath,
        children,
        conceptCount: children.reduce((total, resource) => {
          if (resource.kind === 'folder') {
            return total + resource.conceptCount;
          }
          return total + (resource.kind === 'concept' ? 1 : 0);
        }, 0),
        conformanceErrors: children.reduce(
          (total, resource) => total + resource.conformanceErrors,
          0,
        ),
        curationWarnings: children.reduce(
          (total, resource) => total + resource.curationWarnings,
          0,
        ),
      };
    });
  const resources = [...folder.directResources].sort(
    (left, right) =>
      compareText(left.label, right.label) || compareText(left.relativePath, right.relativePath),
  );
  return [...folders, ...resources];
}

function parentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/');
  return separator < 0 ? '' : relativePath.slice(0, separator);
}

function baseName(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? path : path.slice(separator + 1);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

export function displayText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length === 0) {
    return undefined;
  }
  const codePoints = [...compact];
  return codePoints.length <= MAX_DISPLAY_CODE_POINTS
    ? compact
    : `${codePoints.slice(0, MAX_DISPLAY_CODE_POINTS - 1).join('')}…`;
}
