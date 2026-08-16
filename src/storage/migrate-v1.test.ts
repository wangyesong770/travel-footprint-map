import { describe, expect, it } from 'vitest';

import type { CityArea, CountryBoundaryPackage } from '../areas/types';
import type { VisitRecord, VisitV2 } from '../domain/types';
import type { MigrationResult } from './migration-types';
import { mergeMappedVisits, migrateCountryVisits } from './migrate-v1';

function area(id: string, minLon = 0, maxLon = 10): CityArea {
  const areaId = `ZZ:test:${id}` as const;
  return {
    type: 'Feature',
    properties: {
      areaId,
      countryCode: 'ZZ',
      sourceId: id,
      adminLevel: 'municipality',
      nameZh: `区域${id}`,
      nameLocal: `Area ${id}`,
      aliases: [`Alias ${id}`],
      centroid: [(minLon + maxLon) / 2, 5],
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[[minLon, 0], [maxLon, 0], [maxLon, 10], [minLon, 10], [minLon, 0]]],
    },
  };
}

function pkg(features: CityArea[]): CountryBoundaryPackage {
  return {
    schemaVersion: 1,
    countryCode: 'ZZ',
    boundaryVersion: 'test',
    administrativeScheme: 'municipality',
    source: 'test',
    attribution: 'test',
    features,
  };
}

function legacy(cityId: number, overrides: Partial<VisitRecord> = {}): VisitRecord {
  return {
    cityId,
    citySnapshot: {
      id: cityId,
      name: `City ${cityId}`,
      asciiName: `City ${cityId}`,
      aliases: [],
      countryCode: 'ZZ',
      continentCode: 'EU',
      lat: 5,
      lon: 5,
    },
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function resolved(source: VisitRecord, visitOverrides: Partial<VisitV2> = {}): MigrationResult {
  const feature = area('one');
  return {
    status: 'resolved',
    source,
    visit: {
      areaId: feature.properties.areaId,
      areaSnapshot: { ...feature.properties },
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      ...(source.visitedOn === undefined ? {} : { visitedOn: source.visitedOn }),
      ...(source.datePrecision === undefined ? {} : { datePrecision: source.datePrecision }),
      ...(source.note === undefined ? {} : { note: source.note }),
      ...visitOverrides,
    },
  };
}

describe('migrateCountryVisits', () => {
  it('maps a uniquely contained legacy city to a stable area visit', () => {
    const source = legacy(1, { visitedOn: '2021-03', datePrecision: 'month', note: '春游' });

    const [result] = migrateCountryVisits([source], pkg([area('one')]));

    expect(result).toMatchObject({
      status: 'resolved',
      source,
      visit: {
        areaId: 'ZZ:test:one',
        visitedOn: '2021-03',
        datePrecision: 'month',
        note: '春游',
        areaSnapshot: { nameZh: '区域one', nameLocal: 'Area one' },
      },
    });
  });

  it('retains the complete source for zero, multiple and unavailable matches', () => {
    const outside = legacy(1, { citySnapshot: { ...legacy(1).citySnapshot, lon: 30 }, note: '原始备注' });
    const ambiguous = legacy(2);
    const unavailable = legacy(3);

    expect(migrateCountryVisits([outside], pkg([area('one')]))[0]).toEqual({ status: 'outside', source: outside });
    expect(migrateCountryVisits([ambiguous], pkg([area('zeta'), area('alpha')]))[0]).toEqual({
      status: 'ambiguous',
      source: ambiguous,
      candidates: [
        { areaId: 'ZZ:test:alpha', nameZh: '区域alpha', nameLocal: 'Area alpha' },
        { areaId: 'ZZ:test:zeta', nameZh: '区域zeta', nameLocal: 'Area zeta' },
      ],
    });
    expect(migrateCountryVisits([unavailable], undefined)[0]).toEqual({ status: 'country-unavailable', source: unavailable });
  });

  it('marks a package-country mismatch unavailable without searching it', () => {
    const source = legacy(1, { citySnapshot: { ...legacy(1).citySnapshot, countryCode: 'AA' } });
    expect(migrateCountryVisits([source], pkg([area('one')]))[0]).toEqual({
      status: 'country-unavailable',
      source,
    });
  });

  it('returns results sorted by numeric source city ID', () => {
    const results = migrateCountryVisits([legacy(9), legacy(2)], pkg([area('one')]));
    expect(results.map((result) => result.source.cityId)).toEqual([2, 9]);
  });
});

describe('mergeMappedVisits', () => {
  it('merges old cities in one area using earliest non-empty date and newest metadata', () => {
    const older = legacy(1, {
      createdAt: '2019-01-01T00:00:00.000Z',
      updatedAt: '2022-01-01T00:00:00.000Z',
      visitedOn: '2021',
      datePrecision: 'year',
      note: '旧城',
    });
    const newer = legacy(2, {
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      visitedOn: '2020-08-03',
      datePrecision: 'day',
      note: '新城',
    });
    const newerResult = resolved(newer) as Extract<MigrationResult, { status: 'resolved' }>;
    const latestSnapshot = { ...newerResult.visit.areaSnapshot, nameLocal: 'Newest Area Name' };

    const merged = mergeMappedVisits([
      resolved(older),
      resolved(newer, { areaSnapshot: latestSnapshot }),
    ]);

    expect(merged.visits).toHaveLength(1);
    expect(merged.visits[0]).toMatchObject({
      areaId: 'ZZ:test:one',
      createdAt: '2019-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      visitedOn: '2020-08-03',
      datePrecision: 'day',
      areaSnapshot: { nameLocal: 'Newest Area Name' },
    });
    expect(merged.visits[0]?.note).toContain('City 1：旧城');
    expect(merged.visits[0]?.note).toContain('City 2：新城');
    expect(merged.legacyVisits).toEqual([]);
  });

  it('retains every overflowing note source rather than silently truncating Unicode', () => {
    const first = legacy(1, { note: '😀'.repeat(240) });
    const second = legacy(2, { note: '完整保留'.repeat(90) });

    const merged = mergeMappedVisits([resolved(first), resolved(second)]);

    expect(Array.from(merged.visits[0]?.note ?? '')).toHaveLength(247);
    expect(merged.visits[0]?.note).toBe(`City 1：${first.note}`);
    expect(merged.legacyVisits).toEqual([{
      status: 'ambiguous',
      source: second,
      candidates: [{ areaId: 'ZZ:test:one', nameZh: '区域one', nameLocal: 'Area one' }],
    }]);
    expect(merged.legacyVisits[0]?.source.note).toBe(second.note);
  });

  it('retains each source exactly once when no labelled maximum-length note fits', () => {
    const first = legacy(1, { note: '甲'.repeat(500) });
    const second = legacy(2, { note: '乙'.repeat(500) });

    const merged = mergeMappedVisits([resolved(first), resolved(second)]);

    expect(merged.visits[0]?.note).toBe(first.note);
    expect(merged.legacyVisits.map((item) => item.source.cityId)).toEqual([2]);
    expect(merged.legacyVisits[0]?.source.note).toBe(second.note);
  });

  it('passes through zero/multiple/unavailable records and sorts all output deterministically', () => {
    const unresolved: MigrationResult[] = [
      { status: 'outside', source: legacy(8) },
      { status: 'country-unavailable', source: legacy(3) },
    ];
    const merged = mergeMappedVisits([resolved(legacy(5)), ...unresolved]);

    expect(merged.visits.map((visit) => visit.areaId)).toEqual(['ZZ:test:one']);
    expect(merged.legacyVisits.map((item) => item.source.cityId)).toEqual([3, 8]);
  });
});
