import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

import { runProcess } from './lib/process-runner.mjs';

const RELEASE_PATTERN = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.\d+$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_OBJECT_KEYS = new Set(['key', 'byteSize', 'etag', 'url', 'sha256']);
const SQL_PATH = path.resolve(process.cwd(), 'scripts/audit/sql/extract-country.sql');
const SNAPSHOT_SQL_PATH = path.resolve(process.cwd(), 'scripts/audit/sql/snapshot-divisions.sql');

function escapedSqlPath(value) {
  return value.replaceAll("'", "''");
}

export function validateRelease(release) {
  const match = typeof release === 'string' ? release.match(RELEASE_PATTERN) : undefined;
  if (!match) throw new Error('invalid Overture release');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) throw new Error('invalid Overture release');
  return release;
}

function validateCountry(country, label = 'country code') {
  if (typeof country !== 'string' || !COUNTRY_PATTERN.test(country)) throw new Error(`invalid ${label}`);
  return country;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function renderCountrySql({ sourceCountryCodes, snapshotDir, outputPath }) {
  const template = await readFile(SQL_PATH, 'utf8');
  return template
    .replace('__SOURCE_COUNTRY_CODES__', `[${sourceCountryCodes.map(sqlString).join(', ')}]`)
    .replace('__SNAPSHOT_DATA_GLOB__', escapedSqlPath(path.join(snapshotDir, 'data', '**', '*.parquet')))
    .replace('__DIVISION_METADATA_PATH__', escapedSqlPath(path.join(snapshotDir, 'division-metadata', '**', '*.parquet')))
    .replace('__OUTPUT_PATH__', escapedSqlPath(outputPath));
}

async function duckDbVersion(runner, duckdbPath) {
  let result;
  try {
    result = await runner(duckdbPath, ['-version'], { shell: false, maxOutputBytes: 16 * 1024 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('DuckDB CLI is required; install duckdb and ensure it is on PATH', { cause: error });
    throw error;
  }
  if (result.exitCode !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    throw new Error(`DuckDB preflight failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout.trim();
}

function validateFilesystemPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new Error(`invalid ${label}`);
  return value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateSourceManifest(sourceManifest, release) {
  const rootKeys = new Set(['schemaVersion', 'release', 'retrievedAt', 'objects']);
  if (!isPlainObject(sourceManifest) || Object.keys(sourceManifest).some((key) => !rootKeys.has(key))
    || sourceManifest.schemaVersion !== 1 || sourceManifest.release !== release
    || typeof sourceManifest.retrievedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sourceManifest.retrievedAt)
    || !Array.isArray(sourceManifest.objects) || sourceManifest.objects.length === 0) {
    throw new Error('source manifest does not match the fixed release');
  }
  const seen = new Set();
  const types = new Set();
  for (const object of sourceManifest.objects) {
    if (!isPlainObject(object) || Object.keys(object).some((key) => !SOURCE_OBJECT_KEYS.has(key))
      || typeof object.key !== 'string'
      || !/^theme=divisions\/type=(division|division_area)\/[^/]+\.parquet$/.test(object.key)
      || seen.has(object.key) || !Number.isSafeInteger(object.byteSize) || object.byteSize < 1
      || typeof object.etag !== 'string' || object.etag.length === 0 || object.etag.length > 160
      || typeof object.sha256 !== 'string' || !SHA256_PATTERN.test(object.sha256)) {
      throw new Error('source manifest contains an invalid object');
    }
    let url;
    try { url = new URL(object.url); }
    catch { throw new Error('source manifest contains an invalid object URL'); }
    const expectedPath = `/release/${release}/${object.key}`;
    if (url.protocol !== 'https:' || url.hostname !== 'overturemaps-us-west-2.s3.us-west-2.amazonaws.com'
      || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
      || decodeURIComponent(url.pathname) !== expectedPath) {
      throw new Error('source manifest contains an invalid object URL');
    }
    seen.add(object.key);
    types.add(object.key.includes('/type=division_area/') ? 'division_area' : 'division');
  }
  if (!types.has('division') || !types.has('division_area')) {
    throw new Error('source manifest is missing required division objects');
  }
}

export async function createDivisionSnapshot({ release, snapshotDir, sourceManifestPath, runner = runProcess, duckdbPath = 'duckdb' }) {
  validateRelease(release);
  validateFilesystemPath(snapshotDir, 'snapshot directory');
  validateFilesystemPath(sourceManifestPath, 'source manifest path');
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');

  const sourceBytes = await readFile(sourceManifestPath);
  let sourceManifest;
  try {
    sourceManifest = JSON.parse(sourceBytes.toString('utf8'));
  } catch (error) {
    throw new Error('source manifest is not valid JSON', { cause: error });
  }
  validateSourceManifest(sourceManifest, release);
  const sourceSnapshotSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const duckdbVersion = await duckDbVersion(runner, duckdbPath);
  const stagingDir = `${snapshotDir}.${randomUUID()}.partial`;
  const dataDir = path.join(stagingDir, 'data');
  const divisionMetadataDir = path.join(stagingDir, 'division-metadata');
  const rowCountsPath = path.join(stagingDir, 'row-counts.json');
  const tempDir = path.join(stagingDir, 'spill');
  try {
    await mkdir(dataDir, { recursive: true });
    await Promise.all([mkdir(tempDir, { recursive: true }), mkdir(divisionMetadataDir, { recursive: true })]);
    const template = await readFile(SNAPSHOT_SQL_PATH, 'utf8');
    const baseUrl = `s3://overturemaps-us-west-2/release/${release}/theme=divisions`;
    const sql = template
      .replace('__TEMP_DIRECTORY__', escapedSqlPath(tempDir))
      .replace('__DIVISION_URL__', `${baseUrl}/type=division/*`)
      .replace('__DIVISION_AREA_URL__', `${baseUrl}/type=division_area/*`)
      .replaceAll('__DIVISION_METADATA_DIRECTORY__', escapedSqlPath(divisionMetadataDir))
      .replaceAll('__SNAPSHOT_DATA_DIRECTORY__', escapedSqlPath(dataDir))
      .replace('__ROW_COUNTS_PATH__', escapedSqlPath(rowCountsPath));
    const result = await runner(duckdbPath, [':memory:'], {
      shell: false,
      input: sql,
      maxOutputBytes: 64 * 1024,
      expectedDataDirectory: dataDir,
      expectedDivisionMetadataDirectory: divisionMetadataDir,
      expectedRowCountsPath: rowCountsPath,
    });
    if (result.exitCode !== 0) {
      const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new Error(`DuckDB snapshot failed${detail ? `: ${detail}` : ''}`);
    }
    const dataEntries = await readdir(dataDir);
    if (dataEntries.length === 0) throw new Error('DuckDB snapshot produced no partition data');
    const divisionMetadataEntries = await readdir(divisionMetadataDir);
    if (divisionMetadataEntries.length === 0) {
      throw new Error('DuckDB snapshot produced no division metadata');
    }
    const rawCounts = JSON.parse(await readFile(rowCountsPath, 'utf8'));
    if (!Array.isArray(rawCounts) || rawCounts.length === 0) throw new Error('DuckDB snapshot produced no row counts');
    const rowCounts = {};
    let totalRowCount = 0;
    for (const entry of rawCounts) {
      validateCountry(entry?.sourceCountryCode, 'snapshot country code');
      const rowCount = Number(entry?.rowCount);
      if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCounts[entry.sourceCountryCode] !== undefined) {
        throw new Error('DuckDB snapshot produced invalid row counts');
      }
      rowCounts[entry.sourceCountryCode] = rowCount;
      totalRowCount += rowCount;
      if (!Number.isSafeInteger(totalRowCount)) throw new Error('DuckDB snapshot row count overflow');
    }
    const metadata = {
      schemaVersion: 1,
      schema: { version: 1, format: 'partitioned-parquet', partitionKey: 'sourceCountryCode' },
      release,
      duckdbVersion,
      sourceSnapshotSha256,
      totalRowCount,
      rowCounts,
    };
    await rm(tempDir, { recursive: true, force: true });
    await writeFile(path.join(stagingDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(stagingDir, snapshotDir);
    return { snapshotDir, metadata };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function extractCountry({ release, country, sourceCountryCodes = [country], snapshotDir, outputDir, runner = runProcess, duckdbPath = 'duckdb' }) {
  validateRelease(release);
  validateCountry(country);
  if (!Array.isArray(sourceCountryCodes) || sourceCountryCodes.length === 0 || sourceCountryCodes.length > 32) {
    throw new Error('source country codes must be a non-empty bounded array');
  }
  const uniqueSourceCodes = [...new Set(sourceCountryCodes.map((code) => validateCountry(code, 'source country code')))];
  validateFilesystemPath(snapshotDir, 'snapshot directory');
  validateFilesystemPath(outputDir, 'output directory');
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');
  const snapshotMetadata = JSON.parse(await readFile(path.join(snapshotDir, 'metadata.json'), 'utf8'));
  if (snapshotMetadata?.schemaVersion !== 1 || snapshotMetadata.release !== release) throw new Error('local division snapshot does not match release');
  for (const code of uniqueSourceCodes) {
    if (!Number.isSafeInteger(snapshotMetadata.rowCounts?.[code]) || snapshotMetadata.rowCounts[code] < 1) {
      throw new Error(`local division snapshot has no rows for ${code}`);
    }
  }
  const version = await duckDbVersion(runner, duckdbPath);

  await mkdir(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, 'areas.geojsonseq');
  const temporaryPath = path.join(outputDir, `.areas.${randomUUID()}.partial`);
  try {
    const sql = await renderCountrySql({ sourceCountryCodes: uniqueSourceCodes, snapshotDir, outputPath: temporaryPath });
    const result = await runner(duckdbPath, [':memory:'], {
      shell: false,
      input: sql,
      maxOutputBytes: 64 * 1024,
      expectedOutputPath: temporaryPath,
    });
    if (result.exitCode !== 0) {
      const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new Error(`DuckDB extraction failed${detail ? `: ${detail}` : ''}`);
    }
    const outputStat = await stat(temporaryPath);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('DuckDB extraction produced an empty output');
    await rename(temporaryPath, finalPath);
    return {
      country,
      release,
      sourceCountryCodes: uniqueSourceCodes,
      outputPath: finalPath,
      byteSize: outputStat.size,
      duckdbVersion: version,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function parseCliArguments(argv) {
  const mode = argv[0];
  if (!['snapshot', 'country'].includes(mode)) {
    throw new Error('usage: extract-overture.mjs snapshot|country [options]');
  }
  const allowed = mode === 'snapshot'
    ? new Set(['--release', '--snapshot', '--source-manifest'])
    : new Set(['--release', '--country', '--snapshot', '--output', '--source-codes']);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || argv[index + 1] === undefined) {
      throw new Error('invalid extractor arguments');
    }
    if (values.has(argv[index])) throw new Error(`duplicate argument: ${argv[index]}`);
    values.set(argv[index], argv[index + 1]);
  }
  if (!values.has('--release') || !values.has('--snapshot')) throw new Error('release and snapshot are required');
  if (mode === 'snapshot') {
    if (!values.has('--source-manifest')) throw new Error('source manifest is required');
    return {
      mode,
      release: values.get('--release'),
      snapshotDir: path.resolve(values.get('--snapshot')),
      sourceManifestPath: path.resolve(values.get('--source-manifest')),
    };
  }
  if (!values.has('--country') || !values.has('--output')) throw new Error('country and output are required');
  return {
    mode,
    release: values.get('--release'),
    country: values.get('--country'),
    snapshotDir: path.resolve(values.get('--snapshot')),
    outputDir: path.resolve(values.get('--output')),
    ...(values.has('--source-codes') ? { sourceCountryCodes: values.get('--source-codes').split(',') } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCliArguments(process.argv.slice(2));
  const operation = options.mode === 'snapshot' ? createDivisionSnapshot : extractCountry;
  operation(options).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Overture extraction failed'}\n`);
    process.exitCode = 1;
  });
}
