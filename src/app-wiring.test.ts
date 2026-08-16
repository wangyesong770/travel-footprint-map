import type { CachedBoundary } from './domain/types';
import { boundaryForUi } from './app-wiring';

const boundary: CachedBoundary = {
  cityId: 1,
  geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
  source: 'test',
  fetchedAt: '2026-08-16T00:00:00.000Z',
};

describe('production app wiring', () => {
  it('passes cached and fetched boundaries to the UI', () => {
    expect(boundaryForUi({ status: 'cached', boundary })).toBe(boundary);
    expect(boundaryForUi({ status: 'fetched', boundary })).toBe(boundary);
  });

  it('uses the light-point fallback for unavailable boundaries', () => {
    expect(boundaryForUi({ status: 'unavailable', reason: 'no_matching_candidate' })).toBeUndefined();
  });

  it('preserves a classified provider error for the retry UI', () => {
    expect(() => boundaryForUi({
      status: 'error',
      code: 'rate_limited',
      message: '请求太频繁',
      retryable: true,
    })).toThrow('请求太频繁');
  });
});
