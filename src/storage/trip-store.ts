import type { BackupV1, CachedBoundary, VisitRecord } from '../domain/types';
import { createMemoryTripStore } from './memory-store';

export type ImportMode = 'merge' | 'replace';
export type PersistenceState =
  | { mode: 'persistent' }
  | { mode: 'memory'; reason?: string };

export interface TripRepository {
  readonly persistence: PersistenceState;
  getVisit(cityId: number): Promise<VisitRecord | undefined>;
  listVisits(): Promise<VisitRecord[]>;
  putVisit(visit: VisitRecord): Promise<void>;
  deleteVisit(cityId: number): Promise<void>;
  getBoundary(cityId: number): Promise<CachedBoundary | undefined>;
  listBoundaries(): Promise<CachedBoundary[]>;
  putBoundary(boundary: CachedBoundary): Promise<void>;
  deleteBoundary(cityId: number): Promise<void>;
  getTitle(): Promise<string>;
  setTitle(title: string): Promise<void>;
  importBackup(backup: BackupV1, mode: ImportMode): Promise<void>;
}

export interface CreateTripStoreOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

const DATABASE_VERSION = 1;
const DEFAULT_TITLE = '我的世界足迹';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('visits')) database.createObjectStore('visits', { keyPath: 'cityId' });
      if (!database.objectStoreNames.contains('boundaries')) database.createObjectStore('boundaries', { keyPath: 'cityId' });
      if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
    request.onblocked = () => reject(new Error('本地数据库升级被其他页面阻塞'));
  });
}

class IndexedDbTripStore implements TripRepository {
  readonly persistence = { mode: 'persistent' } as const;

  constructor(private readonly database: IDBDatabase) {}

  async getVisit(cityId: number): Promise<VisitRecord | undefined> {
    const transaction = this.database.transaction('visits', 'readonly');
    return requestResult(transaction.objectStore('visits').get(cityId)) as Promise<VisitRecord | undefined>;
  }

  async listVisits(): Promise<VisitRecord[]> {
    const transaction = this.database.transaction('visits', 'readonly');
    return requestResult(transaction.objectStore('visits').getAll()) as Promise<VisitRecord[]>;
  }

  async putVisit(visit: VisitRecord): Promise<void> {
    await this.writeOne('visits', visit);
  }

  async deleteVisit(cityId: number): Promise<void> {
    await this.deleteOne('visits', cityId);
  }

  async getBoundary(cityId: number): Promise<CachedBoundary | undefined> {
    const transaction = this.database.transaction('boundaries', 'readonly');
    return requestResult(transaction.objectStore('boundaries').get(cityId)) as Promise<CachedBoundary | undefined>;
  }

  async listBoundaries(): Promise<CachedBoundary[]> {
    const transaction = this.database.transaction('boundaries', 'readonly');
    return requestResult(transaction.objectStore('boundaries').getAll()) as Promise<CachedBoundary[]>;
  }

  async putBoundary(boundary: CachedBoundary): Promise<void> {
    await this.writeOne('boundaries', boundary);
  }

  async deleteBoundary(cityId: number): Promise<void> {
    await this.deleteOne('boundaries', cityId);
  }

  async getTitle(): Promise<string> {
    const transaction = this.database.transaction('meta', 'readonly');
    const title = await requestResult(transaction.objectStore('meta').get('title'));
    return typeof title === 'string' ? title : DEFAULT_TITLE;
  }

  async setTitle(title: string): Promise<void> {
    const transaction = this.database.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put(title, 'title');
    await transactionDone(transaction);
  }

  async importBackup(backup: BackupV1, mode: ImportMode): Promise<void> {
    const transaction = this.database.transaction(['visits', 'boundaries', 'meta'], 'readwrite');
    const visits = transaction.objectStore('visits');
    const boundaries = transaction.objectStore('boundaries');
    try {
      if (mode === 'replace') {
        visits.clear();
        boundaries.clear();
        for (const visit of backup.visits) visits.put(visit);
      } else {
        for (const incoming of backup.visits) {
          const current = await requestResult(visits.get(incoming.cityId)) as VisitRecord | undefined;
          if (!current || Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt)) visits.put(incoming);
        }
      }
      for (const incoming of backup.boundaries) {
        if (mode === 'replace') {
          boundaries.put(incoming);
          continue;
        }
        const current = await requestResult(boundaries.get(incoming.cityId)) as CachedBoundary | undefined;
        if (!current || Date.parse(incoming.fetchedAt) > Date.parse(current.fetchedAt)) boundaries.put(incoming);
      }
      transaction.objectStore('meta').put(backup.title, 'title');
      await transactionDone(transaction);
    } catch (error) {
      try { transaction.abort(); } catch { /* the request may already have aborted the transaction */ }
      throw error;
    }
  }

  private async writeOne(storeName: 'visits' | 'boundaries', value: VisitRecord | CachedBoundary): Promise<void> {
    const transaction = this.database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }

  private async deleteOne(storeName: 'visits' | 'boundaries', key: number): Promise<void> {
    const transaction = this.database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  }
}

function errorReason(error: unknown): string {
  if (error instanceof DOMException && error.name) return error.name;
  if (error instanceof Error && error.name !== 'Error') return error.name;
  return 'IndexedDBUnavailable';
}

export async function createTripStore(options: CreateTripStoreOptions = {}): Promise<TripRepository> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) return createMemoryTripStore('IndexedDBUnavailable');
  try {
    const database = await openDatabase(factory, options.databaseName ?? 'travel-footprint-map');
    return new IndexedDbTripStore(database);
  } catch (error) {
    return createMemoryTripStore(errorReason(error));
  }
}
