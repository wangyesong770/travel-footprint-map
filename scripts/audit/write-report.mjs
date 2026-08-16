import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const COUNTRY_KEYS = new Set([
  'schemaVersion', 'countryCode', 'status', 'sourceRelease', 'selectorVersion', 'productLevel',
  'sourceCountryCodes', 'counts', 'geometry', 'vertices', 'compressedBytes', 'performanceMs',
  'exceptions', 'references', 'generatorCommit', 'auditedOn', 'attribution',
]);
const COUNT_KEYS = new Set(['source', 'selected', 'excluded', 'allowlisted', 'denylisted']);
const GEOMETRY_KEYS = new Set(['invalid', 'duplicate', 'overlap', 'missingName']);
const VERTEX_KEYS = new Set(['p50', 'p95', 'max']);
const COMPRESSED_KEYS = new Set(['topojson', 'gzip', 'brotli']);
const PERFORMANCE_KEYS = new Set(['extract', 'select', 'audit', 'build', 'parse']);
const REFERENCE_KEYS = new Set(['title', 'url', 'retrievedOn', 'license']);
const REPORT_KEYS = new Set([...COUNTRY_KEYS, 'packageByteSize', 'packageChecksum']);
const SECRET_KEY = /(?:api.?key|authorization|cookie|credential|password|private.?key|secret|token)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/i;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/;

export async function writeCountryAuditReport({
  packagePath,
  reportPath,
  manifestEntry,
  evidence,
  expectedSelectorVersion,
}) {
  if (typeof packagePath !== 'string' || typeof reportPath !== 'string') throw new Error('packagePath and reportPath are required');
  scanUnsafeEvidence(evidence);
  const packageBinding = await readPackageBinding(packagePath);
  assertManifestBinding(manifestEntry, packageBinding);
  const report = normalizeCountryEvidence(evidence, expectedSelectorVersion, packageBinding);
  assertManifestEvidence(manifestEntry, report);
  await atomicWrite(reportPath, `${canonicalJson(report)}\n`);
  return report;
}

export async function verifyCountryReportBinding({ packagePath, reportPath, manifestEntry }) {
  const packageBinding = await readPackageBinding(packagePath);
  assertManifestBinding(manifestEntry, packageBinding);
  const raw = await readFile(reportPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid country report JSON');
  }
  scanUnsafeEvidence(parsed);
  const normalized = validateStoredReport(parsed);
  if (raw !== `${canonicalJson(parsed)}\n`) throw new Error('country report is not canonical');
  if (parsed.packageChecksum !== packageBinding.checksum) throw new Error('report checksum mismatch');
  if (parsed.packageByteSize !== packageBinding.byteSize) throw new Error('report byte size mismatch');
  assertManifestEvidence(manifestEntry, normalized);
  return normalized;
}

export async function writeAuditSummary({ reportPaths, outputPath, sourceRelease, generatorCommit }) {
  if (!Array.isArray(reportPaths) || reportPaths.length === 0) throw new Error('reportPaths must not be empty');
  requireRelease(sourceRelease);
  requireCommit(generatorCommit);
  const countries = [];
  const seen = new Set();
  for (const reportPath of reportPaths) {
    const raw = await readFile(reportPath, 'utf8');
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      throw new Error('invalid country report JSON');
    }
    scanUnsafeEvidence(report);
    report = validateStoredReport(report);
    if (raw !== `${canonicalJson(report)}\n`) throw new Error('country report is not canonical');
    if (report.sourceRelease !== sourceRelease) throw new Error('country report release mismatch');
    if (report.generatorCommit !== generatorCommit) throw new Error('country report generator commit mismatch');
    requireCountryCode(report.countryCode);
    if (seen.has(report.countryCode)) throw new Error('duplicate country report');
    seen.add(report.countryCode);
    countries.push({
      countryCode: report.countryCode,
      packageByteSize: requireNonNegativeInteger(report.packageByteSize, 'packageByteSize'),
      packageChecksum: requireChecksum(report.packageChecksum, 'packageChecksum'),
      selectorVersion: requirePositiveInteger(report.selectorVersion, 'selectorVersion'),
      status: 'verified',
    });
  }
  countries.sort((left, right) => left.countryCode.localeCompare(right.countryCode, 'en'));
  const summary = { schemaVersion: 1, sourceRelease, generatorCommit, countries };
  await atomicWrite(outputPath, `${canonicalJson(summary)}\n`);
  return summary;
}

function normalizeCountryEvidence(input, expectedSelectorVersion, packageBinding) {
  if (!isPlainObject(input)) throw new Error('evidence must be an object');
  assertExactKeys(input, COUNTRY_KEYS, 'report');
  if (input.schemaVersion !== 1) throw new Error('invalid report schemaVersion');
  requireCountryCode(input.countryCode);
  if (input.status !== 'verified') throw new Error('report status must be verified');
  requireRelease(input.sourceRelease);
  const selectorVersion = requirePositiveInteger(input.selectorVersion, 'selectorVersion');
  if (selectorVersion !== expectedSelectorVersion) throw new Error('selector version mismatch');
  const sourceCountryCodes = requireUniqueStrings(input.sourceCountryCodes, 'sourceCountryCodes', requireCountryCode)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!sourceCountryCodes.includes(input.countryCode)) throw new Error('sourceCountryCodes must include countryCode');
  const references = requireReferences(input.references);
  const compressedBytes = normalizeIntegerObject(input.compressedBytes, COMPRESSED_KEYS, 'compressedBytes');
  compressedBytes.topojson = packageBinding.byteSize;
  return {
    schemaVersion: 1,
    countryCode: input.countryCode,
    status: 'verified',
    sourceRelease: input.sourceRelease,
    selectorVersion,
    productLevel: requireText(input.productLevel, 'productLevel'),
    sourceCountryCodes,
    counts: normalizeIntegerObject(input.counts, COUNT_KEYS, 'counts'),
    geometry: normalizeIntegerObject(input.geometry, GEOMETRY_KEYS, 'geometry'),
    vertices: normalizeIntegerObject(input.vertices, VERTEX_KEYS, 'vertices'),
    compressedBytes,
    performanceMs: normalizeNumberObject(input.performanceMs, PERFORMANCE_KEYS, 'performanceMs'),
    exceptions: requireUniqueStrings(input.exceptions, 'exceptions', (value) => requireSafeId(value, 'exception'))
      .sort((left, right) => left.localeCompare(right, 'en')),
    references,
    generatorCommit: requireCommit(input.generatorCommit),
    auditedOn: requireDate(input.auditedOn, 'auditedOn'),
    attribution: requireText(input.attribution, 'attribution'),
    packageByteSize: packageBinding.byteSize,
    packageChecksum: packageBinding.checksum,
  };
}

async function readPackageBinding(packagePath) {
  const bytes = await readFile(packagePath);
  if (bytes.byteLength === 0) throw new Error('final package is empty');
  return {
    byteSize: bytes.byteLength,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  };
}

function assertManifestBinding(manifestEntry, packageBinding) {
  if (!isPlainObject(manifestEntry)) throw new Error('manifest entry is required');
  if (manifestEntry.byteSize !== packageBinding.byteSize) throw new Error('manifest byte size mismatch');
  if (manifestEntry.checksum !== packageBinding.checksum) throw new Error('manifest checksum mismatch');
}

function assertManifestEvidence(manifestEntry, report) {
  if (manifestEntry.countryCode !== report.countryCode) throw new Error('manifest country mismatch');
  if (manifestEntry.boundaryVersion !== report.sourceRelease) throw new Error('manifest release mismatch');
  if (manifestEntry.attribution !== report.attribution) throw new Error('manifest attribution mismatch');
}

function validateStoredReport(input) {
  assertExactKeys(input, REPORT_KEYS, 'report');
  const evidence = Object.fromEntries([...COUNTRY_KEYS].map((key) => [key, input[key]]));
  const packageBinding = {
    byteSize: requireNonNegativeInteger(input.packageByteSize, 'packageByteSize'),
    checksum: requireChecksum(input.packageChecksum, 'packageChecksum'),
  };
  const normalized = normalizeCountryEvidence(evidence, input.selectorVersion, packageBinding);
  if (canonicalJson(normalized) !== canonicalJson(input)) throw new Error('stored country report is not normalized');
  return normalized;
}

function requireReferences(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('references must not be empty');
  return input.map((reference) => {
    if (!isPlainObject(reference)) throw new Error('reference must be an object');
    assertExactKeys(reference, REFERENCE_KEYS, 'reference');
    const url = requireHttpsReferenceUrl(reference.url);
    return {
      title: requireText(reference.title, 'reference title'),
      url,
      retrievedOn: requireDate(reference.retrievedOn, 'reference retrievedOn'),
      license: requireText(reference.license, 'reference license'),
    };
  }).sort((left, right) => left.url.localeCompare(right.url, 'en') || left.title.localeCompare(right.title, 'en'));
}

function requireHttpsReferenceUrl(value) {
  const url = requireText(value, 'reference url');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('reference url must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    throw new Error('reference url must use HTTPS');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0
    || [...parsed.searchParams.keys()].some((key) => SECRET_KEY.test(key))
    || SECRET_KEY.test(parsed.hash)) {
    throw new Error('reference url must not contain credentials or secret parameters');
  }
  return url;
}

function normalizeIntegerObject(input, keys, label) {
  if (!isPlainObject(input)) throw new Error(`${label} must be an object`);
  assertExactKeys(input, keys, label);
  return Object.fromEntries([...keys].map((key) => [key, requireNonNegativeInteger(input[key], `${label}.${key}`)]));
}

function normalizeNumberObject(input, keys, label) {
  if (!isPlainObject(input)) throw new Error(`${label} must be an object`);
  assertExactKeys(input, keys, label);
  return Object.fromEntries([...keys].map((key) => [key, requireNonNegativeNumber(input[key], `${label}.${key}`)]));
}

function requireUniqueStrings(input, label, validator) {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  const result = input.map((value) => validator(value));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function requireCountryCode(value) {
  if (typeof value !== 'string' || !COUNTRY_CODE.test(value)) throw new Error('invalid country code');
  return value;
}

function requireRelease(value) {
  if (typeof value !== 'string' || !RELEASE.test(value)) throw new Error('invalid source release');
  return value;
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT.test(value)) throw new Error('invalid generator commit');
  return value;
}

function requireChecksum(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function requireDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || !isRealCalendarDate(value)) {
    throw new Error(`${label} must be a date-only value`);
  }
  return value;
}

function isRealCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000 || hasControlCharacter(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

function requireSafeId(value, label) {
  requireText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label}`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function assertExactKeys(input, allowed, label) {
  if (!isPlainObject(input)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown ${label} key: ${unknown.sort()[0]}`);
  const missing = [...allowed].filter((key) => !(key in input));
  if (missing.length > 0) throw new Error(`${label} ${missing[0]} is required`);
}

function scanUnsafeEvidence(value, seen = new Set()) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP.test(value)) throw new Error('timestamp nondeterminism is forbidden; use date-only fields');
    if (isAbsoluteHostPath(value)) throw new Error('absolute host path is forbidden');
    return;
  }
  if (typeof value !== 'object' || value instanceof Date) throw new Error('unsupported report value');
  if (seen.has(value)) throw new Error('cyclic report value');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) scanUnsafeEvidence(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new Error(`secret-looking key is forbidden: ${key}`);
      scanUnsafeEvidence(item, seen);
    }
  }
  seen.delete(value);
}

function isAbsoluteHostPath(value) {
  return value.startsWith('file://')
    || value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

async function atomicWrite(outputPath, contents) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('output path is required');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('cannot serialize undefined');
  return serialized;
}
