export interface VscodiumAssetPin {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ResolvedVscodiumAssetPin extends VscodiumAssetPin {
  readonly platform: 'linux' | 'darwin' | 'win32';
  readonly architecture: 'x64' | 'arm64';
  readonly url: string;
}

export interface CompatibilityPins {
  readonly schemaVersion: 1;
  readonly extensionId: 'straydog.okf-workbench';
  readonly nodeVersion: '24.18.0';
  readonly npmVersion: '11.16.0';
  readonly vscodeVersions: readonly ['1.121.0', '1.129.1'];
  readonly vscodium: {
    readonly releaseVersion: '1.121.03429';
    readonly expectedReportedVersion: '1.121.03429';
    readonly expectedExtensionHostVersion: '1.121.0';
    readonly publishedAt: string;
    readonly releaseUrl: string;
    readonly assets: Readonly<
      Record<
        'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64' | 'win32-arm64',
        VscodiumAssetPin
      >
    >;
  };
}

export const COMPATIBILITY_PINS: Readonly<CompatibilityPins>;

export function normalizePlatform(value?: string): 'linux' | 'darwin' | 'win32';
export function normalizeArchitecture(value?: string): 'x64' | 'arm64';
export function getVscodiumAsset(
  platform?: string,
  architecture?: string,
): ResolvedVscodiumAssetPin;
