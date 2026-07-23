export declare const FIRST_INTERACTIVE_FRAME_TIMEOUT_MS: 5000;

export interface AnimationFrameTiming {
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly setTimeout: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
}

export declare function waitForAnimationFramePredicate(
  predicate: () => unknown,
  timeoutMs: number,
  timing?: AnimationFrameTiming,
): Promise<boolean>;
