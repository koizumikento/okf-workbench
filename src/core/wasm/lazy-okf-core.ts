import type { OkfCore } from './types.js';

/**
 * Delay Wasm compilation and instantiation until an OKF operation actually needs the core.
 *
 * Startup activation is used to expose the bundled CLI to integrated terminals. Keeping the
 * deterministic core lazy prevents that convenience path from paying the Wasm startup cost in
 * windows that never open an OKF bundle.
 */
export function createLazyOkfCore(load: () => OkfCore): OkfCore {
  let loaded: OkfCore | undefined;
  const get = (): OkfCore => {
    loaded ??= load();
    return loaded;
  };

  return {
    get abiVersion() {
      return get().abiVersion;
    },
    get coreVersion() {
      return get().coreVersion;
    },
    inspect: (...arguments_) => get().inspect(...arguments_),
    renderBundle: (...arguments_) => get().renderBundle(...arguments_),
    renderConcept: (...arguments_) => get().renderConcept(...arguments_),
    renderIndexes: (...arguments_) => get().renderIndexes(...arguments_),
    renderAgent: (...arguments_) => get().renderAgent(...arguments_),
  };
}
