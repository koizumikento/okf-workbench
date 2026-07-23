export const OPEN_VSX_REGISTRY_URL: string;

export type OpenVsxRegistryResponseFreshness =
  | {
      readonly ageSeconds: number;
      readonly date: string;
      readonly effectiveAgeSeconds: number;
      readonly validatedAt: string;
      readonly validationSource: 'age-header';
    }
  | {
      readonly ageSeconds: null;
      readonly date: string;
      readonly effectiveAgeSeconds: number;
      readonly validatedAt: string;
      readonly validationSource: 'date-header';
    };

export interface OpenVsxRegistryEvidence {
  readonly schemaVersion: 1;
  readonly checkedAt: string;
  readonly registryUrl: string;
  readonly namespace: {
    readonly access: 'restricted';
    readonly name: string;
    readonly verified: true;
  };
  readonly extension: {
    readonly exists: boolean;
    readonly id: string;
    readonly targetVersion: string;
    readonly targetVersionAvailable: true;
  };
  readonly freshness: {
    readonly requestCacheMode: 'no-store';
    readonly responses: Readonly<
      Record<'namespace' | 'extension' | 'version', OpenVsxRegistryResponseFreshness>
    >;
  };
}

export interface InspectOpenVsxRegistryOptions {
  readonly namespace: string;
  readonly extension: string;
  readonly version: string;
  readonly registryUrl?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}

export function inspectOpenVsxRegistry(
  options: InspectOpenVsxRegistryOptions,
): Promise<OpenVsxRegistryEvidence>;

export function writeOpenVsxRegistryEvidence(
  path: string,
  evidence: OpenVsxRegistryEvidence,
): Promise<string>;
