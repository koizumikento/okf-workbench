import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = resolve(repositoryRoot, 'dist');
const artifactDirectory = resolve(repositoryRoot, 'artifacts');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

if (production && watch) {
  throw new Error('Choose either --production or --watch, not both.');
}

await rm(distDirectory, { force: true, recursive: true });
await mkdir(distDirectory, { recursive: true });
await mkdir(artifactDirectory, { recursive: true });

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
    },
    bundles: {
      extension: extensionResult.metafile,
      webview: webviewResult.metafile,
    },
  };

  await writeFile(
    resolve(artifactDirectory, 'build-metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}
