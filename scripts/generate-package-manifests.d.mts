export interface PackageManifestOptions {
  readonly tag: string;
  readonly repository: string;
  readonly macosArm64Sha256: string;
  readonly macosX64Sha256: string;
  readonly windowsX64Sha256: string;
}

export interface WritePackageManifestOptions extends PackageManifestOptions {
  readonly outputDirectory: string;
}

export interface RenderedPackageManifests {
  readonly homebrew: string;
  readonly scoop: string;
}

export function renderPackageManifests(options: PackageManifestOptions): RenderedPackageManifests;

export function writePackageManifests(options: WritePackageManifestOptions): Promise<{
  readonly homebrewPath: string;
  readonly scoopPath: string;
}>;
