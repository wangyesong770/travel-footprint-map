import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CitySummary } from '../domain/types';
import type { BoundaryProviderError } from './provider';
import { createNominatimProvider, NOMINATIM_PRIVACY_NOTICE } from './nominatim-provider';

const city: CitySummary = {
  id: 2643743,
  name: 'London',
  asciiName: 'London',
  zhName: '伦敦',
  aliases: ['Londres'],
  countryCode: 'GB',
  continentCode: 'EU',
  lat: 51.5074,
  lon: -0.1278,
};

const immediateQueue = {
  enqueue: <T>(task: () => Promise<T>) => task(),
};

afterEach(() => vi.useRealTimers());

describe('Nominatim provider', () => {
  it('builds a policy-compliant, encoded, user-triggered search request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([{ place_id: 1, name: 'London', display_name: 'London, UK', country_code: 'gb', type: 'administrative', geojson: { type: 'Polygon', coordinates: [] } }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createNominatimProvider({ fetch: fetchMock, queue: immediateQueue });

    const candidates = await provider.fetchCandidates(city);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin).toBe('https://nominatim.openstreetmap.org');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('polygon_geojson')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('city')).toBe('London');
    expect(url.searchParams.get('countrycodes')).toBe('gb');
    expect(fetchMock.mock.calls[0]![1]).not.toMatchObject({ referrerPolicy: 'no-referrer' });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
    expect(candidates).toHaveLength(1);
    expect(NOMINATIM_PRIVACY_NOTICE).toContain('城市名称');
  });

  it('surfaces HTTP 429 without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
    const provider = createNominatimProvider({ fetch: fetchMock, queue: immediateQueue });

    await expect(provider.fetchCandidates(city)).rejects.toMatchObject({ code: 'rate_limited', retryable: true } satisfies Partial<BoundaryProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects responses that exceed the byte limit', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('[]', { status: 200, headers: { 'content-length': '9999' } }));
    const provider = createNominatimProvider({ fetch: fetchMock, queue: immediateQueue, maxResponseBytes: 100 });

    await expect(provider.fetchCandidates(city)).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('times out a hanging request after the configured deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const provider = createNominatimProvider({ fetch: fetchMock, queue: immediateQueue, timeoutMs: 8_000 });
    const pending = provider.fetchCandidates(city);
    const expectation = expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await vi.advanceTimersByTimeAsync(8_000);

    await expectation;
  });

  it('enforces the deadline even when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const provider = createNominatimProvider({ fetch: fetchMock, queue: immediateQueue, timeoutMs: 8_000 });
    const observed = provider.fetchCandidates(city).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.resolve();

    await expect(Promise.race([observed, Promise.resolve('still-pending')])).resolves.toMatchObject({ code: 'timeout' });
  });

  it('distinguishes caller abort from CORS/network failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const unusedFetch = vi.fn<typeof fetch>();
    const abortedProvider = createNominatimProvider({ fetch: unusedFetch, queue: immediateQueue });
    await expect(abortedProvider.fetchCandidates(city, controller.signal)).rejects.toMatchObject({ code: 'aborted', retryable: false });

    const failedProvider = createNominatimProvider({ fetch: vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); }), queue: immediateQueue });
    await expect(failedProvider.fetchCandidates(city)).rejects.toMatchObject({ code: 'network', retryable: true });
  });
});
