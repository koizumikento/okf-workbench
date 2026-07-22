import {
  preserveProviderBundleDirectory,
  type ProviderBundleDirectory,
} from '../../core/templates/index.js';
import { isUriContained, type UriIdentity } from '../workspace/pathSafety.js';

function withoutTrailingSlashes(value: string): string {
  return value === '/' ? value : value.replace(/\/+$/u, '');
}

/** Returns the actual bundle location relative to its integration root. */
export function bundlePathWithinIntegrationRoot(
  integrationRoot: UriIdentity,
  bundleRoot: UriIdentity,
): ProviderBundleDirectory | undefined {
  if (!isUriContained(integrationRoot, bundleRoot)) {
    return undefined;
  }

  const integrationPath = withoutTrailingSlashes(integrationRoot.path);
  const bundlePath = withoutTrailingSlashes(bundleRoot.path);
  if (integrationPath === bundlePath) {
    const currentDirectory = preserveProviderBundleDirectory('.');
    return currentDirectory.ok ? currentDirectory.value : undefined;
  }

  const relative =
    integrationPath === '/' ? bundlePath.slice(1) : bundlePath.slice(integrationPath.length + 1);
  const providerPath = preserveProviderBundleDirectory(relative);
  return providerPath.ok ? providerPath.value : undefined;
}
