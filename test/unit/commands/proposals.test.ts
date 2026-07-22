import { describe, expect, it } from 'vitest';

import { planAgentIntegration } from '../../../src/core/templates/index.js';
import {
  agentPlanToProposal,
  bundleFilesToProposal,
  indexChangesToProposal,
  providerIndexChangesToProposal,
} from '../../../src/extension/commands/proposals.js';
import { sha256Content } from '../../../src/extension/workspace/contentHash.js';
import { stringUriCodec } from '../extension-workspace/fakes.js';

const root = 'memfs://workspace/knowledge';

describe('command plan conversion', () => {
  it('converts rendered files into immutable guarded creates', () => {
    const proposal = bundleFilesToProposal(
      'initialize-bundle',
      root,
      [{ relativePath: 'nested/index.md', encoding: 'utf8', content: '# Index\n' }],
      stringUriCodec,
    );

    expect(proposal).toEqual({
      operation: 'initialize-bundle',
      writeRootUri: root,
      changes: [
        {
          targetUri: `${root}/nested/index.md`,
          relativePath: 'nested/index.md',
          operation: 'create',
          expected: { kind: 'absent' },
          encoding: 'utf8',
          proposedText: '# Index\n',
        },
      ],
    });
  });

  it('can anchor initialization at the workspace target and include the bundle directory', () => {
    const workspaceRoot = 'memfs://workspace';
    const proposal = bundleFilesToProposal(
      'initialize-bundle',
      workspaceRoot,
      [{ relativePath: 'index.md', encoding: 'utf8', content: '# Index\n' }],
      stringUriCodec,
      { relativePathPrefix: 'linked/knowledge' },
    );

    expect(proposal).toMatchObject({
      writeRootUri: workspaceRoot,
      changes: [
        {
          targetUri: `${workspaceRoot}/linked/knowledge/index.md`,
          relativePath: 'linked/knowledge/index.md',
        },
      ],
    });
  });

  it('hash-guards index updates and preserves create guards', () => {
    const proposal = indexChangesToProposal(
      root,
      [
        {
          relativePath: 'index.md',
          operation: 'update',
          encoding: 'utf8',
          previousText: 'before\n',
          proposedText: 'after\n',
        },
        {
          relativePath: 'nested/index.md',
          operation: 'create',
          encoding: 'utf8',
          proposedText: 'new\n',
        },
      ],
      stringUriCodec,
    );

    expect(proposal.changes[0]?.expected).toEqual({
      kind: 'sha256',
      value: sha256Content(new TextEncoder().encode('before\n')),
    });
    expect(proposal.changes[1]?.expected).toEqual({ kind: 'absent' });
  });

  it('marks provider-derived index targets and keeps percent-bearing paths verbatim', () => {
    const proposal = providerIndexChangesToProposal(
      root,
      [
        {
          relativePath: 'encoded%2Fsegment/index.md',
          operation: 'create',
          encoding: 'utf8',
          proposedText: '# Literal provider path\n',
        },
        {
          relativePath: 'team%20knowledge/index.md',
          operation: 'update',
          encoding: 'utf8',
          previousText: 'before\n',
          proposedText: 'after\n',
        },
      ],
      stringUriCodec,
    );

    expect(proposal.changes).toEqual([
      expect.objectContaining({
        targetUri: `${root}/encoded%2Fsegment/index.md`,
        relativePath: 'encoded%2Fsegment/index.md',
        pathIdentity: 'provider',
        expected: { kind: 'absent' },
      }),
      expect.objectContaining({
        targetUri: `${root}/team%20knowledge/index.md`,
        relativePath: 'team%20knowledge/index.md',
        pathIdentity: 'provider',
        expected: expect.objectContaining({ kind: 'sha256' }),
      }),
    ]);
  });

  it('omits unchanged agent outputs and includes a replacement only when explicitly requested', () => {
    const planned = planAgentIntegration({
      selection: 'both',
      bundlePath: 'knowledge',
      existingAgentsText: '',
      existingSkillText: 'user owned\n',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    expect(agentPlanToProposal(root, planned.value, stringUriCodec).changes).toHaveLength(1);
    const preview = agentPlanToProposal(root, planned.value, stringUriCodec, {
      includeReplacementRequired: true,
    });
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes[1]).toMatchObject({
      relativePath: '.agents/skills/maintain-okf-knowledge/SKILL.md',
      operation: 'replace',
      expected: { kind: 'sha256' },
    });
  });
});
