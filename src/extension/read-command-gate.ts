import type { OperationProblem } from '../core/model/index.js';

export type ReadCommandAdmission<TResult> =
  | { readonly admitted: true; readonly value: TResult }
  | { readonly admitted: false; readonly shouldNotify: boolean };

/**
 * Admits one selection/scheduling phase and rejects overlap without retaining the rejected work.
 * The rejected callback is deliberately not invoked, so an explicit root can never borrow the
 * active command's selection result.
 */
export class FailFastReadCommandGate {
  #active = false;
  #busyNotificationClaimed = false;

  async run<TResult>(operation: () => Promise<TResult>): Promise<ReadCommandAdmission<TResult>> {
    if (this.#active) {
      const shouldNotify = !this.#busyNotificationClaimed;
      this.#busyNotificationClaimed = true;
      return { admitted: false, shouldNotify };
    }

    this.#active = true;
    this.#busyNotificationClaimed = false;
    try {
      return { admitted: true, value: await operation() };
    } finally {
      this.#active = false;
      this.#busyNotificationClaimed = false;
    }
  }
}

export function readCommandBusyProblem(): OperationProblem {
  return {
    code: 'read-command-busy',
    message: 'Another OKF read command is selecting a bundle or scheduling its refresh.',
    correctiveAction:
      'Wait for that command to finish, then run Validate Bundle or Open 3D Graph again.',
  };
}
