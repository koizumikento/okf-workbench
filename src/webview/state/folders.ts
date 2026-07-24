import type { GraphNode } from '../../core/model/types.js';

export const ROOT_FOLDER_PATH = '';
export const ROOT_FOLDER_LABEL = 'Bundle root';

export interface FolderEntry {
  readonly path: string;
  readonly label: string;
  readonly parentPath: string | undefined;
  readonly depth: number;
  readonly directConceptCount: number;
  readonly descendantConceptCount: number;
  readonly children: readonly FolderEntry[];
}

interface MutableFolderEntry {
  readonly path: string;
  readonly label: string;
  readonly parentPath: string | undefined;
  readonly depth: number;
  directConceptCount: number;
  descendantConceptCount: number;
  readonly childPaths: Set<string>;
}

export function folderPathForNode(nodeId: string): string {
  const separator = nodeId.lastIndexOf('/');
  return separator < 0 ? ROOT_FOLDER_PATH : nodeId.slice(0, separator);
}

export function folderBreadcrumb(nodeId: string): readonly FolderEntry[] {
  const folderPath = folderPathForNode(nodeId);
  const paths = ancestorFolderPaths(folderPath);
  return paths.map((path, index) => ({
    path,
    label: path === ROOT_FOLDER_PATH ? ROOT_FOLDER_LABEL : path.slice(path.lastIndexOf('/') + 1),
    parentPath: index === 0 ? undefined : paths[index - 1],
    depth: index,
    directConceptCount: 0,
    descendantConceptCount: 0,
    children: [],
  }));
}

export function buildFolderHierarchy(nodes: readonly GraphNode[]): FolderEntry {
  const entries = new Map<string, MutableFolderEntry>();
  entries.set(ROOT_FOLDER_PATH, {
    path: ROOT_FOLDER_PATH,
    label: ROOT_FOLDER_LABEL,
    parentPath: undefined,
    depth: 0,
    directConceptCount: 0,
    descendantConceptCount: 0,
    childPaths: new Set(),
  });

  for (const node of nodes) {
    const folderPath = folderPathForNode(node.id);
    const ancestors = ancestorFolderPaths(folderPath);
    for (let index = 1; index < ancestors.length; index += 1) {
      const path = ancestors[index];
      const parentPath = ancestors[index - 1];
      if (path === undefined || parentPath === undefined) continue;
      if (!entries.has(path)) {
        entries.set(path, {
          path,
          label: path.slice(path.lastIndexOf('/') + 1),
          parentPath,
          depth: index,
          directConceptCount: 0,
          descendantConceptCount: 0,
          childPaths: new Set(),
        });
      }
      entries.get(parentPath)?.childPaths.add(path);
    }
    const directEntry = entries.get(folderPath);
    if (directEntry !== undefined) directEntry.directConceptCount += 1;
    for (const path of ancestors) {
      const entry = entries.get(path);
      if (entry !== undefined) entry.descendantConceptCount += 1;
    }
  }

  const freezeEntry = (path: string): FolderEntry => {
    const entry = entries.get(path);
    if (entry === undefined) throw new Error(`Missing folder entry: ${path}`);
    return {
      path: entry.path,
      label: entry.label,
      parentPath: entry.parentPath,
      depth: entry.depth,
      directConceptCount: entry.directConceptCount,
      descendantConceptCount: entry.descendantConceptCount,
      children: [...entry.childPaths]
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map(freezeEntry),
    };
  };

  return freezeEntry(ROOT_FOLDER_PATH);
}

export function folderExists(nodes: readonly GraphNode[], folderPath: string): boolean {
  if (folderPath === ROOT_FOLDER_PATH) return true;
  return nodes.some(
    (node) => folderPathForNode(node.id) === folderPath || node.id.startsWith(`${folderPath}/`),
  );
}

export function isNodeInFolder(nodeId: string, folderPath: string): boolean {
  if (folderPath === ROOT_FOLDER_PATH) return folderPathForNode(nodeId) === ROOT_FOLDER_PATH;
  return nodeId.startsWith(`${folderPath}/`);
}

export function topLevelFolderPath(nodeId: string): string {
  const folderPath = folderPathForNode(nodeId);
  const separator = folderPath.indexOf('/');
  return separator < 0 ? folderPath : folderPath.slice(0, separator);
}

function ancestorFolderPaths(folderPath: string): readonly string[] {
  if (folderPath === ROOT_FOLDER_PATH) return [ROOT_FOLDER_PATH];
  const segments = folderPath.split('/');
  const paths = [ROOT_FOLDER_PATH];
  for (let index = 1; index <= segments.length; index += 1) {
    paths.push(segments.slice(0, index).join('/'));
  }
  return paths;
}
