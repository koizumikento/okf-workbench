import { describe, expect, it } from 'vitest';

import {
  buildFolderHierarchy,
  folderBreadcrumb,
  folderPathForNode,
  isNodeInFolder,
  topLevelFolderPath,
} from '../../../src/webview/state/folders.js';
import { graphNode } from './fixtures.js';

describe('Webview folder presentation model', () => {
  const nodes = [
    graphNode({ id: 'root-note' }),
    graphNode({ id: 'area/source' }),
    graphNode({ id: 'area/nested/decision' }),
    graphNode({ id: 'area/nested/source' }),
    graphNode({ id: 'second/source' }),
  ];

  it('derives a deterministic hierarchy with direct and recursive concept counts', () => {
    const hierarchy = buildFolderHierarchy(nodes);

    expect(hierarchy).toMatchObject({
      path: '',
      label: 'Bundle root',
      directConceptCount: 1,
      descendantConceptCount: 5,
    });
    expect(hierarchy.children.map((folder) => folder.path)).toEqual(['area', 'second']);
    expect(hierarchy.children[0]).toMatchObject({
      path: 'area',
      directConceptCount: 1,
      descendantConceptCount: 3,
    });
    expect(hierarchy.children[0]?.children[0]).toMatchObject({
      path: 'area/nested',
      directConceptCount: 2,
      descendantConceptCount: 2,
    });
  });

  it('keeps path identity literal and distinguishes identical filenames by folder', () => {
    expect(folderPathForNode('area/source')).toBe('area');
    expect(folderPathForNode('second/source')).toBe('second');
    expect(folderPathForNode('encoded%2Ffolder/source')).toBe('encoded%2Ffolder');
    expect(topLevelFolderPath('area/nested/source')).toBe('area');
  });

  it('filters a folder subtree while treating Bundle root as root-level concepts', () => {
    expect(nodes.filter((node) => isNodeInFolder(node.id, '')).map((node) => node.id)).toEqual([
      'root-note',
    ]);
    expect(nodes.filter((node) => isNodeInFolder(node.id, 'area')).map((node) => node.id)).toEqual([
      'area/source',
      'area/nested/decision',
      'area/nested/source',
    ]);
  });

  it('builds clickable breadcrumb segments from Bundle root to the parent folder', () => {
    expect(
      folderBreadcrumb('area/nested/decision').map((folder) => ({
        path: folder.path,
        label: folder.label,
      })),
    ).toEqual([
      { path: '', label: 'Bundle root' },
      { path: 'area', label: 'area' },
      { path: 'area/nested', label: 'nested' },
    ]);
  });
});
