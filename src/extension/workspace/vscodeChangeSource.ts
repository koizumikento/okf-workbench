import { RelativePattern, workspace, type Uri } from 'vscode';

import { isUriContained } from './pathSafety.js';
import type {
  DisposableLike,
  WorkspaceChange,
  WorkspaceChangeSource,
} from './refreshCoordinator.js';

/**
 * Watches Markdown resources under one URI root. VS Code reports a rename as
 * a delete/create pair; the refresh coordinator coalesces that burst, while a
 * provider with native rename events may submit `kind: "rename"` directly.
 */
export function createVscodeMarkdownChangeSource(root: Uri): WorkspaceChangeSource<Uri> {
  return {
    subscribe(listener: (change: WorkspaceChange<Uri>) => void): DisposableLike {
      const watcher = workspace.createFileSystemWatcher(new RelativePattern(root, '**/*.md'));
      const subscriptions = [
        watcher.onDidCreate((uri) => {
          if (isUriContained(root, uri)) {
            listener({ kind: 'create', uri });
          }
        }),
        watcher.onDidChange((uri) => {
          if (isUriContained(root, uri)) {
            listener({ kind: 'change', uri });
          }
        }),
        watcher.onDidDelete((uri) => {
          if (isUriContained(root, uri)) {
            listener({ kind: 'delete', uri });
          }
        }),
      ];
      return {
        dispose() {
          for (const subscription of subscriptions) {
            subscription.dispose();
          }
          watcher.dispose();
        },
      };
    },
  };
}
