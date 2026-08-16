import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DatePrecision, VisitV2 } from '../domain/types';
import type { AreaId, CountryBoundaryPackage } from '../areas/types';
import {
  createLegacyVisit,
  createMigrationResult,
  createVisitV2,
} from './migration-types';
import type {
  BackupV2,
  MigrationCandidate,
  MigrationResult,
} from './migration-types';

const AREA_ID = 'CN:osm:110100' as AreaId;

function visitInput(visitedOn: string, datePrecision: DatePrecision): VisitV2 {
  return {
    areaId: AREA_ID,
    areaSnapshot: {
      areaId: AREA_ID,
      countryCode: 'CN',
      sourceId: '110100',
      adminLevel: 'prefecture',
      nameZh: '北京市',
      nameLocal: 'Beijing',
      aliases: ['北京', 'Peking'],
      centroid: [116.4074, 39.9042],
    },
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:01:00.000Z',
    visitedOn,
    datePrecision,
    note: '秋日旅行',
  };
}

function legacySource() {
  return {
    cityId: 1_814_997,
    citySnapshot: {
      id: 1_814_997,
      name: 'Beijing',
      asciiName: 'Beijing',
      aliases: ['Peking', '北京'],
      countryCode: 'CN',
      continentCode: 'AS' as const,
      lat: 39.9042,
      lon: 116.4074,
      zhName: '北京',
      admin1: '22',
      population: 21_893_095,
    },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    visitedOn: '2025-10',
    datePrecision: 'month' as const,
    note: '旧版备注',
  };
}

describe('VisitV2 contract', () => {
  it.each([
    ['2024', 'year'],
    ['2024-08', 'month'],
    ['2024-08-16', 'day'],
  ] as const)('serializes %s without a numeric city identity', (visitedOn, precision) => {
    const visit = createVisitV2(visitInput(visitedOn, precision));
    const serialized = JSON.parse(JSON.stringify(visit)) as Record<string, unknown>;

    expect(serialized).not.toHaveProperty('cityId');
    expect(serialized).toMatchObject({ areaId: AREA_ID, visitedOn, datePrecision: precision });
  });

  it('rejects a date precision that disagrees with the fuzzy date', () => {
    expect(() => createVisitV2(visitInput('2024-08', 'day'))).toThrow('日期精度');
  });

  it('deep-clones and freezes the nested area snapshot', () => {
    const input = visitInput('2024', 'year');
    const visit = createVisitV2(input);

    (input.areaSnapshot.aliases as string[])[0] = '被篡改';
    (input.areaSnapshot.centroid as [number, number])[0] = 0;

    expect(visit.areaSnapshot.aliases).toEqual(['北京', 'Peking']);
    expect(visit.areaSnapshot.centroid).toEqual([116.4074, 39.9042]);
    expect(Object.isFrozen(visit)).toBe(true);
    expect(Object.isFrozen(visit.areaSnapshot.aliases)).toBe(true);
    expect(Object.isFrozen(visit.areaSnapshot.centroid)).toBe(true);
  });
});

describe('migration contracts', () => {
  it('retains a complete immutable v1 snapshot when the match is ambiguous', () => {
    const source = legacySource();
    const candidates = [
      { areaId: AREA_ID, nameZh: '北京市', nameLocal: 'Beijing' },
      { areaId: 'CN:osm:110101' as AreaId, nameZh: '东城区', nameLocal: 'Dongcheng' },
    ] satisfies MigrationCandidate[];
    const legacy = createLegacyVisit({ status: 'ambiguous', source, candidates });

    source.citySnapshot.aliases[0] = 'changed';
    candidates[0]!.nameLocal = 'changed';

    expect(legacy.source).toEqual(legacySource());
    expect(legacy.candidates.map((candidate) => candidate.areaId)).toEqual([
      'CN:osm:110100',
      'CN:osm:110101',
    ]);
    expect(Object.isFrozen(legacy.source.citySnapshot.aliases)).toBe(true);
    expect(Object.isFrozen(legacy.candidates)).toBe(true);
  });

  it('makes every legal status explicit and rejects unknown runtime statuses', () => {
    const resolved = createMigrationResult({
      status: 'resolved',
      source: legacySource(),
      visit: visitInput('2024', 'year'),
    });
    const outside = createMigrationResult(createLegacyVisit({ status: 'outside', source: legacySource() }));
    const unavailable = createMigrationResult(createLegacyVisit({ status: 'country-unavailable', source: legacySource() }));

    expect([resolved.status, outside.status, unavailable.status]).toEqual([
      'resolved',
      'outside',
      'country-unavailable',
    ]);
    expect(() => createMigrationResult({ status: 'ignored' } as unknown as MigrationResult)).toThrow('迁移状态');

    // @ts-expect-error Illegal migration statuses are not representable.
    const impossible: MigrationResult = { status: 'ignored' };
    expectTypeOf(impossible).toEqualTypeOf<MigrationResult>();
  });
});

describe('BackupV2 contract', () => {
  it('explicitly models full visited boundaries and optional complete country packages', () => {
    const countryPackage: CountryBoundaryPackage = {
      schemaVersion: 1,
      countryCode: 'CN',
      boundaryVersion: '2026-08-16',
      administrativeScheme: '地级行政区',
      source: 'osm',
      attribution: '© OpenStreetMap contributors',
      features: [],
    };
    const backup: BackupV2 = {
      schemaVersion: 2,
      exportedAt: '2026-08-16T12:00:00.000Z',
      title: '我的旅行足迹',
      visits: [createVisitV2(visitInput('2024', 'year'))],
      legacyVisits: [],
      visitedAreaBoundaries: [{
        areaId: AREA_ID,
        countryCode: 'CN',
        boundaryVersion: '2026-08-16',
        source: 'osm',
        attribution: '© OpenStreetMap contributors',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[[116, 39], [117, 39], [117, 40], [116, 39]]]],
        },
      }],
      countryPackages: [countryPackage],
    };

    expect(backup.schemaVersion).toBe(2);
    expect(backup.visitedAreaBoundaries[0]?.geometry.coordinates).toHaveLength(1);
    expect(backup.countryPackages?.[0]?.features).toEqual([]);
    expectTypeOf(backup.schemaVersion).toEqualTypeOf<2>();
  });
});
