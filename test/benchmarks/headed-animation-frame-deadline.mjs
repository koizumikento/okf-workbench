export const FIRST_INTERACTIVE_FRAME_TIMEOUT_MS = 5_000;

export function waitForAnimationFramePredicate(
  predicate,
  timeoutMs,
  timing = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: globalThis.requestAnimationFrame.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
  },
) {
  if (typeof predicate !== 'function') {
    throw new TypeError('The animation-frame predicate must be a function.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('The animation-frame deadline must be a positive finite duration.');
  }

  return new Promise((resolve, reject) => {
    let animationFrame;
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      timing.clearTimeout(deadline);
      if (animationFrame !== undefined) timing.cancelAnimationFrame(animationFrame);
      resolve(outcome);
    };
    const testPredicate = () => {
      try {
        return Boolean(predicate());
      } catch (error) {
        if (!settled) {
          settled = true;
          timing.clearTimeout(deadline);
          if (animationFrame !== undefined) timing.cancelAnimationFrame(animationFrame);
          reject(error);
        }
        return undefined;
      }
    };
    const poll = () => {
      if (settled) return;
      const outcome = testPredicate();
      if (outcome === undefined) return;
      if (outcome) {
        settle(true);
      } else {
        animationFrame = timing.requestAnimationFrame(poll);
      }
    };
    const deadline = timing.setTimeout(() => {
      const outcome = testPredicate();
      if (outcome !== undefined) settle(outcome);
    }, timeoutMs);
    poll();
  });
}
