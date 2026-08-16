import { describe, expect, it } from 'vitest';

// @ts-expect-error The Node build script intentionally has no runtime package dependency.
import { convertWorldGeoJson } from '../../scripts/build-world-map.mjs';

const fixture = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { ISO_A2: 'BB', NAME_ZH: '乙国', LABEL_X: 20, LABEL_Y: 10 },
      geometry: { type: 'Polygon', coordinates: [[[20, 10], [21, 10], [21, 11], [20, 10]]] },
    },
    {
      type: 'Feature',
      properties: { ISO_A2: 'AA', NAME_ZH: '甲国' },
      geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    },
  ],
};

describe('Natural Earth conversion', () => {
  it('emits deterministic, sorted lightweight paths and attribution', () => {
    const first = convertWorldGeoJson(fixture, { precision: 2 });
    const second = convertWorldGeoJson(structuredClone(fixture), { precision: 2 });

    expect(first).toEqual(second);
    expect(first.attribution).toContain('Natural Earth');
    expect(first.countries.map((country: { id: string }) => country.id)).toEqual(['AA', 'BB']);
    expect(first.countries[0].path).toMatch(/^M/);
    expect(first.countries[1].label).toBeUndefined();

    const labelled = convertWorldGeoJson(fixture, { precision: 2, labelIds: ['BB'] });
    expect(labelled.countries[1].label?.name).toBe('乙国');
    expect(labelled.countries.filter((country: { label?: unknown }) => country.label)).toHaveLength(1);
  });

  it('rejects malformed input instead of emitting unsafe path data', () => {
    expect(() => convertWorldGeoJson({ type: 'FeatureCollection', features: [{
      type: 'Feature',
      properties: { ISO_A2: 'XX' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, Number.NaN], [0, 0]]] },
    }] })).toThrow('坐标必须是有限数值');
  });
});
