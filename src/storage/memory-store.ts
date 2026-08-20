import type { BackupV1, CachedBoundary, VisitRecord, VisitV2 } from '../domain/types';
import type { ImportMode, PersistenceState, TripRepository } from './trip-store';

const DEFAULT_TITLE = '我的世界足迹';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryTripStore implements TripRepository {
  readonly persistence: PersistenceState;
  private visits = new Map<number, VisitRecord>();
  private areaVisits = new Map<string, VisitV2>();
  private boundaries = new Map<number, CachedBoundary>();
  private title = DEFAULT_TITLE;

  constructor(reason?: string) {
    this.persistence = reason ? { mode: 'memory', reason } : { mode: 'memory' };
  }

  async getVisit(cityId: number): Promise<VisitRecord | undefined> {
    const value = this.visits.get(cityId);
    return value ? clone(value) : undefined;
  }

  async listVisits(): Promise<VisitRecord[]> {
    return [...this.visits.values()].sort((a, b) => a.cityId - b.cityId).map(clone);
  }

  async putVisit(visit: VisitRecord): Promise<void> {
    this.visits.set(visit.cityId, clone(visit));
  }

  async deleteVisit(cityId: number): Promise<void> {
    this.visits.delete(cityId);
  }

  async getAreaVisit(areaId: string): Promise<VisitV2 | undefined> {
    const value = this.areaVisits.get(areaId);
    return value ? clone(value) : undefined;
  }

  async listAreaVisits(): Promise<VisitV2[]> {
    return [...this.areaVisits.values()].sort((a, b) => a.areaId.localeCompare(b.areaId, 'en')).map(clone);
  }

  async putAreaVisit(visit: VisitV2): Promise<void> {
    this.areaVisits.set(visit.areaId, clone(visit));
  }

  async deleteAreaVisit(areaId: string): Promise<void> {
    this.areaVisits.delete(areaId);
  }

  async getBoundary(cityId: number): Promise<CachedBoundary | undefined> {
    const value = this.boundaries.get(cityId);
    return value ? clone(value) : undefined;
  }

  async listBoundaries(): Promise<CachedBoundary[]> {
    return [...this.boundaries.values()].sort((a, b) => a.cityId - b.cityId).map(clone);
  }

  async putBoundary(boundary: CachedBoundary): Promise<void> {
    this.boundaries.set(boundary.cityId, clone(boundary));
  }

  async deleteBoundary(cityId: number): Promise<void> {
    this.boundaries.delete(cityId);
  }

  async getTitle(): Promise<string> {
    return this.title;
  }

  async setTitle(title: string): Promise<void> {
    this.title = title;
  }

  async importBackup(backup: BackupV1, mode: ImportMode): Promise<void> {
    const nextVisits = mode === 'replace' ? new Map<number, VisitRecord>() : new Map(this.visits);
    const nextBoundaries = mode === 'replace' ? new Map<number, CachedBoundary>() : new Map(this.boundaries);
    const nextAreaVisits = mode === 'replace' ? new Map<string, VisitV2>() : new Map(this.areaVisits);
    for (const incoming of backup.visits) {
      const current = nextVisits.get(incoming.cityId);
      if (!current || mode === 'replace' || Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt)) {
        nextVisits.set(incoming.cityId, clone(incoming));
      }
    }
    for (const incoming of backup.boundaries) {
      const current = nextBoundaries.get(incoming.cityId);
      if (!current || mode === 'replace' || Date.parse(incoming.fetchedAt) > Date.parse(current.fetchedAt)) {
        nextBoundaries.set(incoming.cityId, clone(incoming));
      }
    }
    for (const incoming of backup.areaVisits ?? []) {
      const current = nextAreaVisits.get(incoming.areaId);
      if (!current || mode === 'replace' || Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt)) {
        nextAreaVisits.set(incoming.areaId, clone(incoming));
      }
    }

    // Swap only after every clone/build operation succeeds, preserving atomic replace semantics.
    this.visits = nextVisits;
    this.boundaries = nextBoundaries;
    this.areaVisits = nextAreaVisits;
    this.title = backup.title;
  }
}

export function createMemoryTripStore(reason?: string): TripRepository {
  return new MemoryTripStore(reason);
}
