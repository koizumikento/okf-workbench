import { languages, type Uri } from 'vscode';

import { loadPackagedWasmOkfCore } from '../../core/wasm/index.js';
import type { OkfCore } from '../../core/wasm/index.js';
import { createVscodeDiagnosticsPublisher } from '../diagnostics/index.js';
import {
  createVscodeMarkdownChangeSource,
  vscodeUriCodec,
  VscodeWorkspacePort,
} from '../workspace/index.js';
import { BundleRuntime } from './bundleRuntime.js';
import type { BundleRuntimeContext, BundleRuntimeSnapshot } from './types.js';

export interface VscodeBundleRuntimeOptions {
  readonly onPublish?: (snapshot: BundleRuntimeSnapshot<Uri>) => void;
  readonly onClear?: () => void;
  readonly onError?: (error: unknown, context: BundleRuntimeContext<Uri>) => void;
  readonly now?: () => Date | string;
  readonly core?: OkfCore;
}

export function createVscodeBundleRuntime(
  options: VscodeBundleRuntimeOptions = {},
): BundleRuntime<Uri> {
  const collection = languages.createDiagnosticCollection('okf-workbench');
  return new BundleRuntime({
    port: new VscodeWorkspacePort(),
    uris: vscodeUriCodec,
    diagnostics: createVscodeDiagnosticsPublisher(collection),
    createChangeSource: createVscodeMarkdownChangeSource,
    core: options.core ?? loadPackagedWasmOkfCore(),
    ...(options.onPublish === undefined ? {} : { onPublish: options.onPublish }),
    ...(options.onClear === undefined ? {} : { onClear: options.onClear }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
