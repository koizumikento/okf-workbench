import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPEN_VSX_REGISTRY_URL = 'https://open-vsx.org';
const MAX_ACCEPTED_CACHE_AGE_SECONDS = 30;
const MAX_ACCEPTED_CACHE_AGE_MILLISECONDS = MAX_ACCEPTED_CACHE_AGE_SECONDS * 1_000;
const STRICT_HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;

function requirePathSegment(value, label) {
  const containsControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value === '.' ||
    value === '..' ||
    containsControlCharacter ||
    /[/\\?#]/u.test(value)
  ) {
    throw new Error(`${label} must be a non-empty registry path segment.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('The Open VSX registry check clock must return a valid Date.');
  }
  return new Date(value.getTime());
}

function parseHttpDate(value, url) {
  const timestamp = STRICT_HTTP_DATE.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) {
    throw new Error(`Open VSX returned an invalid Date header for ${url}.`);
  }
  return timestamp;
}

function inspectResponseFreshness(headers, url, observedAt) {
  const ageHeader = headers.get('age');
  const dateHeader = headers.get('date');
  if (dateHeader === null) {
    throw new Error(`Open VSX omitted the response Date header for ${url}.`);
  }
  const responseDateTimestamp = parseHttpDate(dateHeader, url);

  if (ageHeader !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(ageHeader)) {
      throw new Error(`Open VSX returned an invalid cache Age header for ${url}.`);
    }
    const ageSeconds = Number(ageHeader);
    if (!Number.isSafeInteger(ageSeconds) || ageSeconds > MAX_ACCEPTED_CACHE_AGE_SECONDS) {
      throw new Error(
        `Open VSX returned a stale cached response for ${url} (Age ${ageHeader} seconds).`,
      );
    }
    return {
      ageSeconds,
      date: dateHeader,
      effectiveAgeSeconds: ageSeconds,
      validatedAt: observedAt.toISOString(),
      validationSource: 'age-header',
    };
  }

  const effectiveAgeMilliseconds = observedAt.getTime() - responseDateTimestamp;
  if (effectiveAgeMilliseconds < 0) {
    throw new Error(`Open VSX returned a future Date header for ${url}.`);
  }
  // The freshness window is inclusive: ages from zero through exactly 30 seconds pass.
  if (effectiveAgeMilliseconds > MAX_ACCEPTED_CACHE_AGE_MILLISECONDS) {
    throw new Error(
      `Open VSX returned a stale response Date for ${url} (${String(
        effectiveAgeMilliseconds / 1_000,
      )} seconds old).`,
    );
  }
  return {
    ageSeconds: null,
    date: dateHeader,
    effectiveAgeSeconds: effectiveAgeMilliseconds / 1_000,
    validatedAt: observedAt.toISOString(),
    validationSource: 'date-header',
  };
}

async function registryRequest(fetchImplementation, url, clock) {
  const response = await fetchImplementation(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache',
    },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  const freshness = inspectResponseFreshness(response.headers, url, readClock(clock));
  const text = await response.text();
  let body;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Open VSX returned non-JSON content for ${url}.`);
    }
  }
  return {
    body,
    freshness,
    status: response.status,
    url,
  };
}

export async function inspectOpenVsxRegistry(options) {
  const namespace = requirePathSegment(options.namespace, 'namespace');
  const extension = requirePathSegment(options.extension, 'extension');
  const version = requirePathSegment(options.version, 'version');
  const registry = new globalThis.URL(options.registryUrl ?? OPEN_VSX_REGISTRY_URL);
  if (
    registry.protocol !== 'https:' ||
    registry.username !== '' ||
    registry.password !== '' ||
    (registry.pathname !== '' && registry.pathname !== '/') ||
    registry.search !== '' ||
    registry.hash !== ''
  ) {
    throw new Error('registryUrl must be a credential-free HTTPS origin.');
  }
  const registryUrl = registry.origin;
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required for the Open VSX registry check.');
  }
  const clock = options.now ?? (() => new Date());

  const namespacePath = encodeURIComponent(namespace);
  const extensionPath = encodeURIComponent(extension);
  const versionPath = encodeURIComponent(version);
  const namespaceResult = await registryRequest(
    fetchImplementation,
    `${registryUrl}/api/${namespacePath}`,
    clock,
  );
  if (namespaceResult.status !== 200 || !isRecord(namespaceResult.body)) {
    throw new Error(
      `Open VSX namespace ${namespace} is unavailable (HTTP ${String(namespaceResult.status)}).`,
    );
  }
  if (namespaceResult.body.name !== namespace) {
    throw new Error(`Open VSX returned the wrong namespace identity for ${namespace}.`);
  }
  if (namespaceResult.body.verified !== true) {
    throw new Error(`Open VSX namespace ${namespace} is not verified.`);
  }
  if (namespaceResult.body.access !== 'restricted') {
    throw new Error(
      `Open VSX namespace ${namespace} access is ${String(namespaceResult.body.access)}; expected restricted.`,
    );
  }

  const extensionResult = await registryRequest(
    fetchImplementation,
    `${registryUrl}/api/${namespacePath}/${extensionPath}`,
    clock,
  );
  if (extensionResult.status !== 200 && extensionResult.status !== 404) {
    throw new Error(
      `Open VSX extension lookup for ${namespace}.${extension} failed (HTTP ${String(extensionResult.status)}).`,
    );
  }
  if (extensionResult.status === 200) {
    if (
      !isRecord(extensionResult.body) ||
      extensionResult.body.namespace !== namespace ||
      extensionResult.body.name !== extension
    ) {
      throw new Error(
        `Open VSX returned the wrong extension identity for ${namespace}.${extension}.`,
      );
    }
  }

  const versionResult = await registryRequest(
    fetchImplementation,
    `${registryUrl}/api/${namespacePath}/${extensionPath}/${versionPath}`,
    clock,
  );
  if (versionResult.status === 200) {
    throw new Error(`Open VSX version ${namespace}.${extension}@${version} already exists.`);
  }
  if (versionResult.status !== 404) {
    throw new Error(
      `Open VSX version lookup for ${namespace}.${extension}@${version} failed (HTTP ${String(versionResult.status)}).`,
    );
  }

  return {
    schemaVersion: 1,
    checkedAt: readClock(clock).toISOString(),
    registryUrl,
    namespace: {
      access: namespaceResult.body.access,
      name: namespace,
      verified: namespaceResult.body.verified,
    },
    extension: {
      exists: extensionResult.status === 200,
      id: `${namespace}.${extension}`,
      targetVersion: version,
      targetVersionAvailable: true,
    },
    freshness: {
      requestCacheMode: 'no-store',
      responses: {
        namespace: namespaceResult.freshness,
        extension: extensionResult.freshness,
        version: versionResult.freshness,
      },
    },
  };
}

export async function writeOpenVsxRegistryEvidence(path, evidence) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return outputPath;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [namespace, extension, version, outputPath] = process.argv.slice(2);
  if (
    namespace === undefined ||
    extension === undefined ||
    version === undefined ||
    process.argv.length > 6
  ) {
    throw new Error(
      'Usage: node scripts/check-open-vsx-registry.mjs <namespace> <extension> <version> [output-json]',
    );
  }

  const evidence = await inspectOpenVsxRegistry({ extension, namespace, version });
  if (outputPath !== undefined) {
    const writtenPath = await writeOpenVsxRegistryEvidence(outputPath, evidence);
    console.log(`Open VSX registry evidence written to ${writtenPath}.`);
  }
  console.log(
    `Open VSX registry check passed: ${evidence.extension.id}@${evidence.extension.targetVersion} is available in verified restricted namespace ${evidence.namespace.name}.`,
  );
}
