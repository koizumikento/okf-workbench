import * as vscode from 'vscode';

import type { BundleRuntimeContext, BundleRuntimeSnapshot } from '../runtime/index.js';
import {
  ACTIONS_VIEW_ID,
  BUNDLE_VIEW_ID,
  HAS_SELECTED_BUNDLE_CONTEXT,
  OPEN_RESOURCE_COMMAND,
  RESOURCES_VIEW_ID,
  SIDEBAR_STATE_CONTEXT,
} from './ids.js';
import {
  buildSidebarBundleSummary,
  buildSidebarResourceTree,
  displayText,
  type SidebarBundleSummary,
  type SidebarFolderResource,
  type SidebarResource,
} from './model.js';

type SidebarStateName = 'empty' | 'loading' | 'ready' | 'unavailable';

interface SelectedBundlePresentation {
  readonly description: string;
  readonly label: string;
  readonly rootUri: vscode.Uri;
  readonly rootUriString: string;
}

interface BundleRootElement extends SelectedBundlePresentation {
  readonly kind: 'bundle-root';
  readonly state: Exclude<SidebarStateName, 'empty'>;
  readonly summary?: SidebarBundleSummary;
}

interface BundleMetricElement {
  readonly kind: 'bundle-metric';
  readonly icon: string;
  readonly id: string;
  readonly label: string;
}

type BundleTreeElement = BundleRootElement | BundleMetricElement;

export interface SidebarResourceElement {
  readonly kind: 'concept' | 'folder' | 'reserved';
  readonly resource: SidebarResource;
  readonly revision: number;
  readonly rootUri: vscode.Uri;
  readonly rootUriString: string;
  readonly status?: 'loading' | 'warning';
  readonly uri: vscode.Uri;
}

export interface VscodeSidebarOptions {
  readonly onContextError?: (error: unknown) => void;
}

export class VscodeSidebarService implements vscode.Disposable {
  readonly #bundleProvider = new BundleTreeDataProvider();
  readonly #resourceProvider = new ResourceTreeDataProvider();
  readonly #disposables: vscode.Disposable[];
  readonly #onContextError: ((error: unknown) => void) | undefined;
  #selection: SelectedBundlePresentation | undefined;
  #contextUpdates = Promise.resolve();
  #disposed = false;

  public constructor(options: VscodeSidebarOptions = {}) {
    this.#onContextError = options.onContextError;
    this.#disposables = [
      vscode.window.createTreeView(BUNDLE_VIEW_ID, {
        treeDataProvider: this.#bundleProvider,
        showCollapseAll: false,
      }),
      vscode.window.createTreeView(RESOURCES_VIEW_ID, {
        treeDataProvider: this.#resourceProvider,
        showCollapseAll: true,
      }),
    ];
    this.#disposables.push(
      vscode.window.registerTreeDataProvider(ACTIONS_VIEW_ID, new EmptyTreeDataProvider()),
    );
    this.#setContext(HAS_SELECTED_BUNDLE_CONTEXT, false);
    this.#setContext(SIDEBAR_STATE_CONTEXT, 'empty');
  }

  public select(rootUri: vscode.Uri, label: string, description: string): void {
    if (this.#disposed) {
      return;
    }
    const selection: SelectedBundlePresentation = {
      rootUri,
      rootUriString: rootUri.toString(),
      label: displayText(label) ?? 'OKF bundle',
      description: displayText(description) ?? '',
    };
    this.#selection = selection;
    this.#bundleProvider.setRoot({ ...selection, kind: 'bundle-root', state: 'loading' });
    this.#resourceProvider.setLoading(selection);
    this.#setContext(HAS_SELECTED_BUNDLE_CONTEXT, true);
    this.#setContext(SIDEBAR_STATE_CONTEXT, 'loading');
  }

  public publish(snapshot: BundleRuntimeSnapshot<vscode.Uri>): void {
    if (this.#disposed) {
      return;
    }
    const selection = this.#selectionFor(snapshot.context.rootUri);
    this.#selection = selection;
    const summary = buildSidebarBundleSummary(snapshot.bundle, snapshot.findings, snapshot.graph);
    this.#bundleProvider.setRoot({
      ...selection,
      kind: 'bundle-root',
      state: 'ready',
      summary,
    });
    this.#resourceProvider.publish(
      selection,
      snapshot.revision,
      buildSidebarResourceTree(snapshot.bundle, snapshot.findings, snapshot.graph),
    );
    this.#setContext(HAS_SELECTED_BUNDLE_CONTEXT, true);
    this.#setContext(SIDEBAR_STATE_CONTEXT, 'ready');
  }

  public unavailable(context: BundleRuntimeContext<vscode.Uri>): void {
    if (this.#disposed) {
      return;
    }
    const selection = this.#selectionFor(context.rootUri);
    this.#selection = selection;
    this.#bundleProvider.setRoot({
      ...selection,
      kind: 'bundle-root',
      state: 'unavailable',
    });
    this.#resourceProvider.setUnavailable(selection);
    this.#setContext(HAS_SELECTED_BUNDLE_CONTEXT, true);
    this.#setContext(SIDEBAR_STATE_CONTEXT, 'unavailable');
  }

  public clear(): void {
    if (this.#disposed) {
      return;
    }
    this.#selection = undefined;
    this.#bundleProvider.clear();
    this.#resourceProvider.clear();
    this.#setContext(HAS_SELECTED_BUNDLE_CONTEXT, false);
    this.#setContext(SIDEBAR_STATE_CONTEXT, 'empty');
  }

  public resolveCurrentResource(
    value: unknown,
    snapshot: BundleRuntimeSnapshot<vscode.Uri> | undefined,
    expectedKind?: SidebarResourceElement['kind'],
  ): SidebarResourceElement | undefined {
    if (
      snapshot === undefined ||
      !this.#resourceProvider.owns(value) ||
      (expectedKind !== undefined && value.kind !== expectedKind) ||
      value.revision !== snapshot.revision ||
      value.rootUriString !== snapshot.context.rootUriString
    ) {
      return undefined;
    }
    return value;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#setContext(HAS_SELECTED_BUNDLE_CONTEXT, false);
    this.#setContext(SIDEBAR_STATE_CONTEXT, 'empty');
    this.#disposed = true;
    this.#bundleProvider.dispose();
    this.#resourceProvider.dispose();
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
  }

  #selectionFor(rootUri: vscode.Uri): SelectedBundlePresentation {
    const rootUriString = rootUri.toString();
    if (this.#selection?.rootUriString === rootUriString) {
      return this.#selection;
    }
    const relative = vscode.workspace.asRelativePath(rootUri, false);
    const fallbackLabel = rootUri.path.split('/').at(-1) || 'OKF bundle';
    return {
      rootUri,
      rootUriString,
      label: displayText(fallbackLabel) ?? 'OKF bundle',
      description: displayText(relative) ?? '',
    };
  }

  #setContext(key: string, value: boolean | string): void {
    this.#contextUpdates = this.#contextUpdates
      .then(async () => {
        await vscode.commands.executeCommand('setContext', key, value);
      })
      .catch((error: unknown) => {
        this.#onContextError?.(error);
      });
  }
}

class BundleTreeDataProvider
  implements vscode.TreeDataProvider<BundleTreeElement>, vscode.Disposable
{
  readonly #emitter = new vscode.EventEmitter<BundleTreeElement | undefined | null>();
  readonly onDidChangeTreeData = this.#emitter.event;
  #root: BundleRootElement | undefined;

  public setRoot(root: BundleRootElement): void {
    this.#root = root;
    this.#emitter.fire(undefined);
  }

  public clear(): void {
    this.#root = undefined;
    this.#emitter.fire(undefined);
  }

  public getTreeItem(element: BundleTreeElement): vscode.TreeItem {
    if (element.kind === 'bundle-metric') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = 'okfBundleMetric';
      item.accessibilityInformation = { label: element.label };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `bundle:${element.rootUriString}`;
    item.resourceUri = element.rootUri;
    item.contextValue = 'okfBundle';
    item.description =
      element.state === 'loading'
        ? 'Loading…'
        : element.state === 'unavailable'
          ? 'Unavailable'
          : element.description;
    item.tooltip =
      element.state === 'unavailable'
        ? `${element.label}\nBundle data is unavailable. Refresh to retry.`
        : `${element.label}\n${element.description}`;
    item.iconPath =
      element.state === 'loading'
        ? new vscode.ThemeIcon('loading~spin')
        : element.state === 'unavailable'
          ? new vscode.ThemeIcon('warning')
          : new vscode.ThemeIcon('references');
    item.accessibilityInformation = {
      label: `${element.label}, ${item.description || 'OKF bundle'}`,
    };
    return item;
  }

  public getChildren(element?: BundleTreeElement): BundleTreeElement[] {
    if (element === undefined) {
      return this.#root === undefined ? [] : [this.#root];
    }
    if (element.kind !== 'bundle-root' || element.summary === undefined) {
      return [];
    }
    return [
      metric('concepts', 'symbol-file', `${String(element.summary.conceptCount)} concepts`),
      metric(
        'conformance',
        element.summary.conformanceErrors > 0 ? 'error' : 'pass',
        `${String(element.summary.conformanceErrors)} conformance errors`,
      ),
      metric(
        'curation',
        element.summary.curationWarnings > 0 ? 'warning' : 'pass',
        `${String(element.summary.curationWarnings)} curation warnings`,
      ),
      metric(
        'orphans',
        element.summary.orphanCount > 0 ? 'circle-outline' : 'pass',
        `${String(element.summary.orphanCount)} orphan concepts`,
      ),
    ];
  }

  public dispose(): void {
    this.#emitter.dispose();
  }
}

class ResourceTreeDataProvider
  implements vscode.TreeDataProvider<SidebarResourceElement>, vscode.Disposable
{
  readonly #emitter = new vscode.EventEmitter<SidebarResourceElement | undefined | null>();
  readonly onDidChangeTreeData = this.#emitter.event;
  #roots: readonly SidebarResourceElement[] = [];
  #owned = new Set<SidebarResourceElement>();
  #children = new Map<SidebarResourceElement, SidebarResourceElement[]>();

  public publish(
    selection: SelectedBundlePresentation,
    revision: number,
    resources: readonly SidebarResource[],
  ): void {
    this.#owned = new Set();
    this.#children = new Map();
    this.#roots = this.#materialize(selection, revision, resources);
    this.#emitter.fire(undefined);
  }

  public setLoading(selection: SelectedBundlePresentation): void {
    this.#owned = new Set();
    this.#children = new Map();
    this.#roots = [this.#statusElement(selection, 'Loading bundle resources…', 'loading')];
    this.#emitter.fire(undefined);
  }

  public setUnavailable(selection: SelectedBundlePresentation): void {
    this.#owned = new Set();
    this.#children = new Map();
    this.#roots = [
      this.#statusElement(selection, 'Resources unavailable — refresh to retry', 'warning'),
    ];
    this.#emitter.fire(undefined);
  }

  public clear(): void {
    this.#owned = new Set();
    this.#children = new Map();
    this.#roots = [];
    this.#emitter.fire(undefined);
  }

  public owns(value: unknown): value is SidebarResourceElement {
    return (
      typeof value === 'object' &&
      value !== null &&
      this.#owned.has(value as SidebarResourceElement)
    );
  }

  public getTreeItem(element: SidebarResourceElement): vscode.TreeItem {
    const resource = element.resource;
    if (element.status !== undefined) {
      const item = new vscode.TreeItem(resource.label, vscode.TreeItemCollapsibleState.None);
      item.id = `${element.rootUriString}:status:${element.status}`;
      item.contextValue = 'okfResourceStatus';
      item.iconPath = new vscode.ThemeIcon(
        element.status === 'loading' ? 'loading~spin' : 'warning',
      );
      item.accessibilityInformation = { label: resource.label };
      return item;
    }
    const collapsibleState =
      resource.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(resource.label, collapsibleState);
    item.id = `${element.rootUriString}:${String(element.revision)}:${resource.id}`;
    item.resourceUri = element.uri;
    item.contextValue =
      resource.kind === 'folder'
        ? 'okfFolder'
        : resource.kind === 'concept'
          ? 'okfConcept'
          : 'okfReserved';
    item.description = resourceDescription(resource);
    item.tooltip = resourceTooltip(resource);
    item.iconPath = resourceIcon(resource);
    item.accessibilityInformation = {
      label: `${resource.label}, ${resourceAccessibility(resource)}`,
    };
    if (resource.kind !== 'folder') {
      item.command = {
        command: OPEN_RESOURCE_COMMAND,
        title: 'Open Source',
        arguments: [element],
      };
    }
    return item;
  }

  public getChildren(element?: SidebarResourceElement): SidebarResourceElement[] {
    if (element === undefined) {
      return [...this.#roots];
    }
    return [...(this.#children.get(element) ?? [])];
  }

  public dispose(): void {
    this.#owned.clear();
    this.#children.clear();
    this.#emitter.dispose();
  }

  #materialize(
    selection: SelectedBundlePresentation,
    revision: number,
    resources: readonly SidebarResource[],
  ): SidebarResourceElement[] {
    return resources.map((resource) => {
      const uri =
        resource.kind === 'folder'
          ? vscode.Uri.joinPath(selection.rootUri, ...resource.relativePath.split('/'))
          : vscode.Uri.parse(resource.sourceUri);
      const element: SidebarResourceElement = {
        kind: resource.kind,
        resource,
        revision,
        rootUri: selection.rootUri,
        rootUriString: selection.rootUriString,
        uri,
      };
      this.#owned.add(element);
      if (resource.kind === 'folder') {
        this.#children.set(element, this.#materialize(selection, revision, resource.children));
      }
      return element;
    });
  }

  #statusElement(
    selection: SelectedBundlePresentation,
    label: string,
    icon: string,
  ): SidebarResourceElement {
    const resource: SidebarFolderResource = {
      kind: 'folder',
      id: `status:${icon}`,
      label,
      relativePath: '',
      children: [],
      conceptCount: 0,
      conformanceErrors: 0,
      curationWarnings: 0,
    };
    return {
      kind: 'folder',
      resource,
      revision: -1,
      rootUri: selection.rootUri,
      rootUriString: selection.rootUriString,
      status: icon === 'loading' ? 'loading' : 'warning',
      uri: selection.rootUri,
    };
  }
}

class EmptyTreeDataProvider implements vscode.TreeDataProvider<never> {
  public getTreeItem(): vscode.TreeItem {
    throw new Error('The Actions view does not expose tree items.');
  }

  public getChildren(): never[] {
    return [];
  }
}

function metric(id: string, icon: string, label: string): BundleMetricElement {
  return { kind: 'bundle-metric', id: `bundle-metric:${id}`, icon, label };
}

function resourceDescription(resource: SidebarResource): string {
  const status = resourceStatus(resource);
  if (resource.kind === 'folder') {
    return `${String(resource.conceptCount)} concepts${status}`;
  }
  if (resource.kind === 'reserved') {
    return `${resource.reservedKind}${status}`;
  }
  const type = resource.type.length > 0 ? resource.type : 'unparsed concept';
  return `${type}${status}`;
}

function resourceStatus(resource: SidebarResource): string {
  const parts: string[] = [];
  if (resource.conformanceErrors > 0) {
    parts.push(`${String(resource.conformanceErrors)} error`);
  }
  if (resource.curationWarnings > 0) {
    parts.push(`${String(resource.curationWarnings)} warning`);
  }
  if (resource.kind === 'concept' && resource.orphan) {
    parts.push('orphan');
  }
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
}

function resourceTooltip(resource: SidebarResource): string {
  if (resource.kind === 'folder') {
    return `${resource.relativePath}\n${String(resource.conceptCount)} concepts`;
  }
  const details =
    resource.kind === 'concept'
      ? `Type: ${resource.type.length > 0 ? resource.type : 'unavailable'}`
      : `Reserved ${resource.reservedKind} document`;
  return `${resource.relativePath}\n${details}${resourceStatus(resource)}`;
}

function resourceAccessibility(resource: SidebarResource): string {
  if (resource.kind === 'folder') {
    return `folder, ${String(resource.conceptCount)} concepts`;
  }
  if (resource.kind === 'reserved') {
    return `reserved ${resource.reservedKind} document`;
  }
  return `${resource.type.length > 0 ? resource.type : 'unparsed'} concept${resourceStatus(resource)}`;
}

function resourceIcon(resource: SidebarResource): vscode.ThemeIcon {
  if (resource.conformanceErrors > 0) {
    return new vscode.ThemeIcon('error');
  }
  if (resource.curationWarnings > 0) {
    return new vscode.ThemeIcon('warning');
  }
  if (resource.kind === 'folder') {
    return vscode.ThemeIcon.Folder;
  }
  if (resource.kind === 'reserved') {
    return new vscode.ThemeIcon('book');
  }
  if (resource.sourceFailed) {
    return new vscode.ThemeIcon('file-binary');
  }
  if (resource.orphan) {
    return new vscode.ThemeIcon('circle-outline');
  }
  return vscode.ThemeIcon.File;
}
