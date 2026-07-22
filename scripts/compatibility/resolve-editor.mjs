import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runEditorResolverCli } from './editor-resolver.mjs';

export {
  assertExtensionHostVersion,
  readEditorVersion,
  resolveAndVerifyEditor,
  resolveEditor,
  runEditorResolverCli,
  runProcess,
  spawnEditor,
} from './editor-resolver.mjs';

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await runEditorResolverCli();
}
