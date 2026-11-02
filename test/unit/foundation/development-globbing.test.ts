import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { ESLint } from 'eslint';
import { glob, globStream, type GlobOptions } from 'glob';
import { Minimatch } from 'minimatch';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const lookupFiles = require('mocha/lib/cli/lookup-files.js') as (
  pattern: string,
  extensions: string[],
) => string[];
const TestExclude = require('test-exclude') as new (options: {
  cwd: string;
  include: string[];
  exclude: string[];
  extension: string[];
}) => { glob(): Promise<string[]>; globSync(): string[] };
const roots = new Set<string>();

async function fixture(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okf-development-globs-'));
  roots.add(root);
  for (const file of files) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'const unused = 1;\n');
  }
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('patched development globbing dependencies', () => {
  test('caps optimized parent traversal pattern expansion', () => {
    const pattern = `${'**/../a/b/'.repeat(8)}x.ts`;
    const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 64 });

    expect(matcher.globParts.length).toBeLessThanOrEqual(64);
    expect(new Minimatch('src/**/!(*.test).{ts,mjs}').match('src/nested/名前.mjs')).toBe(true);
    expect(new Minimatch('src/**/!(*.test).{ts,mjs}').match('src/nested/a.test.ts')).toBe(false);
  });

  test.each(['promise', 'stream'] as const)(
    '%s traversal stops filesystem reads when aborted during the first directory read',
    async (mode) => {
      const root = await fixture(['a/b/c/file.js', 'd/e/f/file.js']);
      const controller = new AbortController();
      const reason = new Error('test-only traversal cancellation');
      let reads = 0;
      const options: GlobOptions = {
        cwd: root,
        nodir: true,
        signal: controller.signal,
        fs: {
          readdir(path, options, callback) {
            reads++;
            setImmediate(() => {
              const entries = readdirSync(path, options);
              if (reads === 1) controller.abort(reason);
              callback(null, entries);
            });
          },
        },
      };
      const walk = async () => {
        if (mode === 'promise') await glob('**/*', options);
        else for await (const entry of globStream('**/*', options)) void entry;
      };

      await expect(walk()).rejects.toBe(reason);
      for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(1);
    },
  );

  test('ESLint still discovers nested and Unicode files and respects ignored directories', async () => {
    const root = await fixture(['src/entry.js', 'src/nested/名前 space.js', 'ignored/skip.js']);
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [{ ignores: ['ignored/**'] }, { rules: { 'no-unused-vars': 'error' } }],
    });

    const results = await eslint.lintFiles(['**/*.js']);

    expect(
      results.map((result) => relative(root, result.filePath).replaceAll('\\', '/')).sort(),
    ).toEqual(['src/entry.js', 'src/nested/名前 space.js']);
    expect(results.every((result) => result.errorCount === 1)).toBe(true);
  });

  test('Mocha discovery and coverage include/exclude globs retain their results', async () => {
    const root = await fixture([
      'src/entry.js',
      'src/nested/名前 space.js',
      'src/skip.js',
      'test/a.test.js',
      'test/nested/b.test.js',
    ]);
    const exclude = new TestExclude({
      cwd: root,
      include: ['src/**/*.js'],
      exclude: ['**/skip.js'],
      extension: ['.js'],
    });
    const expected = ['src/entry.js', 'src/nested/名前 space.js'];
    const negatedExclude = new TestExclude({
      cwd: root,
      include: ['src/**/*.js'],
      exclude: ['src/**', '!src/nested/**'],
      extension: ['.js'],
    });

    expect((await exclude.glob()).sort()).toEqual(expected);
    expect(exclude.globSync().sort()).toEqual(expected);
    expect(await negatedExclude.glob()).toEqual(['src/nested/名前 space.js']);
    expect(negatedExclude.globSync()).toEqual(['src/nested/名前 space.js']);
    expect(
      lookupFiles(join(root, 'test', '**', '*.test.js'), ['js'])
        .map((path) => relative(root, path).replaceAll('\\', '/'))
        .sort(),
    ).toEqual(['test/a.test.js', 'test/nested/b.test.js']);
  });
});
