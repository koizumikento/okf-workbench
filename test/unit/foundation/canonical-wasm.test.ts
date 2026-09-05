import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'vitest';

import {
  CANONICAL_WASM_METADATA_PATH,
  CANONICAL_WASM_PATH,
  captureWasmBuildInputs,
  readCanonicalWasm,
} from '../../../scripts/canonical-wasm.mjs';

const root = mkdtempSync(join(tmpdir(), 'okf-canonical-wasm-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('accepts receipt-bound Wasm and rejects binary, receipt, or Rust input drift', async () => {
  for (const directory of ['scripts', 'crates', 'artifacts/canonical-wasm']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'scripts/build.mjs',
    'scripts/canonical-wasm.mjs',
    'crates/lib.rs',
  ]) {
    writeFileSync(join(root, file), file);
  }
  const sourceInputSha256 = (await captureWasmBuildInputs(root)).sha256;
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const metadata = {
    core: {
      abiVersion: 1,
      artifact: 'dist/okf_core.wasm',
      wasi: false,
      sourceInputSha256,
      sha256: createHash('sha256').update(wasm).digest('hex'),
    },
  };
  writeFileSync(join(root, CANONICAL_WASM_PATH), wasm);
  writeFileSync(join(root, CANONICAL_WASM_METADATA_PATH), JSON.stringify(metadata));
  expect(await readCanonicalWasm(root, sourceInputSha256)).toEqual(wasm);

  writeFileSync(join(root, CANONICAL_WASM_PATH), Buffer.from('changed module'));
  await expect(readCanonicalWasm(root, sourceInputSha256)).rejects.toThrow('build receipt');
  writeFileSync(join(root, CANONICAL_WASM_PATH), wasm);
  writeFileSync(join(root, 'crates/lib.rs'), 'changed Rust source');
  await expect(
    readCanonicalWasm(root, (await captureWasmBuildInputs(root)).sha256),
  ).rejects.toThrow('current Rust inputs');
  writeFileSync(join(root, CANONICAL_WASM_METADATA_PATH), '{}');
  await expect(readCanonicalWasm(root, sourceInputSha256)).rejects.toThrow('build receipt');
});
