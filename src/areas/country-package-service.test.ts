import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { CountryPackageMemoryRepository } from './country-package-memory-repository';
import { CountryPackageService } from './country-package-service';
import type { CountryPackageCacheEntry, CountryPackageRepository } from './country-package-repository';
import type { CountryManifestEntry } from './types';

function wirePackage(version = 'v1'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    type: 'Topology',
    schemaVersion: 1,
    countryCode: 'CN',
    boundaryVersion: version,
    administrativeScheme: '地级行政区',
    source: 'osm',
    attribution: '© OpenStreetMap contributors',
    transform: { scale: [1, 1], translate: [0, 0] },
    objects: {
      areas: {
        type: 'GeometryCollection',
        geometries: [{
          type: 'Polygon',
          arcs: [[0]],
          properties: {
            areaId: 'CN:osm:110100', countryCode: 'CN', sourceId: '110100',
            adminLevel: 'prefecture', nameZh: '北京市', nameLocal: 'Beijing',
            aliases: ['北京'], centroid: [116.4, 39.9],
          },
        }],
      },
    },
    arcs: [[[116, 39], [1, 0], [0, 1], [-1, -1]]],
  }));
}

function manifestEntry(bytes: Uint8Array, version = 'v1'): CountryManifestEntry {
  return {
    schemaVersion: 1,
    countryCode: 'CN',
    boundaryVersion: version,
    administrativeScheme: '地级行政区',
    featureCount: 1,
    byteSize: bytes.byteLength,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    updatedAt: '2026-08-16T00:00:00.000Z',
    source: 'osm',
    attribution: '© OpenStreetMap contributors',
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function bytesResponse(value: Uint8Array, status = 200): Response {
  return new Response(Uint8Array.from(value).buffer, { status });
}

function manifest(entry: CountryManifestEntry): Record<string, CountryManifestEntry> {
  return { CN: entry };
}

function fetchSequence(...responses: Array<Response | Error>): typeof fetch {
  return vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error('unexpected fetch');
    return response;
  }) as unknown as typeof fetch;
}

async function cachedEntry(version = 'v1'): Promise<CountryPackageCacheEntry> {
  const bytes = wirePackage(version);
  const service = new CountryPackageService({
    repository: new CountryPackageMemoryRepository(),
    fetch: fetchSequence(jsonResponse(manifest(manifestEntry(bytes, version))), bytesResponse(bytes)),
  });
  const result = await service.load('CN');
  if (result.status !== 'fresh') throw new Error('fixture failed');
  return { countryCode: 'CN', manifest: manifestEntry(bytes, version), package: result.package };
}

describe('CountryPackageMemoryRepository', () => {
  it('structured-clones reads and writes and supports get, put, delete and list', async () => {
    const repository = new CountryPackageMemoryRepository();
    const entry = await cachedEntry();
    await repository.put(entry);
    const first = await repository.get('CN');
    expect(first).toEqual(entry);
    expect(first).not.toBe(entry);
    await repository.delete('CN');
    expect(await repository.list()).toEqual([]);
  });
});

describe('CountryPackageService', () => {
  it('loads the manifest first, verifies SHA-256, stores and returns a fresh package', async () => {
    const bytes = wirePackage();
    const entry = manifestEntry(bytes);
    const fetchMock = fetchSequence(jsonResponse(manifest(entry)), bytesResponse(bytes));
    const repository = new CountryPackageMemoryRepository();
    const result = await new CountryPackageService({ repository, fetch: fetchMock }).load('cn');

    expect(result).toMatchObject({ status: 'fresh', package: { countryCode: 'CN', boundaryVersion: 'v1' } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/travel-footprint-map/data/countries/manifest.json', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/travel-footprint-map/data/countries/CN.topojson', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await repository.get('CN')).toMatchObject({ manifest: entry });
  });

  it('returns cached when the manifest confirms the cached checksum', async () => {
    const existing = await cachedEntry();
    const repository = new CountryPackageMemoryRepository([existing]);
    const fetchMock = fetchSequence(jsonResponse(manifest(existing.manifest)));
    const result = await new CountryPackageService({ repository, fetch: fetchMock }).load('CN');
    expect(result.status).toBe('cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes stale cache and atomically replaces it', async () => {
    const existing = await cachedEntry('v1');
    const bytes = wirePackage('v2');
    const next = manifestEntry(bytes, 'v2');
    const repository = new CountryPackageMemoryRepository([existing]);
    const result = await new CountryPackageService({
      repository,
      fetch: fetchSequence(jsonResponse(manifest(next)), bytesResponse(bytes)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'fresh', package: { boundaryVersion: 'v2' } });
    expect(await repository.get('CN')).toMatchObject({ manifest: { boundaryVersion: 'v2' } });
  });

  it.each([404, 429])('classifies HTTP %s without automatic retry', async (status) => {
    const fetchMock = fetchSequence(jsonResponse({}, status));
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository(), fetch: fetchMock,
    }).load('CN');
    expect(result).toMatchObject({ status: 'unavailable', reason: { kind: 'http', status } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized manifest before invoking an unbounded JSON parser', async () => {
    const json = vi.fn(async () => manifest(manifestEntry(wirePackage())));
    const oversizedManifest = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(1_048_577) }),
      json,
    } as unknown as Response;
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository(),
      fetch: fetchSequence(oversizedManifest),
    }).load('CN');

    expect(result).toMatchObject({ status: 'unavailable', reason: { kind: 'invalid-manifest' } });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([404, 429])('classifies package HTTP %s without automatic retry', async (status) => {
    const bytes = wirePackage();
    const fetchMock = fetchSequence(
      jsonResponse(manifest(manifestEntry(bytes))),
      bytesResponse(new Uint8Array(), status),
    );
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository(), fetch: fetchMock,
    }).load('CN');
    expect(result).toMatchObject({ status: 'unavailable', reason: { kind: 'http', status } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns stale valid cache when refresh fails', async () => {
    const existing = await cachedEntry();
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository([existing]),
      fetch: fetchSequence(jsonResponse({}, 429)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'stale-cache', package: { boundaryVersion: 'v1' }, reason: { kind: 'http', status: 429 } });
  });

  it('enforces timeout even when fetch ignores its AbortSignal', async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
      const promise = new CountryPackageService({
        repository: new CountryPackageMemoryRepository(), fetch: never, timeoutMs: 12_000,
      }).load('CN');
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(promise).resolves.toMatchObject({ status: 'unavailable', reason: { kind: 'timeout' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies caller abort and forwards an AbortSignal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const promise = new CountryPackageService({
      repository: new CountryPackageMemoryRepository(), fetch: fetchMock,
    }).load('CN', controller.signal);
    controller.abort();
    await expect(promise).resolves.toMatchObject({ status: 'unavailable', reason: { kind: 'aborted' } });
  });

  it('honors caller abort even when fetch ignores its AbortSignal', async () => {
    const controller = new AbortController();
    const never = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const promise = new CountryPackageService({
      repository: new CountryPackageMemoryRepository(), fetch: never,
    }).load('CN', controller.signal);
    await vi.waitFor(() => expect(never).toHaveBeenCalledOnce());
    controller.abort();
    await expect(promise).resolves.toMatchObject({ status: 'unavailable', reason: { kind: 'aborted' } });
  });

  it('rejects an oversized package stream before retaining all response bytes', async () => {
    const expectedBytes = wirePackage();
    const entry = manifestEntry(expectedBytes);
    const oversized = new Uint8Array(entry.byteSize + 1);
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository(),
      fetch: fetchSequence(jsonResponse(manifest(entry)), bytesResponse(oversized)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'unavailable', reason: { kind: 'invalid-package' } });
  });

  it('rejects a bad checksum and never overwrites valid cache', async () => {
    const existing = await cachedEntry('v1');
    const bytes = wirePackage('v2');
    const bad = { ...manifestEntry(bytes, 'v2'), checksum: '0'.repeat(64) };
    const repository = new CountryPackageMemoryRepository([existing]);
    const result = await new CountryPackageService({
      repository, fetch: fetchSequence(jsonResponse(manifest(bad)), bytesResponse(bytes)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'stale-cache', reason: { kind: 'checksum' } });
    expect(await repository.get('CN')).toEqual(existing);
  });

  it('rejects malformed packages and never overwrites valid cache', async () => {
    const existing = await cachedEntry('v1');
    const bytes = new TextEncoder().encode('{"bad":true}');
    const repository = new CountryPackageMemoryRepository([existing]);
    const result = await new CountryPackageService({
      repository, fetch: fetchSequence(jsonResponse(manifest(manifestEntry(bytes, 'v2'))), bytesResponse(bytes)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'stale-cache', reason: { kind: 'invalid-package' } });
    expect(await repository.get('CN')).toEqual(existing);
  });

  it('retains old cache when atomic replacement fails', async () => {
    const existing = await cachedEntry('v1');
    const stored = structuredClone(existing);
    const repository: CountryPackageRepository = {
      get: async () => structuredClone(stored),
      list: async () => [structuredClone(stored)],
      delete: async () => undefined,
      put: async () => { throw new DOMException('quota', 'QuotaExceededError'); },
    };
    const bytes = wirePackage('v2');
    const result = await new CountryPackageService({
      repository, fetch: fetchSequence(jsonResponse(manifest(manifestEntry(bytes, 'v2'))), bytesResponse(bytes)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'stale-cache', package: { boundaryVersion: 'v1' }, reason: { kind: 'cache-write' } });
    expect(stored).toEqual(existing);
  });

  it('deduplicates concurrent requests for the same normalized country', async () => {
    const bytes = wirePackage();
    const fetchMock = fetchSequence(jsonResponse(manifest(manifestEntry(bytes))), bytesResponse(bytes));
    const service = new CountryPackageService({ repository: new CountryPackageMemoryRepository(), fetch: fetchMock });
    const [first, second] = await Promise.all([service.load('cn'), service.load('CN')]);
    expect(first.status).toBe('fresh');
    expect(second.status).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let one concurrent caller abort the shared country load', async () => {
    const bytes = wirePackage();
    const entry = manifestEntry(bytes);
    let releaseManifest: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseManifest = resolve; }))
      .mockResolvedValueOnce(bytesResponse(bytes)) as unknown as typeof fetch;
    const service = new CountryPackageService({ repository: new CountryPackageMemoryRepository(), fetch: fetchMock });
    const first = service.load('CN');
    const controller = new AbortController();
    const second = service.load('CN', controller.signal);
    controller.abort();
    await expect(second).resolves.toMatchObject({ status: 'unavailable', reason: { kind: 'aborted' } });
    releaseManifest?.(jsonResponse(manifest(entry)));
    await expect(first).resolves.toMatchObject({ status: 'fresh' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not trust a structurally inconsistent cached entry', async () => {
    const existing = await cachedEntry();
    const poisoned = {
      ...existing,
      package: { ...existing.package, countryCode: 'US' },
    } as CountryPackageCacheEntry;
    const bytes = wirePackage();
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository([poisoned]),
      fetch: fetchSequence(jsonResponse(manifest(manifestEntry(bytes))), bytesResponse(bytes)),
    }).load('CN');
    expect(result).toMatchObject({ status: 'fresh', package: { countryCode: 'CN' } });
  });

  it('cleans up a failed in-flight request so a manual retry can succeed', async () => {
    const bytes = wirePackage();
    const entry = manifestEntry(bytes);
    const fetchMock = fetchSequence(jsonResponse({}, 429), jsonResponse(manifest(entry)), bytesResponse(bytes));
    const service = new CountryPackageService({ repository: new CountryPackageMemoryRepository(), fetch: fetchMock });
    expect((await service.load('CN')).status).toBe('unavailable');
    expect((await service.load('CN')).status).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects country-code path injection before fetch', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const result = await new CountryPackageService({
      repository: new CountryPackageMemoryRepository(), fetch: fetchMock,
    }).load('../CN');
    expect(result).toMatchObject({ status: 'unavailable', reason: { kind: 'invalid-country' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
