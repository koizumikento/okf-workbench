import type { Finding, GraphPayload, ParseFailure, ParsedBundle } from '../model/index.js';
import type { ParseBundleInput } from '../parser/index.js';
import type {
  BundleDirectoryInput,
  BundlePreset,
  ConceptTemplateInput,
  RenderedTemplateFile,
} from '../templates/index.js';

export const OKF_CORE_ABI_VERSION = 1 as const;

export interface OkfCoreInspection {
  readonly bundle: ParsedBundle;
  readonly findings: readonly Finding[];
  readonly graph: GraphPayload;
}

/** Versioned deterministic core port. It receives no workspace or editor capabilities. */
export interface OkfCore {
  readonly abiVersion: typeof OKF_CORE_ABI_VERSION;
  readonly coreVersion: string;
  inspect(
    input: ParseBundleInput,
    now: Date | string,
    failures?: readonly ParseFailure[],
  ): OkfCoreInspection;
  renderBundle(preset: BundlePreset, timestamp: string): readonly RenderedTemplateFile[];
  renderConcept(input: ConceptTemplateInput): RenderedTemplateFile;
  renderIndexes(input: ParseBundleInput, mode: 'missing' | 'all'): readonly RenderedTemplateFile[];
  renderAgent(
    target: 'agents' | 'skill' | 'both',
    bundlePath: BundleDirectoryInput,
  ): readonly RenderedTemplateFile[];
}
