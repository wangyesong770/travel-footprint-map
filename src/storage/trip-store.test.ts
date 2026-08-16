import 'fake-indexeddb/auto';

import type { BackupV1, CachedBoundary, VisitRecord } from '../domain/types';
import { createMemoryTripStore } from './memory-store';
import { createTripStore } from './trip-store';

function visit(cityId: number, updatedAt = '2026-01-01T00:00:00.000Z'): VisitRecord {
  return {
    cityId,
    citySnapshot: {
      id: cityId,
      name: `City ${cityId}`,
      asciiName: `City ${cityId}`,
      aliases: [],
      countryCode: cityId === 1 ? 'CN' : 'JP',
      continentCode: 'AS',
      lat: 30,
      lon: 120,
    },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt,
  };
}

function boundary(cityId: number): CachedBoundary {
  return {
    cityId,
    geometry: { type: 'MultiPolygon', coordinates: [[[[120, 30], [121, 30], [120, 30]]]] },
    source: 'fixture',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe.each([
  ['memory', async () => createMemoryTripStore()],
  ['indexeddb', async () => createTripStore({ indexedDB, databaseName: `trip-${crypto.randomUUID()}` })],
])('%s trip repository', (_name, makeStore) => {
  it('supports visit/boundary CRUD and city-ID uniqueness', async () => {
    const store = await makeStore();
    await store.putVisit(visit(1));
    await store.putVisit({ ...visit(1, '2026-02-01T00:00:00.000Z'), note: 'second' });
    await store.putBoundary(boundary(1));

    expect(await store.listVisits()).toHaveLength(1);
    expect((await store.getVisit(1))?.note).toBe('second');
    expect(await store.getBoundary(1)).toEqual(boundary(1));

    await store.deleteVisit(1);
    await store.deleteBoundary(1);
    expect(await store.getVisit(1)).toBeUndefined();
    expect(await store.getBoundary(1)).toBeUndefined();
  });

  it('merges newer visits and unions boundaries atomically', async () => {
    const store = await makeStore();
    await store.putVisit(visit(1, '2026-06-01T00:00:00.000Z'));
    await store.putBoundary(boundary(1));
    const incoming: BackupV1 = {
      schemaVersion: 1,
      exportedAt: '2026-07-01T00:00:00.000Z',
      title: '导入标题',
      visits: [visit(1, '2026-05-01T00:00:00.000Z'), visit(2)],
      boundaries: [boundary(2)],
    };

    await store.importBackup(incoming, 'merge');

    expect((await store.getVisit(1))?.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(await store.getVisit(2)).toBeDefined();
    expect(await store.getBoundary(1)).toBeDefined();
    expect(await store.getBoundary(2)).toBeDefined();
    expect(await store.getTitle()).toBe('导入标题');
  });

  it('replace removes stale records and applies all data', async () => {
    const store = await makeStore();
    await store.putVisit(visit(1));
    await store.putBoundary(boundary(1));

    await store.importBackup({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      title: '替换',
      visits: [visit(2)],
      boundaries: [boundary(2)],
    }, 'replace');

    expect(await store.getVisit(1)).toBeUndefined();
    expect(await store.getBoundary(1)).toBeUndefined();
    expect(await store.getVisit(2)).toBeDefined();
    expect(await store.getBoundary(2)).toBeDefined();
  });

  it('rolls back the entire replace when one record cannot be cloned', async () => {
    const store = await makeStore();
    await store.putVisit(visit(1));
    const invalid = visit(2) as VisitRecord & { invalid: symbol };
    invalid.invalid = Symbol('not cloneable');

    await expect(store.importBackup({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      title: '不应生效',
      visits: [invalid],
      boundaries: [],
    }, 'replace')).rejects.toBeDefined();

    expect(await store.getVisit(1)).toBeDefined();
    expect(await store.getVisit(2)).toBeUndefined();
  });

  it('does not replace a newer cached boundary with an older merge', async () => {
    const store = await makeStore();
    await store.putBoundary({ ...boundary(1), fetchedAt: '2026-06-01T00:00:00.000Z', source: 'new' });
    await store.importBackup({
      schemaVersion: 1,
      exportedAt: '2026-07-01T00:00:00.000Z',
      title: '足迹',
      visits: [],
      boundaries: [{ ...boundary(1), fetchedAt: '2026-05-01T00:00:00.000Z', source: 'old' }],
    }, 'merge');
    expect((await store.getBoundary(1))?.source).toBe('new');
  });
});

it('reports memory fallback rather than silently accepting IndexedDB failure', async () => {
  const failing = { open: () => { throw new DOMException('quota', 'QuotaExceededError'); } } as unknown as IDBFactory;
  const store = await createTripStore({ indexedDB: failing, databaseName: 'fail' });
  expect(store.persistence).toEqual({ mode: 'memory', reason: 'QuotaExceededError' });
  await store.putVisit(visit(1));
  expect(await store.getVisit(1)).toBeDefined();
});
