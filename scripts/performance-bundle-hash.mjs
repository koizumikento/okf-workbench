import { createHash } from 'node:crypto';

export const PERFORMANCE_BUNDLE_HASH_DOMAIN = 'okf-workbench.performance-production-bundle-set.v1';

const COMPONENTS = Object.freeze([
  Object.freeze({ key: 'extensionHostJavaScript', label: 'dist/extension.cjs' }),
  Object.freeze({ key: 'webviewJavaScript', label: 'dist/webview/main.js' }),
  Object.freeze({ key: 'webviewCss', label: 'dist/webview/main.css' }),
]);

function bytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array.`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function framedHeader(label, byteLength) {
  const labelBytes = Buffer.from(label, 'utf8');
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(labelBytes.length, 0);
  header.writeBigUInt64BE(BigInt(byteLength), 4);
  return { header, labelBytes };
}

export function hashPerformanceBundleSet(bundleSet) {
  if (typeof bundleSet !== 'object' || bundleSet === null || Array.isArray(bundleSet)) {
    throw new TypeError('bundleSet must contain the three production bundle byte sequences.');
  }

  const hash = createHash('sha256');
  hash.update(`${PERFORMANCE_BUNDLE_HASH_DOMAIN}\0`, 'utf8');
  for (const component of COMPONENTS) {
    const content = bytes(bundleSet[component.key], component.label);
    const { header, labelBytes } = framedHeader(component.label, content.length);
    hash.update(header);
    hash.update(labelBytes);
    hash.update(content);
  }
  return hash.digest('hex');
}
