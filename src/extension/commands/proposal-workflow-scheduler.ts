import type { ProposalWorkflowLease, ProposalWorkflowScheduler } from './types.js';

/** Raised synchronously by the fail-fast gate instead of retaining another command workflow. */
export class ProposalWorkflowBusyError extends Error {
  readonly shouldNotify: boolean;

  constructor(shouldNotify: boolean) {
    super('Another proposal workflow is already active.');
    this.name = 'ProposalWorkflowBusyError';
    this.shouldNotify = shouldNotify;
  }
}

/** Allows exactly one complete write-command workflow and never queues a waiting callback. */
export class SerialProposalWorkflowScheduler implements ProposalWorkflowScheduler {
  #activeLease: ProposalWorkflowLease | undefined;
  #busyNotificationClaimed = false;

  async runExclusive<TResult>(
    workflow: (lease: ProposalWorkflowLease) => Promise<TResult>,
  ): Promise<TResult> {
    if (this.#activeLease !== undefined) {
      const shouldNotify = !this.#busyNotificationClaimed;
      this.#busyNotificationClaimed = true;
      throw new ProposalWorkflowBusyError(shouldNotify);
    }
    const lease = Object.freeze({}) as ProposalWorkflowLease;
    this.#activeLease = lease;
    this.#busyNotificationClaimed = false;
    try {
      return await workflow(lease);
    } finally {
      this.#activeLease = undefined;
      this.#busyNotificationClaimed = false;
    }
  }

  assertActive(lease: ProposalWorkflowLease): void {
    if (this.#activeLease !== lease) {
      throw new Error('The proposal workflow lease is not active for this scheduler.');
    }
  }
}
