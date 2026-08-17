import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runProcess } from './lib/process-runner.mjs';

const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const RELEASE_PATTERN = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PARTITION_BYTES = 1024 * 1024 * 1024;
const MAX_DUCKDB_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMBINATIONS = 10_000;

export async function profileCountry(args, options = {}) {
  let parsed;
  try {
    parsed = parseArguments(args);
  } catch {
    return failed('ARGUMENT_INVALID', 'argument');
  }

  let parquetPaths;
  try {
    parquetPaths = await validateSnapshot(parsed);
  } catch (error) {
    const code = error instanceof ProfileError ? error.code : 'SNAPSHOT_INVALID';
    const subject = error instanceof ProfileError ? error.subject : 'snapshot';
    return failed(code, subject, parsed);
  }

  const runner = options.runner ?? runProcess;
  const duckdbPath = options.duckdbPath ?? 'duckdb';
  if (typeof runner !== 'function' || typeof duckdbPath !== 'string' || duckdbPath.length === 0) {
    return failed('DUCKDB_FAILED', 'profile', parsed);
  }

  let execution;
  try {
    execution = await runner(duckdbPath, ['-json', ':memory:'], {
      shell: false,
      input: renderSql(parquetPaths),
      maxOutputBytes: MAX_DUCKDB_OUTPUT_BYTES,
    });
  } catch {
    return failed('DUCKDB_FAILED', 'profile', parsed);
  }
  if (execution?.exitCode !== 0 || execution.stdoutTruncated === true || typeof execution?.stdout !== 'string') {
    return failed('DUCKDB_FAILED', 'profile', parsed);
  }

  let rows;
  try {
    rows = JSON.parse(execution.stdout);
    validateRows(rows, new Set(parsed.sourceCountryCodes));
  } catch {
    return failed('DUCKDB_FAILED', 'profile', parsed);
  }

  const combinations = rows.map(normalizeRow).sort(compareCombination);
  const totalCount = combinations.reduce((sum, row) => sum + row.count, 0);
  const namedCount = combinations.reduce((sum, row) => sum + row.namedCount, 0);
  if (!Number.isSafeInteger(totalCount) || totalCount < 1 || !Number.isSafeInteger(namedCount) || namedCount > totalCount) {
    return failed('DUCKDB_FAILED', 'profile', parsed);
  }
  return {
    exitCode: 0,
    result: {
      schemaVersion: 1,
      status: 'profiled',
      countryCode: parsed.country,
      release: parsed.release,
      sourceCountryCodes: parsed.sourceCountryCodes,
      totalCount,
      nameCoverage: {
        namedCount,
        missingCount: totalCount - namedCount,
        ratio: Number((namedCount / totalCount).toFixed(6)),
      },
      combinations,
    },
  };
}

function parseArguments(args) {
  if (!Array.isArray(args) || args.length !== 8) throw new Error('invalid arguments');
  const allowed = new Map([
    ['--country', 'country'],
    ['--release', 'release'],
    ['--snapshot', 'snapshot'],
    ['--source-codes', 'sourceCodes'],
  ]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const property = allowed.get(args[index]);
    const value = args[index + 1];
    if (property === undefined || values[property] !== undefined || typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      throw new Error('invalid arguments');
    }
    values[property] = value;
  }
  if (!COUNTRY_PATTERN.test(values.country ?? '') || !isValidRelease(values.release)) throw new Error('invalid arguments');
  const sourceCountryCodes = values.sourceCodes?.split(',') ?? [];
  if (sourceCountryCodes.length < 1 || sourceCountryCodes.length > 32
    || sourceCountryCodes.some((code) => !COUNTRY_PATTERN.test(code))
    || new Set(sourceCountryCodes).size !== sourceCountryCodes.length
    || !sourceCountryCodes.includes(values.country)) {
    throw new Error('invalid arguments');
  }
  return {
    country: values.country,
    release: values.release,
    snapshotDir: path.resolve(values.snapshot),
    sourceCountryCodes: [...sourceCountryCodes].sort(),
  };
}

function isValidRelease(release) {
  const match = typeof release === 'string' ? RELEASE_PATTERN.exec(release) : null;
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

async function validateSnapshot(parsed) {
  const rootInfo = await lstat(parsed.snapshotDir).catch(() => undefined);
  const rootReal = await realpath(parsed.snapshotDir).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || rootReal !== parsed.snapshotDir) {
    throw new ProfileError('SNAPSHOT_UNSAFE', 'snapshot');
  }

  const metadata = await readMetadata(path.join(parsed.snapshotDir, 'metadata.json'));
  validateMetadata(metadata, parsed);

  const metadataRoot = path.join(parsed.snapshotDir, 'division-metadata');
  await assertCanonicalDirectory(metadataRoot);
  const parquetPaths = [];
  let totalBytes = 0;
  for (const sourceCountryCode of parsed.sourceCountryCodes) {
    const partition = path.join(metadataRoot, `sourceCountryCode=${sourceCountryCode}`);
    if (!Number.isSafeInteger(metadata.rowCounts[sourceCountryCode]) || metadata.rowCounts[sourceCountryCode] < 1) {
      throw new ProfileError('SNAPSHOT_INVALID', 'source-codes');
    }
    await assertCanonicalDirectory(partition);
    const entries = await readdir(partition, { withFileTypes: true }).catch(() => undefined);
    if (!Array.isArray(entries) || entries.length === 0) throw new ProfileError('SNAPSHOT_INVALID', 'source-codes');
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]+\.parquet$/.test(entry.name)) {
        throw new ProfileError('SNAPSHOT_UNSAFE', 'snapshot');
      }
      const filePath = path.join(partition, entry.name);
      const [fileInfo, fileReal] = await Promise.all([lstat(filePath), realpath(filePath)]);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileReal !== filePath || fileInfo.size < 1) {
        throw new ProfileError('SNAPSHOT_UNSAFE', 'snapshot');
      }
      totalBytes += fileInfo.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PARTITION_BYTES) {
        throw new ProfileError('SNAPSHOT_TOO_LARGE', 'division-metadata');
      }
      parquetPaths.push(filePath);
    }
  }
  if (parquetPaths.length === 0) throw new ProfileError('SNAPSHOT_INVALID', 'source-codes');
  return parquetPaths;
}

async function assertCanonicalDirectory(directory) {
  const [info, canonical] = await Promise.all([
    lstat(directory).catch(() => undefined),
    realpath(directory).catch(() => undefined),
  ]);
  if (!info?.isDirectory() || info.isSymbolicLink() || canonical !== directory) {
    throw new ProfileError('SNAPSHOT_UNSAFE', 'snapshot');
  }
}

async function readMetadata(metadataPath) {
  let handle;
  try {
    const [pathInfo, canonical] = await Promise.all([lstat(metadataPath), realpath(metadataPath)]);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || canonical !== metadataPath) {
      throw new ProfileError('SNAPSHOT_UNSAFE', 'snapshot');
    }
    handle = await open(metadataPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2 || info.size > MAX_METADATA_BYTES) throw new Error('invalid metadata');
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error('short metadata read');
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('SNAPSHOT_INVALID', 'snapshot');
  } finally {
    await handle?.close();
  }
}

function validateMetadata(metadata, parsed) {
  const rootKeys = ['duckdbVersion', 'release', 'rowCounts', 'schema', 'schemaVersion', 'sourceSnapshotSha256', 'totalRowCount', 'unresolved'];
  const schemaKeys = ['format', 'partitionKey', 'version'];
  const unresolvedKeys = ['byteSize', 'rowCount', 'sha256'];
  if (!isPlainObject(metadata) || Object.keys(metadata).sort().join(',') !== rootKeys.sort().join(',')
    || metadata.schemaVersion !== 1
    || !isPlainObject(metadata.schema) || metadata.schema.version !== 1
    || Object.keys(metadata.schema).sort().join(',') !== schemaKeys.sort().join(',')
    || metadata.schema.format !== 'partitioned-parquet' || metadata.schema.partitionKey !== 'sourceCountryCode'
    || metadata.release !== parsed.release || typeof metadata.duckdbVersion !== 'string' || metadata.duckdbVersion.length < 1
    || typeof metadata.sourceSnapshotSha256 !== 'string' || !SHA256_PATTERN.test(metadata.sourceSnapshotSha256)
    || !Number.isSafeInteger(metadata.totalRowCount) || metadata.totalRowCount < 1 || !isPlainObject(metadata.rowCounts)
    || !isPlainObject(metadata.unresolved)
    || Object.keys(metadata.unresolved).sort().join(',') !== unresolvedKeys.sort().join(',')
    || !Number.isSafeInteger(metadata.unresolved.rowCount) || metadata.unresolved.rowCount < 0
    || !Number.isSafeInteger(metadata.unresolved.byteSize) || metadata.unresolved.byteSize < 1
    || typeof metadata.unresolved.sha256 !== 'string' || !SHA256_PATTERN.test(metadata.unresolved.sha256)) {
    throw new ProfileError('SNAPSHOT_INVALID', 'snapshot');
  }
  let sum = 0;
  for (const [code, count] of Object.entries(metadata.rowCounts)) {
    if (!COUNTRY_PATTERN.test(code) || !Number.isSafeInteger(count) || count < 1) {
      throw new ProfileError('SNAPSHOT_INVALID', 'snapshot');
    }
    sum += count;
    if (!Number.isSafeInteger(sum)) throw new ProfileError('SNAPSHOT_INVALID', 'snapshot');
  }
  if (sum !== metadata.totalRowCount) throw new ProfileError('SNAPSHOT_INVALID', 'snapshot');
}

function renderSql(parquetPaths) {
  const files = parquetPaths.map((filePath) => `'${filePath.replaceAll("'", "''")}'`).join(', ');
  return `SET memory_limit = '256MB';\nSET threads = 1;\nSET preserve_insertion_order = false;\nSELECT\n  sourceCountryCode,\n  subtype,\n  adminLevel,\n  localType,\n  count(*)::BIGINT AS count,\n  count(*) FILTER (WHERE names.primary IS NOT NULL AND length(trim(names.primary)) > 0)::BIGINT AS namedCount\nFROM read_parquet([${files}], hive_partitioning = true)\nGROUP BY sourceCountryCode, subtype, adminLevel, localType\nORDER BY sourceCountryCode, subtype NULLS FIRST, adminLevel NULLS FIRST, localType NULLS FIRST;\n`;
}

function validateRows(rows, expectedCodes) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_COMBINATIONS) throw new Error('invalid profile rows');
  const seen = new Set();
  const actualCodes = new Set();
  for (const row of rows) {
    if (!isPlainObject(row) || Object.keys(row).sort().join(',') !== 'adminLevel,count,localType,namedCount,sourceCountryCode,subtype'
      || !expectedCodes.has(row.sourceCountryCode)
      || !(row.subtype === null || typeof row.subtype === 'string')
      || !(row.adminLevel === null || Number.isSafeInteger(row.adminLevel))
      || !(row.localType === null || typeof row.localType === 'string')
      || !Number.isSafeInteger(row.count) || row.count < 1
      || !Number.isSafeInteger(row.namedCount) || row.namedCount < 0 || row.namedCount > row.count) {
      throw new Error('invalid profile row');
    }
    const identity = JSON.stringify([row.sourceCountryCode, row.subtype, row.adminLevel, row.localType]);
    if (seen.has(identity)) throw new Error('duplicate profile row');
    seen.add(identity);
    actualCodes.add(row.sourceCountryCode);
  }
  if (actualCodes.size !== expectedCodes.size || [...expectedCodes].some((code) => !actualCodes.has(code))) {
    throw new Error('partial source profile');
  }
}

function normalizeRow(row) {
  return {
    sourceCountryCode: row.sourceCountryCode,
    subtype: row.subtype,
    adminLevel: row.adminLevel,
    localType: row.localType,
    count: row.count,
    namedCount: row.namedCount,
  };
}

function compareNullable(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'en');
}

function compareCombination(left, right) {
  return left.sourceCountryCode.localeCompare(right.sourceCountryCode, 'en')
    || compareNullable(left.subtype, right.subtype)
    || compareNullable(left.adminLevel, right.adminLevel)
    || compareNullable(left.localType, right.localType);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function failed(code, subject, parsed = {}) {
  return {
    exitCode: 1,
    result: {
      status: 'failed',
      ...(parsed.country ? { countryCode: parsed.country } : {}),
      ...(parsed.release ? { release: parsed.release } : {}),
      failures: [{ code, subject }],
    },
  };
}

class ProfileError extends Error {
  constructor(code, subject) {
    super(code);
    this.code = code;
    this.subject = subject;
  }
}

async function main() {
  const { exitCode, result } = await profileCountry(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
