export declare const PERFORMANCE_BUNDLE_HASH_DOMAIN: string;

export interface PerformanceBundleSet {
  readonly extensionHostJavaScript: Uint8Array;
  readonly webviewJavaScript: Uint8Array;
  readonly webviewCss: Uint8Array;
}

export declare function hashPerformanceBundleSet(bundleSet: PerformanceBundleSet): string;
