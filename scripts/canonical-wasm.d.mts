import type { PerformanceInputSnapshot } from './performance-input-snapshot.mjs';

export declare const CANONICAL_WASM_PATH: string;
export declare const CANONICAL_WASM_METADATA_PATH: string;
export declare function captureWasmBuildInputs(root: string): Promise<PerformanceInputSnapshot>;
export declare function readCanonicalWasm(
  root: string,
  sourceInputSha256: string,
): Promise<Uint8Array>;
