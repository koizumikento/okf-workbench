import { readFile, readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VirtualFixtureFile {
  readonly bytes: readonly number[];
  readonly path: string;
}

export interface FixtureExpectedFailure {
  readonly path: string;
  readonly reason: 'decode' | 'frontmatter' | 'markdown' | 'read' | 'resource-limit';
}

export interface FixtureExpectedFinding {
  readonly category: 'conformance' | 'curation' | 'compatibility';
  readonly code: string;
  readonly path: string;
}

export interface FixtureExpectedLink {
  readonly sourceId: string;
  readonly rawTarget: string;
  readonly kind:
    'internal' | 'broken' | 'external' | 'out-of-bundle' | 'fragment' | 'directory' | 'invalid';
  readonly targetId?: string;
  readonly fragment?: string;
  readonly query?: string;
}

export interface FixtureExpectedPathCase {
  readonly input: string;
  readonly normalizedConceptId: string;
}

export interface FixtureExpectedContract {
  readonly conceptIds: readonly string[];
  readonly reservedFiles: readonly string[];
  readonly parseFailures: readonly FixtureExpectedFailure[];
  readonly findings: readonly FixtureExpectedFinding[];
  readonly links: readonly FixtureExpectedLink[];
  readonly frontmatterByConceptId?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly pathCases?: readonly FixtureExpectedPathCase[];
}

export interface FixtureManifest {
  readonly description: string;
  readonly expected: FixtureExpectedContract;
  readonly files: readonly string[];
  readonly fixtureVersion: 1;
  readonly name: string;
  readonly virtualFiles: readonly VirtualFixtureFile[];
}

export interface LoadedFixture {
  readonly directory: string;
  readonly manifest: FixtureManifest;
}

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Fixture manifest field ${field} must be a non-empty string.`);
  }
  return value;
}

function requireStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Fixture manifest field ${field} must be a string.`);
  }
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Fixture manifest field ${field} must be an array.`);
  }
  return value;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  field: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(
      `Fixture manifest field ${field} contains unexpected keys: ${unexpected.join(', ')}.`,
    );
  }
}

function requireOneOf<const Values extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: Values,
): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`Fixture manifest field ${field} must be one of ${allowed.join(', ')}.`);
  }
  return value;
}

function requirePortableRelativePath(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (path.includes('\\') || posix.isAbsolute(path) || posix.normalize(path).startsWith('../')) {
    throw new TypeError(`Fixture path ${field} must be a bundle-relative POSIX path: ${path}`);
  }
  return path;
}

function decodeVirtualFile(value: unknown, index: number): VirtualFixtureFile {
  if (!isRecord(value) || !Array.isArray(value.bytes)) {
    throw new TypeError(`virtualFiles[${index}] must contain a byte array.`);
  }
  requireExactKeys(value, `virtualFiles[${index}]`, ['bytes', 'path']);
  const bytes = value.bytes.map((byte, byteIndex) => {
    if (!Number.isInteger(byte) || typeof byte !== 'number' || byte < 0 || byte > 255) {
      throw new TypeError(`virtualFiles[${index}].bytes[${byteIndex}] is not an octet.`);
    }
    return byte;
  });
  return {
    bytes,
    path: requirePortableRelativePath(value.path, `virtualFiles[${index}].path`),
  };
}

function decodeExpectedFailure(value: unknown, index: number): FixtureExpectedFailure {
  if (!isRecord(value)) {
    throw new TypeError(`expected.parseFailures[${index}] must be an object.`);
  }
  requireExactKeys(value, `expected.parseFailures[${index}]`, ['path', 'reason']);
  return {
    path: requirePortableRelativePath(value.path, `expected.parseFailures[${index}].path`),
    reason: requireOneOf(value.reason, `expected.parseFailures[${index}].reason`, [
      'decode',
      'frontmatter',
      'markdown',
      'read',
      'resource-limit',
    ] as const),
  };
}

function decodeExpectedFinding(value: unknown, index: number): FixtureExpectedFinding {
  if (!isRecord(value)) {
    throw new TypeError(`expected.findings[${index}] must be an object.`);
  }
  requireExactKeys(value, `expected.findings[${index}]`, ['category', 'code', 'path']);
  return {
    category: requireOneOf(value.category, `expected.findings[${index}].category`, [
      'conformance',
      'curation',
      'compatibility',
    ] as const),
    code: requireString(value.code, `expected.findings[${index}].code`),
    path: requirePortableRelativePath(value.path, `expected.findings[${index}].path`),
  };
}

function decodeExpectedLink(value: unknown, index: number): FixtureExpectedLink {
  if (!isRecord(value)) {
    throw new TypeError(`expected.links[${index}] must be an object.`);
  }
  requireExactKeys(value, `expected.links[${index}]`, [
    'sourceId',
    'rawTarget',
    'kind',
    'targetId',
    'fragment',
    'query',
  ]);
  return {
    sourceId: requireString(value.sourceId, `expected.links[${index}].sourceId`),
    rawTarget: requireStringValue(value.rawTarget, `expected.links[${index}].rawTarget`),
    kind: requireOneOf(value.kind, `expected.links[${index}].kind`, [
      'internal',
      'broken',
      'external',
      'out-of-bundle',
      'fragment',
      'directory',
      'invalid',
    ] as const),
    ...(value.targetId === undefined
      ? {}
      : { targetId: requireString(value.targetId, `expected.links[${index}].targetId`) }),
    ...(value.fragment === undefined
      ? {}
      : { fragment: requireStringValue(value.fragment, `expected.links[${index}].fragment`) }),
    ...(value.query === undefined
      ? {}
      : { query: requireStringValue(value.query, `expected.links[${index}].query`) }),
  };
}

function decodeExpectedPathCase(value: unknown, index: number): FixtureExpectedPathCase {
  if (!isRecord(value)) {
    throw new TypeError(`expected.pathCases[${index}] must be an object.`);
  }
  requireExactKeys(value, `expected.pathCases[${index}]`, ['input', 'normalizedConceptId']);
  return {
    input: requireString(value.input, `expected.pathCases[${index}].input`),
    normalizedConceptId: requireString(
      value.normalizedConceptId,
      `expected.pathCases[${index}].normalizedConceptId`,
    ),
  };
}

function decodeFrontmatterByConceptId(
  value: unknown,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  if (!isRecord(value)) {
    throw new TypeError('expected.frontmatterByConceptId must be an object.');
  }

  const decoded: Record<string, Readonly<Record<string, unknown>>> = Object.create(null) as Record<
    string,
    Readonly<Record<string, unknown>>
  >;
  for (const [conceptId, frontmatter] of Object.entries(value)) {
    requireString(conceptId, 'expected.frontmatterByConceptId concept ID');
    if (!isRecord(frontmatter)) {
      throw new TypeError(
        `expected.frontmatterByConceptId.${conceptId} must be a frontmatter object.`,
      );
    }
    decoded[conceptId] = frontmatter;
  }
  return decoded;
}

function decodeExpectedContract(value: Readonly<Record<string, unknown>>): FixtureExpectedContract {
  requireExactKeys(value, 'expected', [
    'conceptIds',
    'reservedFiles',
    'parseFailures',
    'findings',
    'links',
    'frontmatterByConceptId',
    'pathCases',
  ]);

  return {
    conceptIds: requireArray(value.conceptIds, 'expected.conceptIds').map((conceptId, index) =>
      requireString(conceptId, `expected.conceptIds[${index}]`),
    ),
    reservedFiles: requireArray(value.reservedFiles, 'expected.reservedFiles').map((path, index) =>
      requirePortableRelativePath(path, `expected.reservedFiles[${index}]`),
    ),
    parseFailures: requireArray(value.parseFailures, 'expected.parseFailures').map(
      decodeExpectedFailure,
    ),
    findings: requireArray(value.findings, 'expected.findings').map(decodeExpectedFinding),
    links: requireArray(value.links, 'expected.links').map(decodeExpectedLink),
    ...(value.frontmatterByConceptId === undefined
      ? {}
      : { frontmatterByConceptId: decodeFrontmatterByConceptId(value.frontmatterByConceptId) }),
    ...(value.pathCases === undefined
      ? {}
      : {
          pathCases: requireArray(value.pathCases, 'expected.pathCases').map(
            decodeExpectedPathCase,
          ),
        }),
  };
}

function decodeManifest(value: unknown): FixtureManifest {
  if (!isRecord(value) || value.fixtureVersion !== 1 || !isRecord(value.expected)) {
    throw new TypeError('Fixture manifest must use fixtureVersion 1 and define expected data.');
  }
  requireExactKeys(value, 'manifest', [
    'fixtureVersion',
    'name',
    'description',
    'files',
    'virtualFiles',
    'expected',
  ]);
  if (!Array.isArray(value.files)) {
    throw new TypeError('Fixture manifest field files must be an array.');
  }
  const virtualFiles = value.virtualFiles;
  if (!Array.isArray(virtualFiles)) {
    throw new TypeError('Fixture manifest field virtualFiles must be an array.');
  }
  return {
    description: requireString(value.description, 'description'),
    expected: decodeExpectedContract(value.expected),
    files: value.files.map((path, index) => requirePortableRelativePath(path, `files[${index}]`)),
    fixtureVersion: 1,
    name: requireString(value.name, 'name'),
    virtualFiles: virtualFiles.map(decodeVirtualFile),
  };
}

export async function listFixtureNames(): Promise<readonly string[]> {
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function loadFixture(name: string): Promise<LoadedFixture> {
  const safeName = requirePortableRelativePath(name, 'name');
  if (safeName.includes('/')) {
    throw new TypeError(`Fixture name must identify one direct child directory: ${name}`);
  }
  const directory = resolve(fixtureRoot, safeName);
  const source = await readFile(resolve(directory, 'expected.json'), 'utf8');
  const parsed: unknown = JSON.parse(source);
  return {
    directory,
    manifest: decodeManifest(parsed),
  };
}

export async function readFixtureFiles(
  fixture: LoadedFixture,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const physicalEntries = await Promise.all(
    fixture.manifest.files.map(async (path) => {
      const bytes = await readFile(resolve(fixture.directory, ...path.split('/')));
      return [path, new Uint8Array(bytes)] as const;
    }),
  );
  const virtualEntries = fixture.manifest.virtualFiles.map(
    ({ bytes, path }) => [path, Uint8Array.from(bytes)] as const,
  );
  return new Map([...physicalEntries, ...virtualEntries]);
}
