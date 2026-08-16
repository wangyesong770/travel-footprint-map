import { describe, expect, it } from 'vitest';

import { normalizeAntimeridian, validateGeometry } from './geometry';

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
