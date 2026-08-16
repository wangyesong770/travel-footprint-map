import type { CachedBoundary, CitySummary } from '../domain/types';
import { validateGeometry } from '../map/geometry';
import type { TripRepository } from '../storage/trip-store';
import { BoundaryProviderError, rankBoundaryCandidates, type BoundaryProvider } from './provider';

export type BoundaryUnavailableReason = 'no_matching_candidate' | 'invalid_geometry';

export type BoundaryFetchResult =
  | { status: 'cached'; boundary: CachedBoundary }
  | { status: 'fetched'; boundary: CachedBoundary; cacheWarning?: string }
  | { status: 'unavailable'; reason: BoundaryUnavailableReason }
  | { status: 'error'; code: string; message: string; retryable: boolean };

export interface BoundaryService {
  fetchForCity(city: CitySummary, signal?: AbortSignal): Promise<BoundaryFetchResult>;
  retryForCity(city: CitySummary, signal?: AbortSignal): Promise<BoundaryFetchResult>;
}

export interface BoundaryServiceOptions {
  repository: TripRepository;
  provider: BoundaryProvider;
  now?: () => Date;
  maxGeometryVertices?: number;
}

function abortedResult(): BoundaryFetchResult {
  return { status: 'error', code: 'aborted', message: '边界请求已取消', retryable: false };
}

function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function createBoundaryService(options: BoundaryServiceOptions): BoundaryService {
  const now = options.now ?? (() => new Date());

  const request = async (city: CitySummary, signal?: AbortSignal): Promise<BoundaryFetchResult> => {
    if (signal?.aborted) return abortedResult();
    const cached = await options.repository.getBoundary(city.id);
    if (signal?.aborted) return abortedResult();
    if (cached) {
      try {
        const geometry = validateGeometry(cached.geometry, { maxVertices: options.maxGeometryVertices ?? 50_000 });
        return { status: 'cached', boundary: { ...cached, geometry } };
      } catch {
        try { await options.repository.deleteBoundary(city.id); } catch { /* A corrupt cache must not block a fresh user request. */ }
      }
    }

    let candidates;
    try {
      candidates = await options.provider.fetchCandidates(city, signal);
    } catch (error) {
      if (error instanceof BoundaryProviderError) {
        return { status: 'error', code: error.code, message: error.message, retryable: error.retryable };
      }
      return { status: 'error', code: 'provider', message: '边界服务发生未知错误', retryable: true };
    }
    if (signal?.aborted) return abortedResult();
    const ranked = rankBoundaryCandidates(city, candidates);
    if (ranked.length === 0) return { status: 'unavailable', reason: 'no_matching_candidate' };

    for (const candidate of ranked) {
      try {
        const geometry = validateGeometry(candidate.geometry, { maxVertices: options.maxGeometryVertices ?? 50_000 });
        const boundary: CachedBoundary = {
          cityId: city.id,
          geometry,
          source: options.provider.id,
          fetchedAt: now().toISOString(),
        };
        const sourceUrl = safeSourceUrl(candidate.sourceUrl);
        if (sourceUrl) boundary.sourceUrl = sourceUrl;
        try {
          await options.repository.putBoundary(boundary);
          return { status: 'fetched', boundary };
        } catch {
          return { status: 'fetched', boundary, cacheWarning: '边界已显示，但未能保存到本地缓存' };
        }
      } catch {
        // Try the next deliberately matched candidate before giving up.
      }
    }
    return { status: 'unavailable', reason: 'invalid_geometry' };
  };

  return {
    fetchForCity: request,
    // Retrying is intentionally a distinct, user-invoked call; there is no timer or automatic retry loop.
    retryForCity: request,
  };
}
