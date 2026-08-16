import { describe, expect, it, vi } from 'vitest';

import type { CachedBoundary, CitySummary, PolygonCoordinates } from '../domain/types';
import { createMemoryTripStore } from '../storage/memory-store';
import { createBoundaryService } from './boundary-service';
import { BoundaryProviderError, rankBoundaryCandidates, type BoundaryCandidate, type BoundaryProvider } from './provider';

const city: CitySummary = {
  id: 1,
  name: 'München',
  asciiName: 'Munich',
  zhName: '慕尼黑',
  aliases: ['Muenchen'],
  countryCode: 'DE',
  continentCode: 'EU',
  lat: 48.137,
  lon: 11.575,
};

const polygon: { type: 'Polygon'; coordinates: PolygonCoordinates } = {
  type: 'Polygon',
  coordinates: [[[11, 48], [12, 48], [12, 49], [11, 48]]],
};

function candidate(overrides: Partial<BoundaryCandidate> = {}): BoundaryCandidate {
  return {
    id: 'relation:1',
    name: 'München',
    displayName: 'München, Bayern, Deutschland',
    countryCode: 'de',
    geometry: polygon,
    sourceUrl: 'https://www.openstreetmap.org/relation/1',
    type: 'administrative',
    importance: 0.8,
    ...overrides,
  };
}

function provider(result: BoundaryCandidate[] | Error): BoundaryProvider & { fetchCandidates: ReturnType<typeof vi.fn> } {
  return {
    id: 'fixture',
    attribution: 'fixture attribution',
    fetchCandidates: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('boundary candidate matching', () => {
  it('requires country match and prioritizes an exact multilingual city name', () => {
    const ranked = rankBoundaryCandidates(city, [
      candidate({ id: 'wrong-country', countryCode: 'at' }),
      candidate({ id: 'english', name: 'Munich', importance: 0.3 }),
      candidate({ id: 'chinese', name: '慕尼黑', importance: 0.1 }),
    ]);

    expect(ranked.map((item) => item.id)).toEqual(['chinese', 'english']);
  });
});

describe('cache-first boundary service', () => {
  it('returns a valid cached boundary without invoking the provider', async () => {
    const repository = createMemoryTripStore();
    const cached: CachedBoundary = {
      cityId: city.id,
      geometry: { type: 'MultiPolygon', coordinates: [polygon.coordinates] },
      source: 'cached',
      fetchedAt: '2026-08-16T00:00:00.000Z',
    };
    await repository.putBoundary(cached);
    const boundaryProvider = provider([]);
    const service = createBoundaryService({ repository, provider: boundaryProvider });

    await expect(service.fetchForCity(city)).resolves.toEqual({ status: 'cached', boundary: cached });
    expect(boundaryProvider.fetchCandidates).not.toHaveBeenCalled();
  });

  it('validates, normalizes, persists and returns a fetched boundary', async () => {
    const repository = createMemoryTripStore();
    const boundaryProvider = provider([candidate()]);
    const service = createBoundaryService({ repository, provider: boundaryProvider, now: () => new Date('2026-08-16T01:02:03.000Z') });

    const result = await service.fetchForCity(city);

    expect(result).toMatchObject({ status: 'fetched', boundary: { cityId: 1, geometry: { type: 'MultiPolygon' }, source: 'fixture' } });
    await expect(repository.getBoundary(city.id)).resolves.toMatchObject({ fetchedAt: '2026-08-16T01:02:03.000Z' });
  });

  it('does not persist a non-HTTPS source URL from a replaceable provider', async () => {
    const repository = createMemoryTripStore();
    const service = createBoundaryService({ repository, provider: provider([candidate({ sourceUrl: 'javascript:alert(1)' })]) });

    const result = await service.fetchForCity(city);

    expect(result).toMatchObject({ status: 'fetched' });
    await expect(repository.getBoundary(city.id)).resolves.not.toHaveProperty('sourceUrl');
  });

  it('reports unavailable for country mismatch or malformed geometry', async () => {
    const repository = createMemoryTripStore();
    const mismatch = createBoundaryService({ repository, provider: provider([candidate({ countryCode: 'at' })]) });
    await expect(mismatch.fetchForCity(city)).resolves.toEqual({ status: 'unavailable', reason: 'no_matching_candidate' });

    const malformed = createBoundaryService({ repository, provider: provider([candidate({ geometry: { type: 'Point', coordinates: [0, 0] } })]) });
    await expect(malformed.fetchForCity(city)).resolves.toEqual({ status: 'unavailable', reason: 'invalid_geometry' });
  });

  it('maps provider failures and never retries automatically', async () => {
    const repository = createMemoryTripStore();
    const boundaryProvider = provider(new BoundaryProviderError('rate_limited', '请求过于频繁', true));
    const service = createBoundaryService({ repository, provider: boundaryProvider });

    await expect(service.fetchForCity(city)).resolves.toMatchObject({ status: 'error', code: 'rate_limited', retryable: true });
    expect(boundaryProvider.fetchCandidates).toHaveBeenCalledTimes(1);
  });

  it('surfaces caller cancellation without caching', async () => {
    const repository = createMemoryTripStore();
    const controller = new AbortController();
    controller.abort();
    const boundaryProvider = provider([]);
    const service = createBoundaryService({ repository, provider: boundaryProvider });

    await expect(service.fetchForCity(city, controller.signal)).resolves.toMatchObject({ status: 'error', code: 'aborted', retryable: false });
    await expect(repository.getBoundary(city.id)).resolves.toBeUndefined();
  });
});
