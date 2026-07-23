import { Buffer } from 'node:buffer';

import type { ChangeSetProposal, OperationProblem } from '../../core/model/index.js';
import type { ProposalPresentation, ProposalPreviewIdentity } from '../commands/types.js';
import { addBytesWithinLimit, BUNDLE_READ_LIMITS } from '../workspace/readSafety.js';

/** One accepted change opens one pinned diff tab; keep the editor set conservatively bounded. */
export const MAX_PROPOSAL_PREVIEW_CHANGES = 64;
export const MAX_PROPOSAL_PREVIEW_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES = 1024 * 1024;

const MAXIMUM_PRODUCTION_IDENTITY: ProposalPreviewIdentity = {
  id: `okf-preview-ffffffff-ffff-4fff-bfff-ffffffffffff-${String(Number.MAX_SAFE_INTEGER)}-target-ffffffff`,
  label: `OKF Preview ffffffff #${String(Number.MAX_SAFE_INTEGER)} / target ffffffff`,
  targetUri: '',
};

export type ProposalPreviewFeasibility =
  | { readonly ready: true; readonly plannedBodyBytes: number }
  | { readonly ready: false; readonly problem: OperationProblem };

function previewLimitProblem(message: string): OperationProblem {
  return {
    code: 'preview-limit',
    message,
    correctiveAction:
      'Narrow the operation or split the knowledge bundle before retrying; no preview tabs were opened.',
  };
}

export function renderProposalPreviewSummary(
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
  identity: ProposalPreviewIdentity,
): string {
  const lines = [
    `# ${presentation.title} — ${identity.label}`,
    '',
    `- Preview identity: \`${identity.id}\``,
    `- Target: \`${identity.targetUri}\``,
    '',
    ...presentation.summary.map((line) => `- ${line}`),
    '',
    '## Complete proposed path list',
    '',
    ...proposal.changes.map(
      (change, index) =>
        `${index + 1}. \`${change.relativePath}\` (${change.operation})\n   - ${change.targetUri}`,
    ),
    '',
    'Every corresponding before-and-after diff is open in a read-only editor tab.',
    `Review only tabs labeled ${identity.label} while the modeless confirmation waits.`,
    'Choose its apply or cancel action only after reviewing the complete change set.',
    '',
  ];
  return lines.join('\n');
}

/** Pure feasibility check that must run before workspace preflight or snapshot reads. */
export function inspectProposalPreviewFeasibility(
  proposal: ChangeSetProposal,
  presentation: ProposalPresentation,
): ProposalPreviewFeasibility {
  if (proposal.changes.length > MAX_PROPOSAL_PREVIEW_CHANGES) {
    return {
      ready: false,
      problem: previewLimitProblem(
        `The proposal contains ${String(proposal.changes.length)} changes, exceeding the safe preview limit of ${String(MAX_PROPOSAL_PREVIEW_CHANGES)}.`,
      ),
    };
  }

  let plannedBodyBytes = 0;
  for (const change of proposal.changes) {
    const proposedBytes = Buffer.byteLength(change.proposedText, 'utf8');
    if (proposedBytes > BUNDLE_READ_LIMITS.maxDocumentBytes) {
      return {
        ready: false,
        problem: previewLimitProblem(
          `The proposed output ${change.targetUri} is ${String(proposedBytes)} UTF-8 bytes, exceeding the per-file safety limit of ${String(BUNDLE_READ_LIMITS.maxDocumentBytes)} bytes.`,
        ),
      };
    }
    let nextTotal = addBytesWithinLimit(
      plannedBodyBytes,
      proposedBytes,
      MAX_PROPOSAL_PREVIEW_BODY_BYTES,
    );
    if (nextTotal === undefined) {
      return {
        ready: false,
        problem: previewLimitProblem(
          `The proposed before-and-after bodies exceed the safe preview budget of ${String(MAX_PROPOSAL_PREVIEW_BODY_BYTES)} UTF-8 bytes.`,
        ),
      };
    }
    plannedBodyBytes = nextTotal;
    if (change.expected.kind === 'sha256') {
      if (
        !Number.isSafeInteger(change.expected.byteLength) ||
        change.expected.byteLength < 0 ||
        change.expected.byteLength > BUNDLE_READ_LIMITS.maxDocumentBytes
      ) {
        return {
          ready: false,
          problem: previewLimitProblem(
            `The declared existing content length for ${change.targetUri} is ${String(change.expected.byteLength)} bytes, outside the per-file safety limit of 0 to ${String(BUNDLE_READ_LIMITS.maxDocumentBytes)} bytes.`,
          ),
        };
      }
      nextTotal = addBytesWithinLimit(
        plannedBodyBytes,
        change.expected.byteLength,
        MAX_PROPOSAL_PREVIEW_BODY_BYTES,
      );
      if (nextTotal === undefined) {
        return {
          ready: false,
          problem: previewLimitProblem(
            `The proposed before-and-after bodies exceed the safe preview budget of ${String(MAX_PROPOSAL_PREVIEW_BODY_BYTES)} UTF-8 bytes.`,
          ),
        };
      }
      plannedBodyBytes = nextTotal;
    }
  }

  const maximumIdentity = {
    ...MAXIMUM_PRODUCTION_IDENTITY,
    targetUri: proposal.writeRootUri,
  };
  const summary = renderProposalPreviewSummary(proposal, presentation, maximumIdentity);
  if (Buffer.byteLength(summary, 'utf8') > MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES) {
    return {
      ready: false,
      problem: previewLimitProblem(
        `The complete proposed-path summary exceeds the safe preview limit of ${String(MAX_PROPOSAL_PREVIEW_SUMMARY_BYTES)} UTF-8 bytes.`,
      ),
    };
  }

  return { ready: true, plannedBodyBytes };
}
