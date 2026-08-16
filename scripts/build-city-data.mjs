#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ATTRIBUTION = 'GeoNames geographical database, licensed under CC BY 4.0 (https://www.geonames.org/).';
const CONTINENTS = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']);

export async function buildCityData({ citiesPath, aliasesPath, countriesPath, outputPath, sourceDate }) {
  assertOptions({ citiesPath, aliasesPath, countriesPath, outputPath, sourceDate });
  const countries = await readCountries(countriesPath);
  const chineseNames = await readChineseNames(aliasesPath);
  const rows = [];
  const seenIds = new Set();

  await forEachLine(citiesPath, (line, lineNumber) => {
    if (!line) return;
    const columns = line.split('\t');
    if (columns.length < 19) throw new Error(`Malformed cities500 row at line ${lineNumber}: expected 19 columns`);

    const [idText, name, asciiName, aliasesText, latText, lonText] = columns;
    const countryCode = columns[8];
    const admin1 = columns[10];
    const populationText = columns[14];
    const id = parseInteger(idText);
    const lat = Number(latText);
    const lon = Number(lonText);
    const population = populationText ? parseInteger(populationText) : undefined;
    if (
      id === undefined ||
      !name ||
      !asciiName ||
      !countryCode ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180 ||
      (populationText && population === undefined)
    ) {
      throw new Error(`Malformed cities500 row at line ${lineNumber}: invalid required value`);
    }
    if (seenIds.has(id)) throw new Error(`Duplicate city ID ${id} at line ${lineNumber}`);
    seenIds.add(id);

    const country = countries.get(countryCode);
    if (!country) throw new Error(`Unknown country code ${countryCode} at cities500 line ${lineNumber}`);
    const chinese = chineseNames.get(id);
    const aliases = uniqueStrings([
      ...(aliasesText ? aliasesText.split(',') : []),
      ...(chinese?.aliases ?? []),
    ]).filter((alias) => alias !== name && alias !== asciiName);
    rows.push([
      id,
      name,
      asciiName,
      aliases,
      countryCode,
      country.continent,
      lat,
      lon,
      chinese?.preferred ?? null,
      admin1 || null,
      population ?? null,
    ]);
  });

  rows.sort((left, right) => left[0] - right[0]);
  const serializedRows = JSON.stringify(rows);
  const checksum = createHash('sha256').update(serializedRows).digest('hex');
  const source = renderModule(rows, sourceDate, checksum);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, 'utf8');
  return { cityCount: rows.length, checksum };
}

async function readCountries(path) {
  const countries = new Map();
  await forEachLine(path, (line, lineNumber) => {
    if (!line || line.startsWith('#')) return;
    const columns = line.split('\t');
    const code = columns[0];
    const continent = columns[8];
    if (columns.length < 9 || !code || !CONTINENTS.has(continent)) {
      throw new Error(`Malformed countryInfo row at line ${lineNumber}`);
    }
    if (countries.has(code)) throw new Error(`Duplicate country code ${code} at line ${lineNumber}`);
    countries.set(code, { continent });
  });
  return countries;
}

async function readChineseNames(path) {
  const byCity = new Map();
  await forEachLine(path, (line, lineNumber) => {
    if (!line) return;
    const columns = line.split('\t');
    if (columns.length < 4) throw new Error(`Malformed alternateNamesV2 row at line ${lineNumber}`);
    const cityId = parseInteger(columns[1]);
    const language = columns[2];
    const name = columns[3]?.trim();
    if (cityId === undefined || !language || !name) {
      throw new Error(`Malformed alternateNamesV2 row at line ${lineNumber}`);
    }
    if (language !== 'zh' && language !== 'zh-CN') return;

    const preferred = columns[4] === '1';
    const candidate = { name, preferred, language };
    const existing = byCity.get(cityId) ?? [];
    existing.push(candidate);
    byCity.set(cityId, existing);
  });

  const selected = new Map();
  for (const [cityId, candidates] of byCity) {
    candidates.sort(
      (left, right) =>
        Number(right.preferred) - Number(left.preferred) ||
        languageRank(left.language) - languageRank(right.language) ||
        compareCodePoints(left.name, right.name),
    );
    selected.set(cityId, {
      preferred: candidates[0].name,
      aliases: uniqueStrings(candidates.map(({ name }) => name)),
    });
  }
  return selected;
}

function languageRank(language) {
  return language === 'zh-CN' ? 0 : 1;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function forEachLine(path, callback) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      callback(line.replace(/\r$/, ''), lineNumber);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function parseInteger(value) {
  if (!/^\d+$/.test(value ?? '')) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function renderModule(rows, sourceDate, checksum) {
  return `// Generated by scripts/build-city-data.mjs. Do not edit manually.\n` +
    `import type { CitySummary, ContinentCode } from '../domain/types';\n\n` +
    `type CityRow = readonly [number, string, string, readonly string[], string, ContinentCode, number, number, string | null, string | null, number | null];\n\n` +
    `export const CITY_DATA_ATTRIBUTION = ${JSON.stringify(ATTRIBUTION)};\n` +
    `export const CITY_DATA_SOURCE_DATE = ${JSON.stringify(sourceDate)};\n` +
    `export const CITY_DATA_CHECKSUM = ${JSON.stringify(checksum)};\n` +
    `export const CITY_ROWS: CityRow[] = ${safeJavaScriptJson(rows)};\n\n` +
    `export const CITIES: CitySummary[] = CITY_ROWS.map(([id, name, asciiName, aliases, countryCode, continentCode, lat, lon, zhName, admin1, population]) => {\n` +
    `  const city: CitySummary = { id, name, asciiName, aliases: [...aliases], countryCode, continentCode: continentCode as ContinentCode, lat, lon };\n` +
    `  if (zhName !== null) city.zhName = zhName;\n` +
    `  if (admin1 !== null) city.admin1 = admin1;\n` +
    `  if (population !== null) city.population = population;\n` +
    `  return city;\n` +
    `});\n`;
}

function safeJavaScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function assertOptions(options) {
  for (const key of ['citiesPath', 'aliasesPath', 'countriesPath', 'outputPath', 'sourceDate']) {
    if (typeof options[key] !== 'string' || !options[key]) throw new Error(`Missing required option: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.sourceDate)) {
    throw new Error('sourceDate must use YYYY-MM-DD');
  }
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) throw new Error(`Invalid argument near ${flag ?? '<end>'}`);
    values[flag.slice(2)] = value;
  }
  return {
    citiesPath: values.cities,
    aliasesPath: values['alternate-names'],
    countriesPath: values['country-info'],
    outputPath: values.output,
    sourceDate: values['source-date'],
  };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const result = await buildCityData(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
