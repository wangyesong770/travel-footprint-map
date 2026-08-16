import { describe, expect, it } from 'vitest';

import type { CityArea, CountryManifestEntry } from '../areas/types';
import {
  WORLD_MAP_LEVEL,
  enterCountry,
  focusArea,
  restoreView,
  returnToWorld,
} from './map-view-model';

const manifest = [
  manifestEntry('CN'),
  manifestEntry('JP'),
] as const;

const beijing = area('CN:osm:beijing', 'CN');
const tokyo = area('JP:osm:tokyo', 'JP');

describe('map view model', () => {
  it('starts at the world level', () => {
    expect(WORLD_MAP_LEVEL).toEqual({ kind: 'world' });
  });

  it('enters a country that exists in the manifest', () => {
    expect(enterCountry('CN', manifest)).toEqual({ kind: 'country', countryCode: 'CN' });
  });

  it('normalizes lowercase country codes', () => {
    expect(enterCountry('jp', manifest)).toEqual({ kind: 'country', countryCode: 'JP' });
  });

  it.each(['', 'C', 'CHN', '1N', 'US'])(
    'rejects an invalid or missing country code %j',
    (countryCode) => {
      expect(() => enterCountry(countryCode, manifest)).toThrow(RangeError);
    },
  );

  it('supports an area-search deep link through country entry and area focus', () => {
    const country = enterCountry('cn', manifest);

    expect(focusArea(country, beijing)).toEqual({
      kind: 'country',
      countryCode: 'CN',
      focusedAreaId: 'CN:osm:beijing',
    });
  });

  it('returns to the world without retaining country focus', () => {
    expect(returnToWorld()).toEqual({ kind: 'world' });
  });

  it('rejects focusing an area while at world level', () => {
    expect(() => focusArea(WORLD_MAP_LEVEL, beijing)).toThrow(RangeError);
  });

  it('rejects focusing an area from another country', () => {
    expect(() => focusArea(enterCountry('CN', manifest), tokyo)).toThrow(RangeError);
  });

  it('restores a serializable country view with a valid focused area', () => {
    const stored = JSON.parse(
      JSON.stringify({ kind: 'country', countryCode: 'cn', focusedAreaId: beijing.properties.areaId }),
    );

    expect(restoreView(stored, manifest, [beijing, tokyo])).toEqual({
      kind: 'country',
      countryCode: 'CN',
      focusedAreaId: 'CN:osm:beijing',
    });
  });

  it('drops a stale focused area while preserving a valid country', () => {
    expect(
      restoreView(
        { kind: 'country', countryCode: 'CN', focusedAreaId: 'CN:osm:removed' },
        manifest,
        [beijing],
      ),
    ).toEqual({ kind: 'country', countryCode: 'CN' });
  });

  it('drops a focused area that belongs to a different country', () => {
    expect(
      restoreView(
        { kind: 'country', countryCode: 'CN', focusedAreaId: tokyo.properties.areaId },
        manifest,
        [beijing, tokyo],
      ),
    ).toEqual({ kind: 'country', countryCode: 'CN' });
  });

  it.each([
    undefined,
    null,
    'country',
    {},
    { kind: 'world', countryCode: 'CN' },
    { kind: 'country' },
    { kind: 'country', countryCode: 'US' },
  ])('safely restores invalid or stale state %j to world', (stored) => {
    expect(restoreView(stored, manifest, [beijing, tokyo])).toEqual({ kind: 'world' });
  });
});

function manifestEntry(countryCode: 'CN' | 'JP'): CountryManifestEntry {
  return {
    schemaVersion: 1,
    countryCode,
    boundaryVersion: '2026-08-16',
    administrativeScheme: 'test',
    featureCount: 1,
    byteSize: 1,
    checksum: 'sha256:test',
    updatedAt: '2026-08-16T00:00:00.000Z',
    source: 'fixture',
    attribution: 'fixture',
  };
}

function area(areaId: CityArea['properties']['areaId'], countryCode: 'CN' | 'JP'): CityArea {
  return {
    type: 'Feature',
    properties: {
      areaId,
      countryCode,
      sourceId: areaId,
      adminLevel: 'test',
      nameLocal: areaId,
      aliases: [],
      centroid: [0, 0],
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]],
    },
  };
}
