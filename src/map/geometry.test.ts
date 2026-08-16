import { describe, expect, it } from 'vitest';

import type { CountryBoundaryPackage, CityArea } from '../areas/types';
import type { MultiPolygonGeometry } from '../domain/types';
import { findContainingAreas, normalizeAntimeridian, validateGeometry } from './geometry';

function area(areaId: `ZZ:test:${string}`, coordinates: number[][][][]): CityArea {
  return {
    type: 'Feature',
    properties: {
      areaId,
      countryCode: 'ZZ',
      sourceId: areaId.split(':').at(-1)!,
      adminLevel: 'municipality',
      nameLocal: areaId,
      aliases: [],
      centroid: [0, 0],
    },
    geometry: { type: 'MultiPolygon', coordinates: coordinates as MultiPolygonGeometry['coordinates'] },
  };
}

function countryPackage(features: CityArea[]): CountryBoundaryPackage {
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

describe('GeoJSON geometry validation', () => {
  it('normalizes a Polygon to a MultiPolygon without retaining input references', () => {
    const input = {
      type: 'Polygon',
      coordinates: [[[10, 10], [12, 10], [12, 12], [10, 10]]],
    };

    const geometry = validateGeometry(input);
    input.coordinates[0]![0]![0] = 99;

    expect(geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [[[[10, 10], [12, 10], [12, 12], [10, 10]]]],
    });
  });

  it('accepts and clones a MultiPolygon', () => {
    const geometry = validateGeometry({
      type: 'MultiPolygon',
      coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]],
    });

    expect(geometry.type).toBe('MultiPolygon');
    expect(geometry.coordinates).toHaveLength(1);
  });

  it.each([
    [{ type: 'Point', coordinates: [0, 0] }, '不支持的几何类型'],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }, '线环至少需要 4 个坐标'],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, '线环必须闭合'],
    [{ type: 'Polygon', coordinates: [[[0, 0], [181, 0], [1, 1], [0, 0]]] }, '经纬度超出范围'],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, Number.NaN], [1, 1], [0, 0]]] }, '坐标必须是有限数值'],
  ])('rejects malformed or unsupported input', (input, message) => {
    expect(() => validateGeometry(input)).toThrow(message as string);
  });

  it('rejects geometry beyond the configured vertex budget', () => {
    const input = {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    };

    expect(() => validateGeometry(input, { maxVertices: 3 })).toThrow('边界坐标数量过多');
  });

  it('rejects a ring crafted to unwrap around the world repeatedly', () => {
    const input = {
      type: 'Polygon',
      coordinates: [[
        [0, 0], [170, 0], [-20, 1], [150, 2], [-40, 3], [130, 4], [-60, 5], [110, 6], [0, 0],
      ]],
    };

    expect(() => validateGeometry(input)).toThrow('边界跨越反经线次数过多');
  });
});

describe('antimeridian normalization', () => {
  it('slices a dateline-crossing polygon into world-bounded polygons', () => {
    const geometry = validateGeometry({
      type: 'Polygon',
      coordinates: [[[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]]],
    });

    const normalized = normalizeAntimeridian(geometry);

    expect(normalized.coordinates).toHaveLength(2);
    for (const polygon of normalized.coordinates) {
      for (const [lon] of polygon[0]!) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
      }
    }
    expect(normalized.coordinates.some((polygon) => polygon[0]!.some(([lon]) => lon === 180))).toBe(true);
    expect(normalized.coordinates.some((polygon) => polygon[0]!.some(([lon]) => lon === -180))).toBe(true);
  });

  it('leaves an ordinary polygon as one polygon', () => {
    const geometry = validateGeometry({
      type: 'Polygon',
      coordinates: [[[10, 0], [20, 0], [20, 10], [10, 0]]],
    });

    expect(normalizeAntimeridian(geometry)).toEqual(geometry);
  });
});

describe('point-to-area lookup', () => {
  it('finds a point inside a polygon and includes its outer boundary', () => {
    const square = area('ZZ:test:square', [[[
      [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
    ]]]);
    const pkg = countryPackage([square]);

    expect(findContainingAreas([5, 5], pkg).map((feature) => feature.properties.areaId)).toEqual(['ZZ:test:square']);
    expect(findContainingAreas([0, 5], pkg).map((feature) => feature.properties.areaId)).toEqual(['ZZ:test:square']);
  });

  it('excludes a point in a hole but deterministically includes the hole boundary', () => {
    const withHole = area('ZZ:test:hole', [[
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
    ]]);
    const pkg = countryPackage([withHole]);

    expect(findContainingAreas([5, 5], pkg)).toEqual([]);
    expect(findContainingAreas([3, 5], pkg).map((feature) => feature.properties.areaId)).toEqual(['ZZ:test:hole']);
  });

  it('checks every polygon in a multipolygon', () => {
    const islands = area('ZZ:test:islands', [
      [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
      [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]],
    ]);

    expect(findContainingAreas([11, 11], countryPackage([islands])).map((feature) => feature.properties.areaId)).toEqual(['ZZ:test:islands']);
  });

  it('treats a dateline-crossing polygon as the short antimeridian region', () => {
    const dateline = area('ZZ:test:dateline', [[[
      [170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10],
    ]]]);
    const pkg = countryPackage([dateline]);

    expect(findContainingAreas([179, 0], pkg).map((feature) => feature.properties.areaId)).toEqual(['ZZ:test:dateline']);
    expect(findContainingAreas([-179, 0], pkg).map((feature) => feature.properties.areaId)).toEqual(['ZZ:test:dateline']);
    expect(findContainingAreas([0, 0], pkg)).toEqual([]);
  });

  it('rejects malformed rings instead of producing a false match', () => {
    const malformed = area('ZZ:test:broken', [[[
      [0, 0], [10, 0], [10, 10], [0, 10],
    ]]]);

    expect(() => findContainingAreas([5, 5], countryPackage([malformed]))).toThrow('线环必须闭合');
  });

  it('returns every overlapping candidate in deterministic area-id order', () => {
    const coordinates = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]];
    const pkg = countryPackage([
      area('ZZ:test:zeta', coordinates),
      area('ZZ:test:alpha', coordinates),
    ]);

    expect(findContainingAreas([5, 5], pkg).map((feature) => feature.properties.areaId)).toEqual([
      'ZZ:test:alpha',
      'ZZ:test:zeta',
    ]);
  });
});
