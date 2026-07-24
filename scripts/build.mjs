import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const repositoryRootOptionIndexes = process.argv
  .map((argument, index) => (argument === '--repository-root' ? index : -1))
  .filter((index) => index >= 0);
if (repositoryRootOptionIndexes.length > 1) {
  throw new Error('--repository-root may be supplied only once.');
}
const repositoryRootOptionIndex = repositoryRootOptionIndexes[0];
const repositoryRootOption =
  repositoryRootOptionIndex === undefined ? undefined : process.argv[repositoryRootOptionIndex + 1];
if (
  repositoryRootOptionIndex !== undefined &&
  (repositoryRootOption === undefined ||
    repositoryRootOption.startsWith('--') ||
    !isAbsolute(repositoryRootOption))
) {
  throw new Error('--repository-root requires one absolute path.');
}
const repositoryRoot =
  repositoryRootOption === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(repositoryRootOption);
const distDirectory = resolve(repositoryRoot, 'dist');
const artifactDirectory = resolve(repositoryRoot, 'artifacts');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const allowTestCorePlaceholder =
  process.argv.includes('--allow-test-core-placeholder') &&
  process.env.OKF_TEST_CORE_PLACEHOLDER === '1';
const canonicalWasmPath =
  process.env.OKF_CANONICAL_WASM_PATH === undefined
    ? undefined
    : resolve(process.env.OKF_CANONICAL_WASM_PATH);
const canonicalWasmRoot = resolve(repositoryRoot, 'artifacts/canonical-wasm');
const allowCanonicalWasm =
  canonicalWasmPath !== undefined &&
  process.env.CI === 'true' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.OKF_ALLOW_CANONICAL_WASM === '1' &&
  dirname(canonicalWasmPath) === canonicalWasmRoot &&
  canonicalWasmPath === resolve(canonicalWasmRoot, 'okf_core.wasm');

if (production && watch) {
  throw new Error('Choose either --production or --watch, not both.');
}
if (canonicalWasmPath !== undefined && !allowCanonicalWasm) {
  throw new Error(
    'A canonical Wasm artifact is accepted only from the fixed GitHub Actions package-smoke path.',
  );
}
if (allowCanonicalWasm && allowTestCorePlaceholder) {
  throw new Error('Choose either a canonical Wasm artifact or the test-only placeholder.');
}

await rm(distDirectory, { force: true, recursive: true });
await mkdir(distDirectory, { recursive: true });
await mkdir(artifactDirectory, { recursive: true });

if (allowTestCorePlaceholder) {
  await writeFile(
    resolve(distDirectory, 'okf_core.wasm'),
    Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
} else if (allowCanonicalWasm) {
  await copyFile(canonicalWasmPath, resolve(distDirectory, 'okf_core.wasm'));
} else {
  execFileSync(
    'cargo',
    [
      'build',
      '--locked',
      '--target',
      'wasm32-unknown-unknown',
      '--release',
      '--package',
      'okf-wasm',
    ],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
  await copyFile(
    resolve(repositoryRoot, 'target/wasm32-unknown-unknown/release/okf_wasm.wasm'),
    resolve(distDirectory, 'okf_core.wasm'),
  );
}

const sharedOptions = {
  absWorkingDir: repositoryRoot,
  bundle: true,
  legalComments: 'eof',
  logLevel: 'info',
  metafile: true,
  minify: production,
  sourcemap: production ? false : 'external',
  sourcesContent: false,
};

const extensionOptions = {
  ...sharedOptions,
  entryPoints: ['src/extension/activate.ts'],
  external: ['vscode'],
  format: 'cjs',
  outfile: 'dist/extension.cjs',
  platform: 'node',
  target: 'node22',
};

const webviewOptions = {
  ...sharedOptions,
  entryNames: '[name]',
  entryPoints: ['src/webview/main.ts'],
  format: 'esm',
  outdir: 'dist/webview',
  platform: 'browser',
  target: 'es2022',
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);

  await Promise.all(contexts.map(async (context) => context.watch()));
  console.log('Watching extension-host and Webview sources.');

  const dispose = async () => {
    await Promise.all(contexts.map(async (context) => context.dispose()));
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void dispose();
  });
  process.once('SIGTERM', () => {
    void dispose();
  });

  await new Promise(() => undefined);
} else {
  const [extensionResult, webviewResult] = await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
  ]);
  const metadata = {
    production,
    targets: {
      extension: 'node22/commonjs',
      webview: 'es2022/esm',
      core: 'wasm32-unknown-unknown',
    },
    bundles: {
      extension: extensionResult.metafile,
      webview: webviewResult.metafile,
    },
    core: {
      abiVersion: 1,
      artifact: 'dist/okf_core.wasm',
      source: allowCanonicalWasm ? 'canonical-ci-artifact' : 'local-locked-build',
      wasi: false,
    },
  };

  await writeFile(
    resolve(artifactDirectory, 'build-metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}
