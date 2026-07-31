import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GraphResourceLimitError } from '../graph/index.js';
import { hasUnpairedUtf16Surrogate, type JsonValue, type ParseFailure } from '../model/index.js';
import type { MigrationPlan } from '../migration/index.js';
import type { ParseBundleInput } from '../parser/index.js';
import type {
  BundleDirectoryInput,
  BundlePreset,
  ConceptTemplateInput,
  RenderedTemplateFile,
} from '../templates/index.js';
import { OKF_CORE_ABI_VERSION, type OkfCore, type OkfCoreInspection } from './types.js';

interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

type WasmModule = object;

interface WasmRuntime {
  readonly Module: {
    new (bytes: Uint8Array): WasmModule;
    imports(module: WasmModule): readonly unknown[];
  };
  readonly Instance: new (
    module: WasmModule,
    imports: Readonly<Record<string, unknown>>,
  ) => { readonly exports: Readonly<Record<string, unknown>> };
}

interface OkfWasmExports {
  readonly memory: WasmMemory;
  readonly okf_abi_version: () => number;
  readonly okf_alloc: (length: number) => number;
  readonly okf_dealloc: (pointer: number, length: number) => void;
  readonly okf_call: (pointer: number, length: number) => bigint;
}

interface CoreResponse {
  readonly abiVersion: number;
  readonly coreVersion: string;
  readonly result?: JsonValue;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export class OkfCoreUnavailableError extends Error {
  public override readonly name = 'OkfCoreUnavailableError';
}

export function loadPackagedWasmOkfCore(): OkfCore {
  return createWasmOkfCore(readFileSync(join(__dirname, 'okf_core.wasm')));
}

export function createWasmOkfCore(bytes: Uint8Array): OkfCore {
  const wasm = (globalThis as unknown as { readonly WebAssembly: WasmRuntime }).WebAssembly;
  let module: WasmModule;
  try {
    module = new wasm.Module(bytes);
  } catch (error: unknown) {
    throw unavailable('The packaged OKF core is not valid WebAssembly.', error);
  }
  const imports = wasm.Module.imports(module);
  if (imports.length !== 0) {
    throw new OkfCoreUnavailableError(
      `The packaged OKF core requested ${String(imports.length)} ambient import(s); a capability-free module is required.`,
    );
  }

  let instance: { readonly exports: Readonly<Record<string, unknown>> };
  try {
    instance = new wasm.Instance(module, {});
  } catch (error: unknown) {
    throw unavailable('The packaged OKF core could not be instantiated.', error);
  }
  const exports = decodeExports(instance.exports);
  const abiVersion = exports.okf_abi_version();
  if (abiVersion !== OKF_CORE_ABI_VERSION) {
    throw new OkfCoreUnavailableError(
      `The packaged OKF core uses ABI ${String(abiVersion)}, but the extension requires ABI ${String(OKF_CORE_ABI_VERSION)}.`,
    );
  }
  const metadata = callCore(exports, { operation: 'metadata' });
  if (!isObject(metadata) || typeof metadata['coreVersion'] !== 'string') {
    throw new OkfCoreUnavailableError('The packaged OKF core returned invalid metadata.');
  }
  const coreVersion = metadata['coreVersion'];

  return {
    abiVersion: OKF_CORE_ABI_VERSION,
    coreVersion,
    inspect: (
      input: ParseBundleInput,
      now: Date | string,
      failures: readonly ParseFailure[] = [],
    ): OkfCoreInspection => {
      if (
        now instanceof Date &&
        (!Number.isFinite(now.getTime()) || now.getUTCFullYear() < 0 || now.getUTCFullYear() > 9999)
      ) {
        throw new TypeError('ValidationOptions.now must be a valid Date or ISO date-time string.');
      }
      const result = callCore(exports, {
        operation: 'inspect',
        input: {
          bundle: jsonBundleInput(input),
          now: now instanceof Date ? now.toISOString() : now,
          failures: jsonFailures(failures),
        },
      });
      if (
        !isObject(result) ||
        !isObject(result['bundle']) ||
        !Array.isArray(result['findings']) ||
        !isObject(result['graph'])
      ) {
        throw new OkfCoreUnavailableError('The OKF core returned an invalid inspection result.');
      }
      // The Rust boundary produced these values from explicit serializable structs. Structural
      // checks above keep corrupted or version-skewed responses from entering the runtime.
      return result as unknown as OkfCoreInspection;
    },
    renderBundle: (preset: BundlePreset, timestamp: string): readonly RenderedTemplateFile[] =>
      renderedFiles(
        callCore(exports, {
          operation: 'renderBundle',
          input: { preset, timestamp },
        }),
      ),
    renderConcept: (input: ConceptTemplateInput): RenderedTemplateFile => {
      const result = callCore(exports, {
        operation: 'renderConcept',
        input: input as unknown as JsonValue,
      });
      if (!isRenderedFile(result)) {
        throw new OkfCoreUnavailableError('The OKF core returned an invalid concept template.');
      }
      return result;
    },
    renderIndexes: (
      input: ParseBundleInput,
      mode: 'missing' | 'all',
    ): readonly RenderedTemplateFile[] =>
      renderedFiles(
        callCore(exports, {
          operation: 'renderIndexes',
          input: { bundle: jsonBundleInput(input), mode },
        }),
      ),
    renderAgent: (
      target: 'agents' | 'skill' | 'both',
      bundlePath: BundleDirectoryInput,
    ): readonly RenderedTemplateFile[] =>
      renderedFiles(
        callCore(exports, {
          operation: 'renderAgent',
          input: {
            target,
            bundlePath: bundlePath as unknown as JsonValue,
          },
        }),
      ),
    migrate: (input: ParseBundleInput, actor: string): MigrationPlan => {
      const result = callCore(exports, {
        operation: 'migrate',
        input: { bundle: jsonBundleInput(input), actor },
      });
      if (
        !isObject(result) ||
        typeof result['fromVersion'] !== 'string' ||
        result['toVersion'] !== '0.2' ||
        !Array.isArray(result['files']) ||
        !Array.isArray(result['documents'])
      ) {
        throw new OkfCoreUnavailableError('The OKF core returned an invalid migration plan.');
      }
      return result as unknown as MigrationPlan;
    },
  };
}

function jsonBundleInput(input: ParseBundleInput): JsonValue {
  const invalidRootUriUtf16 = hasUnpairedUtf16Surrogate(input.rootUri);
  return {
    rootUri: invalidRootUriUtf16 ? '<bundle-root-uri-invalid-unicode>' : input.rootUri,
    revision: input.revision,
    ...(invalidRootUriUtf16 ? { invalidRootUriUtf16: true } : {}),
    documents: input.documents.map((document) => {
      const invalidUri = hasUnpairedUtf16Surrogate(document.uri);
      const invalidBundlePath = hasUnpairedUtf16Surrogate(document.bundlePath);
      const invalidContentHash =
        document.identityOnlyFailure === undefined &&
        document.contentHash !== undefined &&
        hasUnpairedUtf16Surrogate(document.contentHash);
      const invalidUtf16Fields = {
        uri: invalidUri,
        bundlePath: invalidBundlePath,
        contentHash: invalidContentHash,
      };
      const identity = {
        uri: invalidUri ? '<provider-uri-invalid-unicode>' : document.uri,
        bundlePath: invalidBundlePath ? '<provider-path-invalid-unicode>.md' : document.bundlePath,
        ...(invalidUri || invalidBundlePath || invalidContentHash ? { invalidUtf16Fields } : {}),
      };
      if (document.identityOnlyFailure !== undefined) {
        return {
          ...identity,
          identityOnlyFailure: {
            reason: document.identityOnlyFailure.reason,
            message: hasUnpairedUtf16Surrogate(document.identityOnlyFailure.message)
              ? 'Provider failure detail contains an unpaired UTF-16 surrogate.'
              : document.identityOnlyFailure.message,
          },
        };
      }
      if (typeof document.content === 'string' && hasUnpairedUtf16Surrogate(document.content)) {
        return {
          ...identity,
          content: { invalidUtf16: true },
          ...(!invalidContentHash
            ? {
                contentHash: document.contentHash ?? fallbackUtf16ContentHash(document.content),
              }
            : {}),
        };
      }
      return {
        ...identity,
        content:
          typeof document.content === 'string' ? document.content : Array.from(document.content),
        ...(document.contentHash === undefined || invalidContentHash
          ? {}
          : { contentHash: document.contentHash }),
      };
    }),
  };
}

function jsonFailures(failures: readonly ParseFailure[]): JsonValue {
  return failures.map((failure) => {
    if (hasUnpairedUtf16Surrogate(failure.uri)) {
      throw new GraphResourceLimitError('Parse failure URI contains an unpaired UTF-16 surrogate.');
    }
    if (failure.bundlePath.length > 0 && hasUnpairedUtf16Surrogate(failure.bundlePath)) {
      throw new GraphResourceLimitError(
        'Parse failure path contains an unpaired UTF-16 surrogate.',
      );
    }
    return {
      ...failure,
      message: hasUnpairedUtf16Surrogate(failure.message)
        ? 'Parse failure detail contains an unpaired UTF-16 surrogate.'
        : failure.message,
    } as unknown as JsonValue;
  });
}

function fallbackUtf16ContentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let offset = 0; offset < text.length; offset += 1) {
    const codeUnit = text.charCodeAt(offset);
    hash ^= codeUnit & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= codeUnit >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-utf16:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function callCore(exports: OkfWasmExports, request: JsonValue): JsonValue {
  const requestBytes = new TextEncoder().encode(JSON.stringify(request));
  const requestPointer = exports.okf_alloc(requestBytes.byteLength);
  if (requestBytes.byteLength > 0) {
    new Uint8Array(exports.memory.buffer, requestPointer, requestBytes.byteLength).set(
      requestBytes,
    );
  }

  let packed: bigint;
  try {
    packed = exports.okf_call(requestPointer, requestBytes.byteLength);
  } catch (error: unknown) {
    throw unavailable('The OKF core trapped while processing a request.', error);
  }
  const responsePointer = Number(packed >> 32n);
  const responseLength = Number(packed & 0xffff_ffffn);
  if (
    !Number.isSafeInteger(responsePointer) ||
    !Number.isSafeInteger(responseLength) ||
    responsePointer < 0 ||
    responseLength <= 0 ||
    responsePointer + responseLength > exports.memory.buffer.byteLength
  ) {
    throw new OkfCoreUnavailableError('The OKF core returned an invalid memory range.');
  }

  let responseText: string;
  try {
    const responseBytes = new Uint8Array(
      exports.memory.buffer,
      responsePointer,
      responseLength,
    ).slice();
    responseText = new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
  } catch (error: unknown) {
    throw unavailable('The OKF core returned invalid UTF-8.', error);
  } finally {
    exports.okf_dealloc(responsePointer, responseLength);
  }

  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch (error: unknown) {
    throw unavailable('The OKF core returned invalid JSON.', error);
  }
  if (
    !isCoreResponse(response) ||
    response.abiVersion !== OKF_CORE_ABI_VERSION ||
    typeof response.coreVersion !== 'string'
  ) {
    throw new OkfCoreUnavailableError('The OKF core returned an incompatible response envelope.');
  }
  if (response.error !== undefined) {
    if (response.error.code === 'invalid-request') {
      throw new TypeError(response.error.message);
    }
    if (response.error.code === 'unsafe-relative-path') {
      throw new Error(response.error.message);
    }
    if (response.error.code === 'graph-resource-limit') {
      throw new GraphResourceLimitError(response.error.message);
    }
    throw new OkfCoreUnavailableError(
      `The OKF core refused the request (${response.error.code}): ${response.error.message}`,
    );
  }
  if (response.result === undefined) {
    throw new OkfCoreUnavailableError('The OKF core response contains no result.');
  }
  return response.result;
}

function decodeExports(exports: Readonly<Record<string, unknown>>): OkfWasmExports {
  const candidate = exports as Partial<OkfWasmExports>;
  if (
    !isObject(candidate.memory) ||
    !(candidate.memory['buffer'] instanceof ArrayBuffer) ||
    typeof candidate.okf_abi_version !== 'function' ||
    typeof candidate.okf_alloc !== 'function' ||
    typeof candidate.okf_dealloc !== 'function' ||
    typeof candidate.okf_call !== 'function'
  ) {
    throw new OkfCoreUnavailableError('The packaged OKF core is missing required ABI exports.');
  }
  return candidate as OkfWasmExports;
}

function isCoreResponse(value: unknown): value is CoreResponse {
  if (!isObject(value)) {
    return false;
  }
  const error = value['error'];
  return (
    typeof value['abiVersion'] === 'number' &&
    typeof value['coreVersion'] === 'string' &&
    (error === undefined ||
      (isObject(error) &&
        typeof error['code'] === 'string' &&
        typeof error['message'] === 'string'))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderedFiles(value: JsonValue): readonly RenderedTemplateFile[] {
  if (!Array.isArray(value) || !value.every(isRenderedFile)) {
    throw new OkfCoreUnavailableError('The OKF core returned invalid generated files.');
  }
  return value;
}

function isRenderedFile(value: unknown): value is RenderedTemplateFile {
  return (
    isObject(value) &&
    typeof value['relativePath'] === 'string' &&
    value['encoding'] === 'utf8' &&
    typeof value['content'] === 'string'
  );
}

function unavailable(message: string, cause: unknown): OkfCoreUnavailableError {
  const error = new OkfCoreUnavailableError(message);
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
}
