import type { VisitRecord, VisitV2 } from '../domain/types';
import { createMemoryTripStore } from './memory-store';
import { BACKUP_LIMITS, exportBackup, mergeBackup, parseBackup } from './backup';

const rawVisit = (id = 1) => ({
  cityId: id,
  citySnapshot: {
    id,
    name: '上海',
    asciiName: 'Shanghai',
    aliases: ['上海市'],
    countryCode: 'CN',
    continentCode: 'AS',
    lat: 31.2,
    lon: 121.5,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  visitedOn: '2025-08',
  datePrecision: 'month',
  note: '旅行',
});

const validRaw = () => ({
  schemaVersion: 1,
  exportedAt: '2026-03-01T00:00:00.000Z',
  title: '足迹',
  visits: [rawVisit()],
  boundaries: [],
});

describe('parseBackup', () => {
  it('allows a JSON payload large enough for the documented geometry budget', () => {
    expect(BACKUP_LIMITS.maxBytes).toBeGreaterThanOrEqual(BACKUP_LIMITS.maxTotalVertices * 32);
  });

  it('strictly rebuilds whitelisted fields and ignores pollution keys', () => {
    const input = JSON.parse(JSON.stringify({
      ...validRaw(),
      constructor: { prototype: { polluted: true } },
      visits: [{ ...rawVisit(), extra: 'drop', citySnapshot: { ...rawVisit().citySnapshot, __protoMarker: true } }],
    }).replace('__protoMarker', '__proto__'));

    const parsed = parseBackup(JSON.stringify(input));
    expect(parsed).toEqual(validRaw());
    expect(Object.hasOwn(parsed.visits[0]!, 'extra')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects unknown schemas, invalid dates, excessive input and arrays', () => {
    expect(() => parseBackup(JSON.stringify({ ...validRaw(), schemaVersion: 2 }))).toThrow('不支持的备份版本');
    expect(() => parseBackup(JSON.stringify({ ...validRaw(), exportedAt: 'not-a-date' }))).toThrow('导出时间');
    expect(() => parseBackup(JSON.stringify({ ...validRaw(), exportedAt: '2026-02-30T00:00:00.000Z' }))).toThrow('导出时间');
    expect(() => parseBackup(' '.repeat(BACKUP_LIMITS.maxBytes + 1))).toThrow('备份文件过大');
    expect(() => parseBackup(JSON.stringify({ ...validRaw(), visits: Array(10_001).fill(rawVisit()) }))).toThrow('到访记录过多');
  });

  it('rejects malformed and oversized geometry through the default validator', () => {
    const malformed = { ...validRaw(), boundaries: [{ cityId: 1, geometry: { type: 'Point', coordinates: [1, 2] }, source: 'x', fetchedAt: '2026-01-01T00:00:00.000Z' }] };
    expect(() => parseBackup(JSON.stringify(malformed))).toThrow('边界几何无效');

    const hugeRing = Array.from({ length: 100_002 }, (_, index) => [index % 180, 0]);
    const huge = { ...validRaw(), boundaries: [{ cityId: 1, geometry: { type: 'MultiPolygon', coordinates: [[[...hugeRing]]] }, source: 'x', fetchedAt: '2026-01-01T00:00:00.000Z' }] };
    expect(() => parseBackup(JSON.stringify(huge))).toThrow('边界顶点过多');
  });
});

it('exports and merges using repository transaction semantics', async () => {
  const store = createMemoryTripStore();
  const first = rawVisit() as VisitRecord;
  await store.putVisit(first);
  await store.setTitle('我的地图');

  const exported = await exportBackup(store, () => '2026-04-01T00:00:00.000Z');
  expect(exported.title).toBe('我的地图');
  expect(exported.visits).toEqual([first]);

  await mergeBackup(store, { ...exported, title: '新标题', visits: [{ ...first, updatedAt: '2026-05-01T00:00:00.000Z', note: 'new' }] }, 'merge');
  expect((await store.getVisit(1))?.note).toBe('new');
});

it('round-trips administrative-area visits in a complete backup', async () => {
  const store = createMemoryTripStore();
  const areaVisit: VisitV2 = {
    areaId: 'LI:overture:vaduz',
    areaSnapshot: {
      areaId: 'LI:overture:vaduz',
      countryCode: 'LI',
      sourceId: 'vaduz',
      adminLevel: 'municipality',
      nameZh: '瓦杜兹',
      nameLocal: 'Vaduz',
      aliases: [],
      centroid: [9.52, 47.14],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    visitedOn: '2025',
    datePrecision: 'year',
  };
  await store.putAreaVisit(areaVisit);

  const exported = await exportBackup(store, () => '2026-04-01T00:00:00.000Z');
  expect(exported.areaVisits).toEqual([areaVisit]);

  const restored = createMemoryTripStore();
  await restored.importBackup(exported, 'replace');
  expect(await restored.listAreaVisits()).toEqual([areaVisit]);
});
