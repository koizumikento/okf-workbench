/**
 * Corrective text for a selected bundle that cannot currently be refreshed.
 *
 * Keep this message free of provider errors and bundle paths: those values can
 * contain user-controlled or sensitive workspace data.
 */
export const BUNDLE_UNAVAILABLE_NOTIFICATION =
  'OKF Workbench cannot refresh the selected bundle because it is unavailable or cannot be read. Restore workspace access or read permissions, then save a Markdown file or run OKF: Validate Bundle to retry.';

/**
 * Allows one availability notification per selected-root outage.
 *
 * Watch events are already debounced by the runtime. This additional state gate
 * prevents separate watcher batches from creating a notification storm while a
 * provider remains unavailable. A successful publication starts a new outage
 * window, so a later failure remains visible to the user.
 */
export class RuntimeAvailabilityNotificationState {
  #root: string | undefined;
  #failureNotified = false;

  public select(root: string): void {
    if (this.#root === root) {
      return;
    }
    this.#root = root;
    this.#failureNotified = false;
  }

  public shouldNotifyFailure(root: string): boolean {
    this.select(root);
    if (this.#failureNotified) {
      return false;
    }
    this.#failureNotified = true;
    return true;
  }

  /** Returns true when this publication recovered a previously notified outage. */
  public recordPublication(root: string): boolean {
    this.select(root);
    const recovered = this.#failureNotified;
    this.#failureNotified = false;
    return recovered;
  }

  public clear(): void {
    this.#root = undefined;
    this.#failureNotified = false;
  }
}
