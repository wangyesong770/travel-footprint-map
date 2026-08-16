import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/u;
const COUNTRY = /^[A-Z]{2}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const COUNT_REVIEW_THRESHOLD = 2;
const MIGRATION_TYPES = new Set(['one-to-one', 'one-to-many', 'many-to-one']);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('cannot serialize undefined');
  return serialized;
}

async function readJson(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_METADATA_BYTES) throw new Error(`invalid metadata size: ${path.basename(filePath)}`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`invalid JSON: ${path.basename(filePath)}`);
  }
}

function validSourceObject(value) {
  return isRecord(value)
    && typeof value.key === 'string'
    && value.key.length > 0
    && Number.isSafeInteger(value.byteSize)
    && value.byteSize > 0
    && typeof value.etag === 'string'
    && value.etag.length > 0
    && typeof value.url === 'string'
    && value.url.startsWith('https://')
    && typeof value.sha256 === 'string'
    && SHA256.test(value.sha256);
}

function validateSourceManifest(manifest, expectedRelease, reasons) {
  if (!isRecord(manifest) || manifest.release !== expectedRelease) {
    reasons.add('GLOBAL:SOURCE_MANIFEST_RELEASE_MISMATCH');
    return;
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.objects) || manifest.objects.length === 0
    || manifest.objects.some((object) => !validSourceObject(object))) {
    reasons.add('GLOBAL:SOURCE_MANIFEST_INCOMPLETE');
    return;
  }
  const keys = manifest.objects.map(({ key }) => key);
  if (new Set(keys).size !== keys.length
    || !keys.some((key) => key.includes('type=division/'))
    || !keys.some((key) => key.includes('type=division_area/'))) {
    reasons.add('GLOBAL:SOURCE_MANIFEST_INCOMPLETE');
  }
}

function validateMetadata(metadata, release, reasons) {
  if (!isRecord(metadata) || metadata.release !== release || typeof metadata.schemaVersion !== 'string' || !isRecord(metadata.countries)) {
    reasons.add('GLOBAL:RELEASE_METADATA_INVALID');
    return new Map();
  }
  const result = new Map();
  for (const [countryCode, country] of Object.entries(metadata.countries).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    if (!COUNTRY.test(countryCode) || !isRecord(country) || !Number.isSafeInteger(country.selectedCount) || country.selectedCount < 0
      || typeof country.selectorSignature !== 'string' || country.selectorSignature.length === 0
      || typeof country.perspective !== 'string' || country.perspective.length === 0) {
      reasons.add(`${COUNTRY.test(countryCode) ? countryCode : 'GLOBAL'}:RELEASE_METADATA_INVALID`);
      continue;
    }
    result.set(countryCode, country);
  }
  return result;
}

async function readCountryIdentityStream(filePath, countryCode, reasons) {
  const identities = new Map();
  try {
    const lines = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        reasons.add(`${countryCode}:IDENTITY_STREAM_INVALID`);
        continue;
      }
      if (!isRecord(record) || typeof record.divisionId !== 'string' || record.divisionId.length === 0
        || typeof record.geometryHash !== 'string' || record.geometryHash.length === 0 || identities.has(record.divisionId)) {
        reasons.add(`${countryCode}:IDENTITY_STREAM_INVALID`);
        continue;
      }
      identities.set(record.divisionId, record.geometryHash);
    }
  } catch {
    reasons.add(`${countryCode}:IDENTITY_STREAM_MISSING`);
  }
  return identities;
}

function requireIdArray(value, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength || value.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(value).size !== value.length) throw new Error(label);
  return value;
}

function validateMigrations(input, fromRelease, toRelease, baselineIds, candidateIds, reasons) {
  const counts = { oneToOne: 0, oneToMany: 0, manyToOne: 0 };
  const consumedSources = new Set();
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.migrations)) {
    reasons.add('GLOBAL:MIGRATIONS_INVALID');
    return counts;
  }
  for (const migration of input.migrations) {
    let code = 'GLOBAL';
    try {
      if (!isRecord(migration) || typeof migration.fromRelease !== 'string' || !RELEASE.test(migration.fromRelease)
        || typeof migration.toRelease !== 'string' || !RELEASE.test(migration.toRelease)
        || typeof migration.sovereignCode !== 'string' || !COUNTRY.test(migration.sovereignCode)
        || !MIGRATION_TYPES.has(migration.type)) throw new Error('invalid migration');
      code = migration.sovereignCode;
      if (migration.fromRelease !== fromRelease || migration.toRelease !== toRelease) continue;
      const sources = baselineIds.get(code) ?? new Map();
      const targets = candidateIds.get(code) ?? new Map();
      if (migration.type === 'one-to-one') {
        requireIdArray(migration.fromIds, 1, 'invalid source');
        requireIdArray(migration.toIds, 1, 'invalid target');
        counts.oneToOne += 1;
      } else if (migration.type === 'one-to-many') {
        requireIdArray(migration.fromIds, 1, 'invalid source');
        if (!Array.isArray(migration.toIds) || migration.toIds.length < 2 || new Set(migration.toIds).size !== migration.toIds.length) throw new Error('invalid target');
        if (migration.userConfirmationRequired !== true) reasons.add(`${code}:MIGRATION_SPLIT_CONFIRMATION_REQUIRED`);
        if (Object.hasOwn(migration, 'automaticTarget')) reasons.add(`${code}:MIGRATION_SPLIT_AUTOMATIC_TARGET_FORBIDDEN`);
        counts.oneToMany += 1;
      } else {
        if (!Array.isArray(migration.fromIds) || migration.fromIds.length < 2 || new Set(migration.fromIds).size !== migration.fromIds.length) throw new Error('invalid source');
        requireIdArray(migration.toIds, 1, 'invalid target');
        counts.manyToOne += 1;
      }
      for (const id of migration.fromIds) {
        const sourceKey = `${code}:${id}`;
        if (consumedSources.has(sourceKey)) reasons.add(`${code}:MIGRATION_SOURCE_CONFLICT`);
        consumedSources.add(sourceKey);
      }
      if (migration.fromIds.some((id) => typeof id !== 'string' || !sources.has(id))) reasons.add(`${code}:MIGRATION_SOURCE_MISSING`);
      if (migration.toIds.some((id) => typeof id !== 'string' || !targets.has(id))) reasons.add(`${code}:MIGRATION_TARGET_MISSING`);
    } catch {
      reasons.add(`${code}:MIGRATION_INVALID`);
    }
  }
  return counts;
}

function percentDelta(from, to) {
  if (from === 0) return to === 0 ? 0 : 100;
  return Number((Math.abs(to - from) / from * 100).toFixed(6));
}

function finalState(reasons) {
  const manualReviewReason = /:(?:ID_DELETED|COUNT_DELTA_ABOVE_THRESHOLD|SELECTOR_CHANGED|PERSPECTIVE_CHANGED)$/u;
  const blocking = [...reasons].some((reason) => !manualReviewReason.test(reason));
  if (blocking) return 'blocked';
  return reasons.size > 0 ? 'manual-review-required' : 'no-review-required';
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function compareReleases(options) {
  if (isRecord(options) && Object.hasOwn(options, 'outputPath')) throw new Error('outputPath is forbidden; provide changeReportsDir');
  // This directory is an internal composition/test capability. The CLI intentionally never exposes it.
  const { fromRelease, toRelease, fromDir, toDir, fromManifestPath, toManifestPath, migrationsPath, changeReportsDir } = options ?? {};
  if (![fromRelease, toRelease].every((release) => typeof release === 'string' && RELEASE.test(release)) || fromRelease === toRelease) {
    throw new Error('two distinct valid releases are required');
  }
  if (![fromDir, toDir, fromManifestPath, toManifestPath, migrationsPath, changeReportsDir].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('comparison paths are required');
  }
  const outputPath = path.join(changeReportsDir, `${fromRelease}--${toRelease}.json`);
  const reasons = new Set();
  const [fromMetadata, toMetadata, fromManifest, toManifest, migrationFile] = await Promise.all([
    readJson(path.join(fromDir, 'release.json')), readJson(path.join(toDir, 'release.json')),
    readJson(fromManifestPath), readJson(toManifestPath), readJson(migrationsPath),
  ]);
  validateSourceManifest(fromManifest, fromRelease, reasons);
  validateSourceManifest(toManifest, toRelease, reasons);
  const fromCountries = validateMetadata(fromMetadata, fromRelease, reasons);
  const toCountries = validateMetadata(toMetadata, toRelease, reasons);
  if (fromMetadata.schemaVersion !== toMetadata.schemaVersion) reasons.add('GLOBAL:SCHEMA_VERSION_CHANGED');
  const countryCodes = [...new Set([...fromCountries.keys(), ...toCountries.keys()])].sort((left, right) => left.localeCompare(right, 'en'));
  if (fromCountries.size !== toCountries.size || countryCodes.some((code) => !fromCountries.has(code) || !toCountries.has(code))) {
    reasons.add('GLOBAL:COUNTRY_SET_CHANGED');
  }
  const countries = {};
  const baselineIds = new Map();
  const candidateIds = new Map();
  for (const code of countryCodes) {
    const from = fromCountries.get(code);
    const to = toCountries.get(code);
    if (!from || !to) continue;
    const [oldIds, newIds] = await Promise.all([
      readCountryIdentityStream(path.join(fromDir, 'countries', `${code}.jsonl`), code, reasons),
      readCountryIdentityStream(path.join(toDir, 'countries', `${code}.jsonl`), code, reasons),
    ]);
    baselineIds.set(code, oldIds);
    candidateIds.set(code, newIds);
    if (oldIds.size !== from.selectedCount || newIds.size !== to.selectedCount) reasons.add(`${code}:SELECTED_COUNT_MISMATCH`);
    const added = [...newIds.keys()].filter((id) => !oldIds.has(id)).sort();
    const deleted = [...oldIds.keys()].filter((id) => !newIds.has(id)).sort();
    const geometryChanged = [...oldIds.keys()].filter((id) => newIds.has(id) && oldIds.get(id) !== newIds.get(id)).sort();
    const countDeltaPercent = percentDelta(from.selectedCount, to.selectedCount);
    if (deleted.length > 0) reasons.add(`${code}:ID_DELETED`);
    if (countDeltaPercent > COUNT_REVIEW_THRESHOLD) reasons.add(`${code}:COUNT_DELTA_ABOVE_THRESHOLD`);
    if (from.selectorSignature !== to.selectorSignature) reasons.add(`${code}:SELECTOR_CHANGED`);
    if (from.perspective !== to.perspective) reasons.add(`${code}:PERSPECTIVE_CHANGED`);
    countries[code] = { added, countDeltaPercent, deleted, geometryChanged };
  }
  const migrations = validateMigrations(migrationFile, fromRelease, toRelease, baselineIds, candidateIds, reasons);
  const sortedReasons = [...reasons].sort((left, right) => left.localeCompare(right, 'en'));
  const report = {
    schemaVersion: 1,
    fromRelease,
    toRelease,
    state: finalState(reasons),
    reasons: sortedReasons,
    migrations,
    countries,
  };
  await atomicWrite(outputPath, `${canonicalJson(report)}\n`);
  return report;
}

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(['from', 'to', 'from-dir', 'to-dir', 'from-manifest', 'to-manifest', 'migrations']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('arguments must be --key value pairs');
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`unsupported argument: --${name}`);
    result[name] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromRelease = args.from;
  const toRelease = args.to;
  const report = await compareReleases({
    fromRelease,
    toRelease,
    fromDir: args['from-dir'] ?? path.join('data-audit', 'release-inputs', fromRelease),
    toDir: args['to-dir'] ?? path.join('data-audit', 'release-inputs', toRelease),
    fromManifestPath: args['from-manifest'] ?? path.join('data-audit', 'source-snapshots', `${fromRelease}.json`),
    toManifestPath: args['to-manifest'] ?? path.join('data-audit', 'source-snapshots', `${toRelease}.json`),
    migrationsPath: args.migrations ?? path.join('data-audit', 'migrations', 'division-id-migrations.json'),
    changeReportsDir: path.join('data-audit', 'change-reports'),
  });
  process.stdout.write(`${report.state}\n`);
  if (report.state === 'blocked') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
