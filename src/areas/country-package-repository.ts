import type { CountryBoundaryPackage, CountryCode, CountryManifestEntry } from './types';

/** A validated package and the exact manifest entry that authorized it. */
export interface CountryPackageCacheEntry {
  readonly countryCode: CountryCode;
  readonly manifest: CountryManifestEntry;
  readonly package: CountryBoundaryPackage;
}

/** Persistence port. Implementations must make each put an atomic replacement. */
export interface CountryPackageRepository {
  get(countryCode: CountryCode): Promise<CountryPackageCacheEntry | undefined>;
  put(entry: CountryPackageCacheEntry): Promise<void>;
  delete(countryCode: CountryCode): Promise<void>;
  list(): Promise<readonly CountryPackageCacheEntry[]>;
}
