import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createVSIX } from '@vscode/vsce';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../../node_modules/ovsx/bin/ovsx', import.meta.url));

test('Open VSX CLI retains release argument and prepackaged-upload compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okf-ovsx-cli-'));
  const packagePath = join(root, 'retained.vsix');
  const uploads: Buffer[] = [];
  const authenticatedPaths: string[] = [];
  let duplicate = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/version') {
      response.end(JSON.stringify({ version: '1.3.0', maxExtensionSize: 1024 * 1024 }));
      return;
    }
    if (request.headers.authorization !== 'Bearer test-only-token') {
      response.writeHead(401).end(JSON.stringify({ error: 'Test token required' }));
      return;
    }
    authenticatedPaths.push(url.pathname);
    if (url.pathname === '/api/straydog/verify-pat') {
      response.end('{}');
    } else if (url.pathname === '/api/-/size-limit') {
      response.end(JSON.stringify({ maxSize: 1024 * 1024 }));
    } else if (url.pathname === '/api/-/publish') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      uploads.push(Buffer.concat(chunks));
      if (duplicate) {
        response
          .writeHead(400)
          .end(JSON.stringify({ error: 'Test version is already published.' }));
      } else {
        response.end(
          JSON.stringify({
            namespace: 'straydog',
            name: 'cli-test',
            version: '0.0.0',
            targetPlatform: 'universal',
          }),
        );
      }
    } else {
      response.writeHead(404).end(JSON.stringify({ error: 'Unexpected test request' }));
    }
  });

  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'cli-test',
        publisher: 'straydog',
        version: '0.0.0',
        engines: { vscode: '^1.123.0' },
        repository: { type: 'git', url: 'https://github.com/koizumikento/okf-workbench.git' },
        license: 'MIT',
      }),
    );
    await writeFile(join(root, 'README.md'), '# CLI fixture\n');
    await writeFile(join(root, 'LICENSE'), 'Test fixture only\n');
    await createVSIX({ cwd: root, packagePath, dependencies: false });
    const retained = await readFile(packagePath);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test server');
    const run = (args: string[]) =>
      execute(process.execPath, [cli, ...args], {
        timeout: 10_000,
        env: {
          ...process.env,
          OVSX_REGISTRY_URL: `http://127.0.0.1:${address.port}`,
          OVSX_PAT: 'test-only-token',
        },
      });

    expect((await run(['--version'])).stdout.trim()).toBe('1.3.0');
    expect((await run(['publish', '--help'])).stdout).toContain('--skip-duplicate');
    expect((await run(['verify-pat', 'straydog'])).stdout).toContain('PAT valid');
    expect((await run(['publish', packagePath, '--skip-duplicate'])).stdout).toContain('Published');
    duplicate = true;
    expect((await run(['publish', packagePath, '--skip-duplicate'])).stdout).toContain('Skipping');
    await expect(run(['publish', packagePath])).rejects.toMatchObject({ code: 1 });
    expect(uploads).toEqual([retained, retained, retained]);
    expect(await readFile(packagePath)).toEqual(retained);
    expect(authenticatedPaths).toContain('/api/straydog/verify-pat');
    const requestCount = authenticatedPaths.length;
    await expect(run(['verify-pat', 'straydog', 'extra'])).rejects.toMatchObject({ code: 1 });
    await expect(run(['publish', packagePath, 'extra', '--skip-duplicate'])).rejects.toMatchObject({
      code: 1,
    });
    expect(authenticatedPaths).toHaveLength(requestCount);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
