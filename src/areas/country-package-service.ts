import { parseCountryManifest, parseCountryPackage } from './package-validator';
import type { CountryPackageCacheEntry, CountryPackageRepository } from './country-package-repository';
import type { CountryBoundaryPackage, CountryCode, CountryManifestEntry } from './types';

const MANIFEST_URL = '/travel-footprint-map/data/countries/manifest.json';
const PACKAGE_ROOT = '/travel-footprint-map/data/countries';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;

export type CountryPackageFailure =
  | { readonly kind: 'invalid-country' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'network' }
  | { readonly kind: 'invalid-manifest' }
  | { readonly kind: 'checksum' }
  | { readonly kind: 'invalid-package' }
  | { readonly kind: 'cache-read' }
  | { readonly kind: 'cache-write' };

export type CountryPackageLoadResult =
  | { readonly status: 'fresh'; readonly package: CountryBoundaryPackage }
  | { readonly status: 'cached'; readonly package: CountryBoundaryPackage }
  | { readonly status: 'stale-cache'; readonly package: CountryBoundaryPackage; readonly reason: CountryPackageFailure }
  | { readonly status: 'unavailable'; readonly reason: CountryPackageFailure };

export interface CountryPackageServiceOptions {
  readonly repository: CountryPackageRepository;
  readonly fetch?: typeof fetch;
  readonly subtle?: SubtleCrypto;
  readonly timeoutMs?: number;
}

interface InFlightLoad {
  readonly controller: AbortController;
  promise: Promise<CountryPackageLoadResult>;
  waiters: number;
  settled: boolean;
}

class LoadFailure extends Error {
  constructor(readonly reason: CountryPackageFailure) {
    super(reason.kind);
  }
}

function normalizeCountryCode(value: string): CountryCode | undefined {
  const normalized = value.toUpperCase();
  return COUNTRY_CODE_PATTERN.test(normalized) ? normalized as CountryCode : undefined;
}

function packageUrl(countryCode: CountryCode): string {
  // countryCode has passed a two-ASCII-letter allowlist; no user-controlled path is joined.
  return `${PACKAGE_ROOT}/${countryCode}.topojson`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class CountryPackageService {
  private readonly repository: CountryPackageRepository;
  private readonly fetchImplementation: typeof fetch;
  private readonly subtle: SubtleCrypto;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<CountryCode, InFlightLoad>();

  constructor(options: CountryPackageServiceOptions) {
    this.repository = options.repository;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.subtle = options.subtle ?? globalThis.crypto.subtle;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  }

  load(countryCodeInput: string, signal?: AbortSignal): Promise<CountryPackageLoadResult> {
    const countryCode = normalizeCountryCode(countryCodeInput);
    if (countryCode === undefined) {
      return Promise.resolve({ status: 'unavailable', reason: { kind: 'invalid-country' } });
    }
    let active = this.inFlight.get(countryCode);
    if (active === undefined) {
      const controller = new AbortController();
      active = {
        controller,
        promise: Promise.resolve({ status: 'unavailable', reason: { kind: 'network' } }),
        waiters: 0,
        settled: false,
      };
      const created = active;
      created.promise = this.loadOnce(countryCode, controller.signal).finally(() => {
        created.settled = true;
        if (this.inFlight.get(countryCode) === created) this.inFlight.delete(countryCode);
      });
      this.inFlight.set(countryCode, created);
    }
    return this.join(active, signal);
  }

  private async join(active: InFlightLoad, signal?: AbortSignal): Promise<CountryPackageLoadResult> {
    active.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted === true) return { status: 'unavailable', reason: { kind: 'aborted' } };
      if (signal === undefined) return await active.promise;
      const aborted = new Promise<CountryPackageLoadResult>((resolve) => {
        onAbort = () => resolve({ status: 'unavailable', reason: { kind: 'aborted' } });
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([active.promise, aborted]);
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      active.waiters -= 1;
      if (active.waiters === 0 && !active.settled) active.controller.abort();
    }
  }

  private async loadOnce(countryCode: CountryCode, callerSignal?: AbortSignal): Promise<CountryPackageLoadResult> {
    let cached: CountryPackageCacheEntry | undefined;
    try {
      cached = await this.repository.get(countryCode);
      if (cached !== undefined && !this.isConsistentCacheEntry(cached, countryCode)) cached = undefined;
    } catch {
      return { status: 'unavailable', reason: { kind: 'cache-read' } };
    }

    try {
      const fresh = await this.withDeadline(callerSignal, async (signal) => {
        const manifestResponse = await this.fetchImplementation(MANIFEST_URL, { signal });
        if (!manifestResponse.ok) throw new LoadFailure({ kind: 'http', status: manifestResponse.status });

        const manifestInput = await this.readManifest(manifestResponse);
        let entry: CountryManifestEntry;
        try {
          const parsed = parseCountryManifest(manifestInput);
          const candidate = parsed[countryCode];
          if (candidate === undefined) throw new Error('missing country');
          entry = candidate;
        } catch {
          throw new LoadFailure({ kind: 'invalid-manifest' });
        }

        if (cached !== undefined && cached.manifest.checksum === entry.checksum) {
          return { status: 'cached', package: cached.package } as const;
        }

        const packageResponse = await this.fetchImplementation(packageUrl(countryCode), { signal });
        if (!packageResponse.ok) throw new LoadFailure({ kind: 'http', status: packageResponse.status });
        const bytes = await this.readExactBytes(packageResponse, entry.byteSize);
        if (await this.sha256(bytes) !== entry.checksum) throw new LoadFailure({ kind: 'checksum' });

        let parsedPackage: CountryBoundaryPackage;
        try {
          parsedPackage = parseCountryPackage(bytes, entry);
        } catch {
          throw new LoadFailure({ kind: 'invalid-package' });
        }
        try {
          await this.repository.put({ countryCode, manifest: entry, package: parsedPackage });
        } catch {
          throw new LoadFailure({ kind: 'cache-write' });
        }
        return { status: 'fresh', package: parsedPackage } as const;
      });
      return fresh;
    } catch (error) {
      const reason = error instanceof LoadFailure
        ? error.reason
        : isAbortError(error)
          ? { kind: 'aborted' } as const
          : { kind: 'network' } as const;
      return cached === undefined
        ? { status: 'unavailable', reason }
        : { status: 'stale-cache', package: cached.package, reason };
    }
  }

  private isConsistentCacheEntry(entry: CountryPackageCacheEntry, countryCode: CountryCode): boolean {
    return entry.countryCode === countryCode
      && entry.manifest.countryCode === countryCode
      && entry.package.countryCode === countryCode
      && entry.package.schemaVersion === entry.manifest.schemaVersion
      && entry.package.boundaryVersion === entry.manifest.boundaryVersion
      && entry.package.administrativeScheme === entry.manifest.administrativeScheme
      && entry.package.source === entry.manifest.source
      && entry.package.attribution === entry.manifest.attribution
      && entry.package.features.length === entry.manifest.featureCount;
  }

  private async withDeadline<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted === true) throw new LoadFailure({ kind: 'aborted' });
    const controller = new AbortController();
    let rejectCallerAbort: ((reason: LoadFailure) => void) | undefined;
    const callerAbort = new Promise<never>((_resolve, reject) => {
      rejectCallerAbort = reject;
    });
    const onCallerAbort = (): void => {
      controller.abort();
      rejectCallerAbort?.(new LoadFailure({ kind: 'aborted' }));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LoadFailure({ kind: 'timeout' }));
      }, this.timeoutMs);
    });
    try {
      // Attaching both handlers ensures a fetch that settles after losing the race
      // cannot produce an unhandled rejection.
      const guarded = operation(controller.signal).then(
        (value) => value,
        (error: unknown) => {
          if (callerSignal?.aborted === true) throw new LoadFailure({ kind: 'aborted' });
          throw error;
        },
      );
      return await Promise.race([guarded, timeout, callerAbort]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private async readExactBytes(response: Response, expectedSize: number): Promise<Uint8Array> {
    const declaredSize = response.headers.get('content-length');
    if (declaredSize !== null && Number(declaredSize) > expectedSize) {
      throw new LoadFailure({ kind: 'invalid-package' });
    }
    if (response.body === null) throw new LoadFailure({ kind: 'invalid-package' });
    const reader = response.body.getReader();
    const result = new Uint8Array(expectedSize);
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.byteLength > expectedSize) {
          await reader.cancel();
          throw new LoadFailure({ kind: 'invalid-package' });
        }
        result.set(next.value, offset);
        offset += next.value.byteLength;
      }
    } catch (error) {
      if (error instanceof LoadFailure) throw error;
      throw new LoadFailure({ kind: 'network' });
    } finally {
      reader.releaseLock();
    }
    if (offset !== expectedSize) throw new LoadFailure({ kind: 'invalid-package' });
    return result;
  }

  private async readManifest(response: Response): Promise<unknown> {
    const declaredSize = response.headers.get('content-length');
    if (declaredSize !== null) {
      const size = Number(declaredSize);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MANIFEST_BYTES) {
        throw new LoadFailure({ kind: 'invalid-manifest' });
      }
    }
    if (response.body === null) throw new LoadFailure({ kind: 'invalid-manifest' });
    const reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_MANIFEST_BYTES);
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.byteLength > MAX_MANIFEST_BYTES) {
          await reader.cancel();
          throw new LoadFailure({ kind: 'invalid-manifest' });
        }
        buffer.set(next.value, offset);
        offset += next.value.byteLength;
      }
    } catch (error) {
      if (error instanceof LoadFailure) throw error;
      throw new LoadFailure({ kind: 'network' });
    } finally {
      reader.releaseLock();
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
      return JSON.parse(text) as unknown;
    } catch {
      throw new LoadFailure({ kind: 'invalid-manifest' });
    }
  }

  private async sha256(bytes: Uint8Array): Promise<string> {
    const copy = Uint8Array.from(bytes);
    const digest = await this.subtle.digest('SHA-256', copy.buffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
}
