import { describe, expect, it } from 'vitest';

import { createAreaIndex, type AreaIndexRecord } from './area-index';

const records: readonly AreaIndexRecord[] = [
  {
    kind: 'country',
    countryCode: 'CN',
    boundaryVersion: 'cn-v1',
    nameZh: '中国',
    nameLocal: 'China',
    aliases: ['中华人民共和国', 'PRC'],
  },
  {
    kind: 'country',
    countryCode: 'US',
    boundaryVersion: 'us-v1',
    nameZh: '美国',
    nameLocal: 'United States',
    aliases: ['USA', 'US'],
  },
  {
    kind: 'area',
    areaId: 'CN:overture:beijing',
    countryCode: 'CN',
    boundaryVersion: 'cn-v1',
    adminLevel: 'prefecture',
    nameZh: '北京市',
    nameLocal: 'Beijing',
    aliases: ['北京', 'Peking'],
  },
  {
    kind: 'area',
    areaId: 'US:overture:quebec-example',
    countryCode: 'US',
    boundaryVersion: 'us-v1',
    adminLevel: 'county',
    nameZh: '魁北克示例区',
    nameLocal: 'Québec Example',
    aliases: [],
  },
  {
    kind: 'area',
    areaId: 'US:overture:fairfax-city',
    countryCode: 'US',
    boundaryVersion: 'us-v1',
    adminLevel: 'independent-city',
    nameZh: '费尔法克斯',
    nameLocal: 'Fairfax',
    aliases: [],
  },
  {
    kind: 'area',
    areaId: 'US:overture:fairfax-county',
    countryCode: 'US',
    boundaryVersion: 'us-v1',
    adminLevel: 'county',
    nameZh: '费尔法克斯县',
    nameLocal: 'Fairfax County',
    aliases: ['Fairfax'],
  },
];

describe('area-aware search index', () => {
  const index = createAreaIndex(records);

  it('uses the Chinese name as the primary display name and matches local names and aliases', () => {
    expect(index.search('Beijing', 5)[0]).toMatchObject({
      kind: 'area', areaId: 'CN:overture:beijing', displayName: '北京市', matchedName: 'Beijing',
    });
    expect(index.search('Peking', 5)[0]).toMatchObject({ areaId: 'CN:overture:beijing' });
    expect(index.search('北京', 5)[0]).toMatchObject({ areaId: 'CN:overture:beijing', displayName: '北京市' });
  });

  it('folds accents and case before exact, prefix and substring matching', () => {
    expect(index.search('quebec', 5)[0]).toMatchObject({ areaId: 'US:overture:quebec-example' });
    expect(index.search('QUEBEC EX', 5)[0]).toMatchObject({ areaId: 'US:overture:quebec-example' });
    expect(index.search('bec ex', 5)[0]).toMatchObject({ areaId: 'US:overture:quebec-example' });
  });

  it('returns stable IDs and disambiguates same-name areas with country and admin level', () => {
    const results = index.search('Fairfax', 5);
    expect(results.map((result) => result.kind === 'area' ? result.areaId : result.countryCode)).toEqual([
      'US:overture:fairfax-city', 'US:overture:fairfax-county',
    ]);
    expect(results[0]?.secondaryLabel).toBe('美国 · independent-city');
    expect(results[1]?.secondaryLabel).toBe('美国 · county');
  });

  it('ranks exact and prefix country results before area substring results', () => {
    const extended = createAreaIndex([
      ...records,
      {
        kind: 'area', areaId: 'US:overture:china-grove', countryCode: 'US', boundaryVersion: 'us-v1',
        adminLevel: 'county', nameZh: '中国树林区', nameLocal: 'China Grove', aliases: [],
      },
    ]);
    expect(extended.search('中国', 5).map((result) => result.kind)).toEqual(['country', 'area']);
    expect(extended.search('USA', 5)[0]).toMatchObject({ kind: 'country', countryCode: 'US' });
  });

  it('returns no matches for blank or overlong queries and enforces the result limit', () => {
    expect(index.search('  ', 10)).toEqual([]);
    expect(index.search('a'.repeat(161), 10)).toEqual([]);
    expect(index.search('Fairfax', 1)).toHaveLength(1);
    expect(index.search('Fairfax', 0)).toEqual([]);
  });

  it('exposes exact index/package version compatibility', () => {
    expect(index.hasCountryVersion('cn', 'cn-v1')).toBe(true);
    expect(index.hasCountryVersion('CN', 'cn-v0')).toBe(false);
    expect(index.hasCountryVersion('JP', 'jp-v1')).toBe(false);
  });

  it('rejects duplicate identities and area records without a matching configured country version', () => {
    expect(() => createAreaIndex([...records, records[2]!])).toThrow(/duplicate/i);
    expect(() => createAreaIndex([
      ...records,
      {
        kind: 'area', areaId: 'JP:overture:tokyo', countryCode: 'JP', boundaryVersion: 'jp-v1',
        adminLevel: 'municipality', nameLocal: 'Tokyo', aliases: [],
      },
    ])).toThrow(/country|version/i);
    expect(() => createAreaIndex([
      ...records,
      {
        kind: 'area', areaId: 'US:overture:stale', countryCode: 'US', boundaryVersion: 'us-v0',
        adminLevel: 'county', nameLocal: 'Stale', aliases: [],
      },
    ])).toThrow(/version/i);
  });

  it('snapshots input names so later caller mutation cannot alter trusted search output', () => {
    const mutable = records.map((record) => ({ ...record, aliases: [...record.aliases] })) as AreaIndexRecord[];
    const stableIndex = createAreaIndex(mutable);
    (mutable[2] as { nameZh?: string }).nameZh = '<img src=x onerror=alert(1)>';
    expect(stableIndex.search('Beijing', 1)[0]?.displayName).toBe('北京市');
  });
});
