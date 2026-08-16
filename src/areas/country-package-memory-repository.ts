import type { CountryCode } from './types';
import type { CountryPackageCacheEntry, CountryPackageRepository } from './country-package-repository';

/** Test/local adapter that models copy-then-swap persistence semantics. */
export class CountryPackageMemoryRepository implements CountryPackageRepository {
  private entries: Map<CountryCode, CountryPackageCacheEntry>;

  constructor(initial: readonly CountryPackageCacheEntry[] = []) {
    this.entries = new Map(initial.map((entry) => [entry.countryCode, structuredClone(entry)]));
  }

  async get(countryCode: CountryCode): Promise<CountryPackageCacheEntry | undefined> {
    const entry = this.entries.get(countryCode);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async put(entry: CountryPackageCacheEntry): Promise<void> {
    const replacement = structuredClone(entry);
    const next = new Map(this.entries);
    next.set(entry.countryCode, replacement);
    this.entries = next;
  }

  async delete(countryCode: CountryCode): Promise<void> {
    const next = new Map(this.entries);
    next.delete(countryCode);
    this.entries = next;
  }

  async list(): Promise<readonly CountryPackageCacheEntry[]> {
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }
}
