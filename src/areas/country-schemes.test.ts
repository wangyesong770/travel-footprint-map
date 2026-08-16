import { describe, expect, it } from 'vitest';

import { createAreaId, getCountryScheme } from './country-schemes';

describe('getCountryScheme', () => {
  it('maps China to prefecture-level administrative areas', () => {
    expect(getCountryScheme('CN')).toMatchObject({
      countryCode: 'CN',
      labelZh: '地级行政区',
      source: 'overture',
      status: 'verified',
    });
    expect(getCountryScheme('CN').acceptedLevels).toContain('prefecture');
  });

  it('maps Japan to municipalities', () => {
    expect(getCountryScheme('JP')).toMatchObject({
      countryCode: 'JP',
      labelZh: '市町村',
      source: 'overture',
      status: 'verified',
    });
    expect(getCountryScheme('JP').acceptedLevels).toContain('municipality');
  });

  it('maps the United States to county and independent-city equivalents', () => {
    expect(getCountryScheme('US')).toMatchObject({
      countryCode: 'US',
      source: 'overture',
      status: 'verified',
    });
    expect(getCountryScheme('US').acceptedLevels).toEqual(
      expect.arrayContaining(['county', 'independent-city']),
    );
  });

  it('normalizes lowercase country codes', () => {
    expect(getCountryScheme('cn')).toBe(getCountryScheme('CN'));
  });

  it.each(['', 'C', 'CHN', 'C1', ' cn ', '../CN'])('rejects invalid country code %j', (code) => {
    expect(() => getCountryScheme(code)).toThrow('ISO 3166-1 alpha-2');
  });

  it('returns an explicit fallback without guessing an admin level', () => {
    const fallback = getCountryScheme('ZZ');

    expect(fallback).toMatchObject({
      countryCode: 'ZZ',
      status: 'fallback',
      labelZh: '待配置行政层级',
    });
    expect(fallback.acceptedLevels).toEqual([]);
  });

  it('does not expose mutable registry entries or nested level arrays', () => {
    const scheme = getCountryScheme('CN');

    expect(Object.isFrozen(scheme)).toBe(true);
    expect(Object.isFrozen(scheme.acceptedLevels)).toBe(true);
    expect(() => {
      (scheme.acceptedLevels as string[]).push('county');
    }).toThrow();
    expect(getCountryScheme('CN').acceptedLevels).toEqual(['prefecture']);
  });
});

describe('createAreaId', () => {
  it('uses stable source identity and not display names', () => {
    const first = createAreaId({
      countryCode: 'cn',
      source: 'osm',
      sourceId: 'relation-912940',
      nameZh: '北京市',
      nameLocal: 'Beijing',
    });
    const renamed = createAreaId({
      countryCode: 'CN',
      source: 'osm',
      sourceId: 'relation-912940',
      nameZh: '北平',
      nameLocal: 'Peking',
    });

    expect(first).toBe('CN:osm:relation-912940');
    expect(renamed).toBe(first);
  });

  it.each([
    { countryCode: 'CHN', source: 'osm', sourceId: '1' },
    { countryCode: 'CN', source: '', sourceId: '1' },
    { countryCode: 'CN', source: 'osm:relation', sourceId: '1' },
    { countryCode: 'CN', source: 'osm', sourceId: '' },
    { countryCode: 'CN', source: 'osm', sourceId: 'relation:1' },
  ])('rejects ambiguous identity components: %o', (identity) => {
    expect(() => createAreaId(identity)).toThrow();
  });
});
