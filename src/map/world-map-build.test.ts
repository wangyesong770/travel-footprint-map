import { describe, expect, it } from 'vitest';

import { WORLD_MAP } from '../generated/world-map';

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

  it('keeps antimeridian polygons at the map edges instead of drawing across the world', () => {
    const result = convertWorldGeoJson({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { ISO_A2: 'FJ', NAME: 'Fiji' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[179, -18], [-179, -18], [-179, -17], [179, -18]]],
        },
      }],
    }, { precision: 2, tolerance: 0 });

    const commands = [...result.countries[0].path.matchAll(/([ML])(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)];
    const jumps = commands.flatMap((command, index) => {
      const previous = commands[index - 1];
      return command[1] === 'L' && previous ? [Math.abs(Number(command[2]) - Number(previous[2]))] : [];
    });

    expect(Math.max(...jumps)).toBeLessThan(100);
  });

  it('keeps the default France label when Natural Earth uses its stable FRA geometry id', () => {
    const result = convertWorldGeoJson({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          ISO_A2: '-99',
          ADM0_A3_CN: 'FRA',
          NAME_ZH: '法国',
          LABEL_X: 2,
          LABEL_Y: 46,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[1, 45], [3, 45], [2, 47], [1, 45]]],
        },
      }],
    }, { precision: 2 });

    expect(result.countries[0].id).toBe('FRA');
    expect(result.countries[0].label?.name).toBe('法国');
  });

  it('ships the fixed 10m China-POV source and independent microstate geometries', () => {
    const ids = new Set<string>(WORLD_MAP.countries.map((country) => country.id));
    const source = (WORLD_MAP as unknown as { source?: Record<string, unknown> }).source;

    expect(source).toMatchObject({
      dataset: 'Natural Earth Admin 0 Countries',
      scale: '10m',
      version: '5.1.1',
      perspective: 'China',
      url: 'https://naturalearth.s3.amazonaws.com/5.1.1/10m_cultural/ne_10m_admin_0_countries_chn.zip',
      sha256: '16e7589083527d01208b9f645fc8643c767170258e9d13b59d37bc5a1f6a8758',
      license: 'Natural Earth public domain',
      licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
    });
    expect([
      'AD', 'AG', 'BB', 'BH', 'CK', 'CV', 'DM', 'FM', 'GD', 'KI', 'KM',
      'KN', 'LC', 'LI', 'MC', 'MH', 'MT', 'MU', 'MV', 'NR', 'NU', 'PW',
      'SC', 'SG', 'SM', 'ST', 'TO', 'TV', 'VA', 'VC', 'WS',
    ].every((id) => ids.has(id))).toBe(true);
    expect(WORLD_MAP.countries.length).toBeGreaterThanOrEqual(246);
  });
});
