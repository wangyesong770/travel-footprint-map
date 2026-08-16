import type { BoundaryFetchResult } from './boundaries/boundary-service';
import type { CachedBoundary } from './domain/types';

export function boundaryForUi(result: BoundaryFetchResult): CachedBoundary | undefined {
  if (result.status === 'cached' || result.status === 'fetched') return result.boundary;
  if (result.status === 'unavailable') return undefined;
  throw new Error(result.message);
}
