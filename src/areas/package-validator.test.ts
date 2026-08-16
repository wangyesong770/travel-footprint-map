import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CountryManifestEntry } from './types';
import { parseCountryManifest, parseCountryPackage } from './package-validator';

type WireProperties = {
  areaId: string;
  countryCode: string;
  sourceId: string;
  adminLevel: string;
  nameZh?: string;
  nameLocal: string;
  aliases: string[];
  centroid: [number, number];
};

function properties(sourceId = '110100'): WireProperties {
  return {
    areaId: `CN:osm:${sourceId}`,
    countryCode: 'CN',
    sourceId,
    adminLevel: 'prefecture',
    nameZh: '北京市',
    nameLocal: 'Beijing',
    aliases: ['北京'],
    centroid: [116.4, 39.9],
  };
}

function polygonGeometry(sourceId = '110100') {
  return { type: 'Polygon', arcs: [[0]], properties: properties(sourceId) };
}

function topology(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Topology',
    schemaVersion: 1,
    countryCode: 'CN',
    boundaryVersion: '2026-08-16',
    administrativeScheme: '地级行政区',
    source: 'osm',
    attribution: '© OpenStreetMap contributors',
    transform: { scale: [1, 1], translate: [0, 0] },
    objects: {
      areas: { type: 'GeometryCollection', geometries: [polygonGeometry()] },
    },
    arcs: [[[116, 39], [1, 0], [0, 1], [-1, -1]]],
    ...overrides,
  };
}

function wire(value: unknown = topology()): string {
  return JSON.stringify(value);
}

function entryFor(raw: string, overrides: Partial<CountryManifestEntry> = {}): CountryManifestEntry {
  return {
    schemaVersion: 1,
    countryCode: 'CN',
    boundaryVersion: '2026-08-16',
    administrativeScheme: '地级行政区',
    featureCount: 1,
    byteSize: new TextEncoder().encode(raw).byteLength,
    checksum: 'a'.repeat(64),
    updatedAt: '2026-08-16T00:00:00.000Z',
    source: 'osm',
    attribution: '© OpenStreetMap contributors',
    ...overrides,
  };
}

describe('country manifest validation', () => {
  it('strictly reconstructs a valid entry without unknown properties', () => {
    const parsed = parseCountryManifest({ CN: { ...entryFor(wire()), ignored: '<script>bad()</script>' } }).CN!;

    expect(Object.keys(parsed).sort()).toEqual([
      'administrativeScheme', 'attribution', 'boundaryVersion', 'byteSize', 'checksum',
      'countryCode', 'featureCount', 'schemaVersion', 'source', 'updatedAt',
    ]);
  });

  it('rejects wrong schema versions and invalid manifest limits', () => {
    expect(() => parseCountryManifest({ CN: { ...entryFor(wire()), schemaVersion: 2 } })).toThrow('清单版本');
    expect(() => parseCountryManifest({ CN: { ...entryFor(wire()), featureCount: -1 } })).toThrow('区域数量');
    expect(() => parseCountryManifest({ CN: { ...entryFor(wire()), byteSize: Number.MAX_SAFE_INTEGER + 1 } })).toThrow('文件大小');
    expect(() => parseCountryManifest({ US: entryFor(wire()) })).toThrow('国家代码');
  });
});

describe('country TopoJSON package validation', () => {
  it('accepts every checked-in fixture package using its real manifest bytes', () => {
    const directory = join(process.cwd(), 'public', 'data', 'countries');
    const manifest = parseCountryManifest(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as unknown);

    for (const countryCode of ['CN', 'US']) {
      const bytes = readFileSync(join(directory, `${countryCode}.topojson`));
      const parsed = parseCountryPackage(bytes, manifest[countryCode]!);
      expect(parsed.countryCode).toBe(countryCode);
      expect(parsed.features).toHaveLength(manifest[countryCode]!.featureCount);
    }
  });

  it('decodes and whitelists valid Polygon data', () => {
    const raw = wire();
    const parsed = parseCountryPackage(raw, entryFor(raw));

    expect(parsed.features).toEqual([{
      type: 'Feature',
      properties: properties(),
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[[116, 39], [117, 39], [117, 40], [116, 39]]]],
      },
    }]);
    expect(Object.keys(parsed.features[0]!.properties).sort()).toEqual([
      'adminLevel', 'aliases', 'areaId', 'centroid', 'countryCode', 'nameLocal',
      'nameZh', 'sourceId',
    ]);
  });

  it('accepts MultiPolygon and reversed arc references', () => {
    const value = topology({
      objects: {
        areas: {
          type: 'GeometryCollection',
          geometries: [{ type: 'MultiPolygon', arcs: [[[0]], [[-2]]], properties: properties() }],
        },
      },
      arcs: [
        [[0, 0], [1, 0], [0, 1], [-1, -1]],
        [[10, 10], [1, 0], [0, 1], [-1, -1]],
      ],
    });
    const raw = wire(value);

    expect(parseCountryPackage(raw, entryFor(raw)).features[0]!.geometry.coordinates).toHaveLength(2);
  });

  it('rejects schema, country, version and metadata mismatches', () => {
    for (const [field, value, message] of [
      ['schemaVersion', 2, '数据包版本'],
      ['countryCode', 'US', '国家代码'],
      ['boundaryVersion', 'old', '边界版本'],
      ['administrativeScheme', 'wrong', '行政层级'],
      ['source', 'other', '数据来源'],
      ['attribution', 'other', '署名'],
    ] as const) {
      const raw = wire(topology({ [field]: value }));
      expect(() => parseCountryPackage(raw, entryFor(raw))).toThrow(message);
    }
  });

  it('rejects duplicate and malformed area identities', () => {
    const geometries = [polygonGeometry(), polygonGeometry()];
    const raw = wire(topology({ objects: { areas: { type: 'GeometryCollection', geometries } } }));
    expect(() => parseCountryPackage(raw, entryFor(raw, { featureCount: 2 }))).toThrow('区域标识重复');

    const wrong = polygonGeometry();
    wrong.properties.areaId = 'US:osm:110100';
    const wrongRaw = wire(topology({ objects: { areas: { type: 'GeometryCollection', geometries: [wrong] } } }));
    expect(() => parseCountryPackage(wrongRaw, entryFor(wrongRaw))).toThrow('区域标识');
  });

  it('rejects prototype keys but drops harmless unknown nested fields', () => {
    const polluted = JSON.parse(wire()) as Record<string, unknown>;
    Object.defineProperty(polluted, '__proto__', { value: { polluted: true }, enumerable: true });
    expect(() => parseCountryPackage(wire(polluted), entryFor(wire(polluted)))).toThrow('禁止的属性');

    const withConstructor = topology({ constructor: { prototype: { polluted: true } } });
    const constructorRaw = wire(withConstructor);
    expect(() => parseCountryPackage(constructorRaw, entryFor(constructorRaw))).toThrow('禁止的属性');

    const clean = topology();
    const cleanGeometry = (clean.objects.areas.geometries[0] as ReturnType<typeof polygonGeometry> & { ignored?: unknown });
    cleanGeometry.ignored = { html: '<img src=x onerror=alert(1)>' };
    const cleanRaw = wire(clean);
    expect(Object.keys(parseCountryPackage(cleanRaw, entryFor(cleanRaw)).features[0]!).sort()).toEqual([
      'geometry', 'properties', 'type',
    ]);
  });

  it.each([
    ['NaN-like non-number', [[[0, 0], ['NaN', 0], [0, 1], [0, -1]]]],
    ['infinite coordinate', [[[0, 0], [Number.POSITIVE_INFINITY, 0], [0, 1], [0, -1]]]],
    ['out-of-range coordinate', [[[181, 0], [-1, 0], [0, 1], [-180, -1]]]],
  ])('rejects %s', (_label, arcs) => {
    const raw = wire(topology({ transform: undefined, arcs }));
    expect(() => parseCountryPackage(raw, entryFor(raw))).toThrow(/坐标|有限/);
  });

  it('rejects unsupported geometries and unclosed decoded rings', () => {
    const point = topology({
      objects: { areas: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0], properties: properties() }] } },
    });
    const pointRaw = wire(point);
    expect(() => parseCountryPackage(pointRaw, entryFor(pointRaw))).toThrow('几何类型');

    const open = topology({ arcs: [[[116, 39], [1, 0], [0, 1], [1, 1]]] });
    const openRaw = wire(open);
    expect(() => parseCountryPackage(openRaw, entryFor(openRaw))).toThrow('闭合');
  });

  it('rejects malformed topology arcs before decoding', () => {
    for (const arcs of [null, [[]], [[[0, 0], [1]]], [[[0, 0], [1.5, 0], [0, 1], [-1, -1]]]]) {
      const raw = wire(topology({ arcs }));
      expect(() => parseCountryPackage(raw, entryFor(raw))).toThrow(/拓扑弧|坐标/);
    }
    const badReference = topology();
    badReference.objects.areas.geometries[0]!.arcs = [[99]];
    const raw = wire(badReference);
    expect(() => parseCountryPackage(raw, entryFor(raw))).toThrow('拓扑弧引用');

    const wrappedReference = topology();
    wrappedReference.objects.areas.geometries[0]!.arcs = [[-4_294_967_297]];
    const wrappedRaw = wire(wrappedReference);
    expect(() => parseCountryPackage(wrappedRaw, entryFor(wrappedRaw))).toThrow('拓扑弧引用');

    const accumulatedOverflow = topology({
      transform: { scale: [0.000000000000001, 1], translate: [0, 0] },
      arcs: [[[Number.MAX_SAFE_INTEGER, 0], [1, 0], [-Number.MAX_SAFE_INTEGER, 1], [-1, -1]]],
    });
    const overflowRaw = wire(accumulatedOverflow);
    expect(() => parseCountryPackage(overflowRaw, entryFor(overflowRaw))).toThrow('量化拓扑弧坐标累计值');
  });

  it('enforces 100,000 vertices per area and 1,000,000 across a package', () => {
    const hugeArc = Array.from({ length: 100_001 }, (_, index) => [index === 0 ? 0 : 0, 0]);
    const single = topology({ arcs: [hugeArc] });
    const singleRaw = wire(single);
    expect(() => parseCountryPackage(singleRaw, entryFor(singleRaw))).toThrow('单个区域坐标数量过多');

    const largeArc = Array.from({ length: 100_000 }, () => [0, 0]);
    const geometries = Array.from({ length: 11 }, (_, index) => polygonGeometry(String(index)));
    const total = topology({ arcs: [largeArc], objects: { areas: { type: 'GeometryCollection', geometries } } });
    const totalRaw = wire(total);
    expect(() => parseCountryPackage(totalRaw, entryFor(totalRaw, { featureCount: 11 }))).toThrow('数据包坐标总量过多');
  });

  it('checks raw byte size before JSON parsing and the declared feature count', () => {
    const raw = wire();
    expect(() => parseCountryPackage(raw, entryFor(raw, { byteSize: raw.length - 20 }))).toThrow('文件大小');
    expect(() => parseCountryPackage(raw, entryFor(raw, { featureCount: 2 }))).toThrow('区域数量');
  });

  it('accepts HTML-significant text as inert data but rejects control characters', () => {
    const html = topology();
    html.objects.areas.geometries[0]!.properties.nameLocal = '<b>Beijing</b>';
    const htmlRaw = wire(html);
    expect(parseCountryPackage(htmlRaw, entryFor(htmlRaw)).features[0]!.properties.nameLocal).toBe('<b>Beijing</b>');

    const control = topology();
    control.objects.areas.geometries[0]!.properties.nameLocal = 'Bei\u0000jing';
    const controlRaw = wire(control);
    expect(() => parseCountryPackage(controlRaw, entryFor(controlRaw))).toThrow('控制字符');
  });
});
