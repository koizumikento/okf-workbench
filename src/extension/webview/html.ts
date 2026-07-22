import { randomBytes } from 'node:crypto';

export interface GraphWebviewAssets {
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styleUri: string;
}

/** Generates a cryptographically random nonce for one HTML render. */
export function createWebviewNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** Static shell only: bundle content and metadata are never interpolated into HTML. */
export function createGraphWebviewHtml(assets: GraphWebviewAssets, nonce: string): string {
  const cspSource = escapeAttribute(assets.cspSource);
  const scriptUri = escapeAttribute(assets.scriptUri);
  const styleUri = escapeAttribute(assets.styleUri);
  const safeNonce = escapeAttribute(nonce);
  const policy = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${safeNonce}'`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${policy};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OKF 3D Graph</title>
    <link rel="stylesheet" href="${styleUri}">
  </head>
  <body>
    <div data-okf-workbench-root></div>
    <script type="module" nonce="${safeNonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
