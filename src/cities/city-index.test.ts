import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error The executable JavaScript build tool intentionally has no emitted declaration file.
import { buildCityData } from '../../scripts/build-city-data.mjs';
import { createCityIndex } from './city-index';
import { sampleCities } from './sample-data';

describe('city index', () => {
  const index = createCityIndex(sampleCities);

  it('finds a city by its preferred Chinese name', () => {
    expect(index.search('慕尼黑', 5)[0]?.name).toBe('München');
  });

  it('matches accents and casing insensitively', () => {
    expect(index.search('sao paulo', 5)[0]?.name).toBe('São Paulo');
  });

  it('returns no suggestions for an empty query', () => {
    expect(index.search('  ', 5)).toEqual([]);
  });

  it('keeps country and admin data for same-name disambiguation', () => {
    const matches = index.search('Springfield', 10);
    expect(matches).toHaveLength(2);
    expect(matches.map((city) => [city.countryCode, city.admin1])).toEqual([
      ['US', 'MO'],
      ['US', 'IL'],
    ]);
  });

  it('wraps longitude when finding cities across the antimeridian', () => {
    expect(index.nearest(179.9, 0, 1)[0]?.id).toBe(9_000_001);
    expect(index.nearest(-179.99, 0, 1)[0]?.id).toBe(9_000_002);
  });

  it('honors search and nearest result limits', () => {
    expect(index.search('spring', 1)).toHaveLength(1);
    expect(index.nearest(0, 0, 2)).toHaveLength(2);
    expect(index.search('spring', 0)).toEqual([]);
    expect(index.nearest(0, 0, Number.NaN)).toEqual([]);
  });
});

describe('GeoNames city data builder', () => {
  it('joins cities500, preferred Chinese aliases, and country continents deterministically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'city-builder-'));
    const citiesPath = join(directory, 'cities500.txt');
    const aliasesPath = join(directory, 'alternateNamesV2.txt');
    const countriesPath = join(directory, 'countryInfo.txt');
    const firstOutput = join(directory, 'first.ts');
    const secondOutput = join(directory, 'second.ts');

    await writeFile(
      citiesPath,
      [
        cityRow([
          '2867714',
          'München',
          'Munich',
          'Muenchen,Munich,慕尼黑,Monaco di Baviera,Μόναχο,Мюнхен',
          '48.13743',
          '11.57549',
          'DE',
          '02',
          '1260391',
        ]),
        cityRow([
          '3448439',
          'São Paulo',
          'Sao Paulo',
          'Sampa,Pauliceia,Terra da Garoa,São P,SaoP,SP',
          '-23.5475',
          '-46.63611',
          'BR',
          '27',
          '12400232',
        ]),
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      aliasesPath,
      [
        '1\t2867714\tzh-CN\t慕尼黑\t1\t0\t0\t0\t\t',
        '2\t2867714\tzh\t穆尼黑\t0\t0\t0\t0\t\t',
        '3\t3448439\tzh\t圣保罗\t1\t0\t0\t0\t\t',
        '4\t3448439\tde\tSankt Paul\t1\t0\t0\t0\t\t',
        '5\t3448439\t\tPauliceia\t0\t0\t1\t0\t\t',
        '6\t3448439\tfa\t\t0\t0\t0\t0\t\t',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      countriesPath,
      ['#ISO\tISO3\tISO-Numeric\tfips\tCountry\tCapital\tArea\tPopulation\tContinent', 'DE\tDEU\t276\tGM\tGermany\tBerlin\t\t\tEU', 'BR\tBRA\t076\tBR\tBrazil\tBrasilia\t\t\tSA'].join('\n'),
      'utf8',
    );

    const options = {
      citiesPath,
      aliasesPath,
      countriesPath,
      sourceDate: '2026-08-16',
    };
    const first = await buildCityData({ ...options, outputPath: firstOutput });
    const second = await buildCityData({ ...options, outputPath: secondOutput });

    expect(first).toEqual(second);
    expect(first.cityCount).toBe(2);
    expect(first.truncatedAliasCities).toBe(2);
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/);
    const generated = await readFile(firstOutput, 'utf8');
    expect(generated).toBe(await readFile(secondOutput, 'utf8'));
    expect(generated).toContain(
      '[2867714,"München","Munich",["Muenchen","Monaco di Baviera","Μόναχο","穆尼黑"],"DE","EU"',
    );
    expect(generated).toContain('GeoNames geographical database');
    expect(generated).toContain('CITY_DATA_SOURCE_DATE = "2026-08-16"');
    expect(generated).toContain('CITY_DATA_ALIAS_LIMIT = 3');
    expect(generated).toContain('CITY_DATA_TRUNCATED_ALIAS_CITIES = 2');
    expect(generated).toContain('"Sampa","Pauliceia","Terra da Garoa"');
    expect(generated).not.toContain('"São P"');
    expect(generated).not.toContain('"SaoP"');
    expect(generated).not.toContain('"SP"');
  });

  it('rejects duplicate IDs and malformed source rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'city-builder-invalid-'));
    const aliasesPath = join(directory, 'alternateNamesV2.txt');
    const countriesPath = join(directory, 'countryInfo.txt');
    const outputPath = join(directory, 'output.ts');
    await writeFile(aliasesPath, '', 'utf8');
    await writeFile(countriesPath, 'DE\tDEU\t276\tGM\tGermany\tBerlin\t\t\tEU\n', 'utf8');

    const duplicatePath = join(directory, 'duplicate.txt');
    const valid = cityRow(['2867714', 'München', 'Munich', '', '48.1', '11.5', 'DE', '02', '1000']);
    await writeFile(duplicatePath, `${valid}\n${valid}`, 'utf8');
    await expect(
      buildCityData({ citiesPath: duplicatePath, aliasesPath, countriesPath, outputPath, sourceDate: '2026-08-16' }),
    ).rejects.toThrow(/duplicate city ID/i);

    const malformedPath = join(directory, 'malformed.txt');
    await writeFile(malformedPath, 'not\tenough\tcolumns', 'utf8');
    await expect(
      buildCityData({ citiesPath: malformedPath, aliasesPath, countriesPath, outputPath, sourceDate: '2026-08-16' }),
    ).rejects.toThrow(/malformed cities500 row/i);
  });

  it('escapes HTML-significant names in generated JavaScript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'city-builder-escaping-'));
    const citiesPath = join(directory, 'cities500.txt');
    const aliasesPath = join(directory, 'alternateNamesV2.txt');
    const countriesPath = join(directory, 'countryInfo.txt');
    const outputPath = join(directory, 'output.ts');
    await writeFile(
      citiesPath,
      cityRow(['1', '</script><script>alert(1)</script>', 'Safe', '', '0', '0', 'DE', '02', '1']),
      'utf8',
    );
    await writeFile(aliasesPath, '', 'utf8');
    await writeFile(countriesPath, 'DE\tDEU\t276\tGM\tGermany\tBerlin\t\t\tEU\n', 'utf8');

    await buildCityData({ citiesPath, aliasesPath, countriesPath, outputPath, sourceDate: '2026-08-16' });

    expect(await readFile(outputPath, 'utf8')).not.toContain('</script>');
  });
});

function cityRow(
  [id, name, asciiName, aliases, lat, lon, country, admin1, population]: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ],
): string {
  return [
    id,
    name,
    asciiName,
    aliases,
    lat,
    lon,
    'P',
    'PPL',
    country,
    '',
    admin1,
    '',
    '',
    '',
    population,
    '',
    '',
    'Europe/Berlin',
    '2026-08-16',
  ].join('\t');
}
