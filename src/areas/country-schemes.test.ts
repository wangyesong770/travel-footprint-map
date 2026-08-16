import { describe, expect, it } from 'vitest';

import { createAreaId, getCountryScheme } from './country-schemes';

describe('getCountryScheme', () => {
  it.each(['CN', 'cn', 'JP', 'US'])('rejects unaudited seed country %s', (code) => {
    expect(() => getCountryScheme(code)).toThrowError(/COUNTRY_NOT_VERIFIED/);
  });

  it.each(['', 'C', 'CHN', 'C1', ' cn ', '../CN'])('rejects invalid country code %j', (code) => {
    expect(() => getCountryScheme(code)).toThrow('ISO 3166-1 alpha-2');
  });

  it('rejects an unknown country instead of guessing an admin level', () => {
    expect(() => getCountryScheme('ZZ')).toThrowError(/COUNTRY_UNCONFIGURED/);
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
