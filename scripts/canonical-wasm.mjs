import { createHash } from 'node:crypto';

import { captureStableInputSnapshot } from './performance-input-snapshot.mjs';

export const CANONICAL_WASM_PATH = 'artifacts/canonical-wasm/okf_core.wasm';
export const CANONICAL_WASM_METADATA_PATH = 'artifacts/canonical-wasm/build-metadata.json';

export async function captureWasmBuildInputs(root) {
  return captureStableInputSnapshot(root, {
    files: [
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'scripts/build.mjs',
      'scripts/canonical-wasm.mjs',
    ],
    directories: ['crates'],
  });
}

export async function readCanonicalWasm(root, sourceInputSha256) {
  const snapshot = await captureStableInputSnapshot(root, {
    files: [CANONICAL_WASM_PATH, CANONICAL_WASM_METADATA_PATH],
  });
  const wasm = snapshot.entries.find((entry) => entry.relativePath === CANONICAL_WASM_PATH).content;
  const metadata = JSON.parse(
    snapshot.entries
      .find((entry) => entry.relativePath === CANONICAL_WASM_METADATA_PATH)
      .content.toString('utf8'),
  );
  if (
    metadata.core?.abiVersion !== 1 ||
    metadata.core?.artifact !== 'dist/okf_core.wasm' ||
    metadata.core?.wasi !== false ||
    metadata.core?.sourceInputSha256 !== sourceInputSha256 ||
    metadata.core?.sha256 !== createHash('sha256').update(wasm).digest('hex')
  ) {
    throw new Error('Canonical Wasm does not match its build receipt and current Rust inputs.');
  }
  return wasm;
}
