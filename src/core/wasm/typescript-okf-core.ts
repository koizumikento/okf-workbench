import { buildGraphPayload } from '../graph/index.js';
import { planProviderIndexes } from '../indexes/index.js';
import type { ParseFailure, ParsedBundle } from '../model/index.js';
import { parseBundle, type ParseBundleInput } from '../parser/index.js';
import { validateBundle } from '../validation/index.js';
import {
  AGENT_SKILL_PATH,
  renderAgentSkill,
  renderAgentsManagedBlock,
  renderBundlePreset,
  renderConceptTemplate,
  type BundleDirectoryInput,
  type BundlePreset,
  type ConceptTemplateInput,
  type RenderedTemplateFile,
} from '../templates/index.js';
import { OKF_CORE_ABI_VERSION, type OkfCore, type OkfCoreInspection } from './types.js';

/**
 * Migration oracle for direct unit tests. Production construction explicitly loads the packaged
 * Wasm core and never falls back to this implementation.
 */
export const typescriptOkfCore: OkfCore = {
  abiVersion: OKF_CORE_ABI_VERSION,
  coreVersion: 'typescript-migration-oracle',
  inspect(
    input: ParseBundleInput,
    now: Date | string,
    failures: readonly ParseFailure[] = [],
  ): OkfCoreInspection {
    const parsed = parseBundle(input);
    const bundleWithFailures: ParsedBundle = {
      ...parsed,
      failures: [...parsed.failures, ...failures].sort(
        (left, right) =>
          left.bundlePath.localeCompare(right.bundlePath) ||
          left.uri.localeCompare(right.uri) ||
          left.reason.localeCompare(right.reason),
      ),
    };
    const findings = validateBundle(bundleWithFailures, { now });
    const bundle: ParsedBundle = { ...bundleWithFailures, findings };
    return { bundle, findings, graph: buildGraphPayload(bundle) };
  },
  renderBundle(preset: BundlePreset, timestamp: string): readonly RenderedTemplateFile[] {
    const result = renderBundlePreset({ preset, timestamp });
    if (!result.ok) throw new Error(result.problems[0]?.message ?? 'Bundle rendering failed.');
    return result.value;
  },
  renderConcept(input: ConceptTemplateInput): RenderedTemplateFile {
    const result = renderConceptTemplate(input);
    if (!result.ok) throw new Error(result.problems[0]?.message ?? 'Concept rendering failed.');
    return result.value;
  },
  renderIndexes(input: ParseBundleInput, mode: 'missing' | 'all'): readonly RenderedTemplateFile[] {
    const bundle = parseBundle(input);
    const result = planProviderIndexes({
      mode: mode === 'all' ? 'update-all' : 'missing-indexes-only',
      concepts: bundle.concepts.map((concept) => ({
        relativePath: concept.source.bundlePath,
        ...(concept.title === undefined ? {} : { title: concept.title }),
        ...(concept.description === undefined ? {} : { description: concept.description }),
      })),
      existingIndexes: [],
    });
    if (!result.ok) throw new Error(result.problems[0]?.message ?? 'Index rendering failed.');
    return result.value.changes.map((change) => ({
      relativePath: change.relativePath,
      encoding: 'utf8',
      content: change.proposedText,
    }));
  },
  renderAgent(
    target: 'agents' | 'skill' | 'both',
    bundlePath: BundleDirectoryInput,
  ): readonly RenderedTemplateFile[] {
    const files: RenderedTemplateFile[] = [];
    if (target === 'agents' || target === 'both') {
      const result = renderAgentsManagedBlock(bundlePath);
      if (!result.ok) throw new Error(result.problems[0]?.message ?? 'AGENTS.md rendering failed.');
      files.push({ relativePath: 'AGENTS.md', encoding: 'utf8', content: result.value });
    }
    if (target === 'skill' || target === 'both') {
      const result = renderAgentSkill(bundlePath);
      if (!result.ok) throw new Error(result.problems[0]?.message ?? 'Skill rendering failed.');
      files.push({ relativePath: AGENT_SKILL_PATH, encoding: 'utf8', content: result.value });
    }
    return files;
  },
};
