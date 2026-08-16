import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

const COUNTRY_CODE = /^[A-Z]{2}$/u;
const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const DEFAULT_LIMITS = Object.freeze({
  packageWarningBytes: 5 * 1024 * 1024,
  packageHardBytes: 20 * 1024 * 1024,
  indexHardBytes: 64 * 1024 * 1024,
});
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function issueKey(issue) {
  return `${issue.countryCode}:${issue.code}`;
}

function normalizeIssues(issues) {
  return [...new Map(issues.map((issue) => [issueKey(issue), issue])).values()]
    .sort((left, right) => issueKey(left).localeCompare(issueKey(right), 'en'))
    .map(Object.freeze);
}

function add(issues, countryCode, code) {
  issues.push({ countryCode, code });
}

function normalizeLimits(input = {}) {
  if (!isRecord(input)) throw new TypeError('limits must be an object');
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`invalid ${key}`);
  }
  if (limits.packageWarningBytes >= limits.packageHardBytes) {
    throw new TypeError('package warning limit must be below hard limit');
  }
  return Object.freeze(limits);
}

async function readBoundedRegularFile(filePath, maximumBytes) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error('unsafe input');
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== metadata.size) throw new Error('input changed while reading');
  return bytes;
}

async function isSafeDirectory(directoryPath) {
  try {
    const metadata = await lstat(directoryPath);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('invalid JSON');
  }
}

async function readMetadataJson(filePath, maximumBytes, missingCode, unsafeCode, failures) {
  try {
    return parseJson(await readBoundedRegularFile(filePath, maximumBytes));
  } catch (error) {
    const code = isRecord(error) && error.code === 'ENOENT' ? missingCode : unsafeCode;
    add(failures, 'GLOBAL', code);
    return null;
  }
}

function readRegistry(input, release, failures) {
  if (!isRecord(input) || input.release !== release || !Array.isArray(input.countries)) {
    add(failures, 'GLOBAL', 'REGISTRY_INVALID');
    return [];
  }
  const countries = [];
  const sovereignCodes = new Set();
  const sourceOwners = new Map();
  for (const entry of input.countries) {
    if (!isRecord(entry) || typeof entry.sovereignCode !== 'string'
      || !COUNTRY_CODE.test(entry.sovereignCode) || !Array.isArray(entry.sourceCountryCodes)
      || entry.sourceCountryCodes.length === 0) {
      add(failures, 'GLOBAL', 'REGISTRY_INVALID');
      continue;
    }
    const countryCode = entry.sovereignCode;
    if (sovereignCodes.has(countryCode)) add(failures, countryCode, 'SOVEREIGN_OWNER_DUPLICATE');
    sovereignCodes.add(countryCode);
    for (const sourceCode of entry.sourceCountryCodes) {
      if (typeof sourceCode !== 'string' || !COUNTRY_CODE.test(sourceCode)) {
        add(failures, countryCode, 'SOURCE_OWNER_INVALID');
        continue;
      }
      const existingOwner = sourceOwners.get(sourceCode);
      if (existingOwner !== undefined && existingOwner !== countryCode) {
        add(failures, 'GLOBAL', 'SOURCE_OWNER_DUPLICATE');
      } else sourceOwners.set(sourceCode, countryCode);
    }
    countries.push(countryCode);
  }
  return [...new Set(countries)].sort((left, right) => left.localeCompare(right, 'en'));
}

function readManifest(input, release, expectedCountries, failures) {
  if (!isRecord(input)) {
    add(failures, 'GLOBAL', 'MANIFEST_INVALID');
    return new Map();
  }
  const manifest = new Map();
  for (const [key, entry] of Object.entries(input)) {
    if (!COUNTRY_CODE.test(key) || !isRecord(entry) || entry.countryCode !== key
      || !Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0
      || !Number.isSafeInteger(entry.featureCount) || entry.featureCount < 0
      || typeof entry.checksum !== 'string' || !CHECKSUM.test(entry.checksum)) {
      add(failures, COUNTRY_CODE.test(key) ? key : 'GLOBAL', 'MANIFEST_INVALID');
      continue;
    }
    if (entry.boundaryVersion !== release) add(failures, key, 'PACKAGE_RELEASE_MISMATCH');
    manifest.set(key, entry);
  }
  for (const code of expectedCountries) if (!manifest.has(code)) add(failures, code, 'MANIFEST_COUNTRY_MISSING');
  for (const code of manifest.keys()) if (!expectedCountries.includes(code)) add(failures, code, 'MANIFEST_COUNTRY_EXTRA');
  return manifest;
}

function readIndex(input, release, failures) {
  if (!Array.isArray(input)) {
    add(failures, 'GLOBAL', 'GLOBAL_INDEX_INVALID');
    return null;
  }
  const records = new Map();
  const countries = new Set();
  let areaCount = 0;
  for (const record of input) {
    if (!isRecord(record) || !COUNTRY_CODE.test(record.countryCode ?? '')
      || typeof record.boundaryVersion !== 'string' || typeof record.nameLocal !== 'string'
      || !Array.isArray(record.aliases)) {
      add(failures, 'GLOBAL', 'GLOBAL_INDEX_INVALID');
      continue;
    }
    if (record.boundaryVersion !== release) add(failures, record.countryCode, 'INDEX_RELEASE_MISMATCH');
    if (record.kind === 'country') {
      if (countries.has(record.countryCode)) add(failures, record.countryCode, 'INDEX_COUNTRY_DUPLICATE');
      countries.add(record.countryCode);
      continue;
    }
    if (record.kind !== 'area' || typeof record.areaId !== 'string'
      || typeof record.adminLevel !== 'string' || (record.nameZh !== undefined && typeof record.nameZh !== 'string')) {
      add(failures, record.countryCode, 'GLOBAL_INDEX_INVALID');
      continue;
    }
    areaCount += 1;
    if (records.has(record.areaId)) add(failures, record.countryCode, 'INDEX_ID_DUPLICATE');
    else records.set(record.areaId, record);
  }
  return { records, countries, areaCount };
}

function sameNames(properties, indexRecord) {
  return properties.nameLocal === indexRecord.nameLocal
    && properties.nameZh === indexRecord.nameZh
    && properties.adminLevel === indexRecord.adminLevel
    && JSON.stringify(properties.aliases) === JSON.stringify(indexRecord.aliases);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

async function loadRuntimeValidator() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule('/src/areas/package-validator.ts');
    if (typeof module.parseCountryPackage !== 'function') throw new Error('validator unavailable');
    return {
      validate: (bytes, entry) => module.parseCountryPackage(bytes, entry),
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/**
 * Audits immutable country artifacts without publishing them. Geometry is held
 * for one package only; cross-country state contains identities and metrics.
 */
export async function verifyCrossCountry(options) {
  if (!isRecord(options) || typeof options.packagesDir !== 'string'
    || typeof options.registryPath !== 'string' || typeof options.release !== 'string'
    || !RELEASE.test(options.release)) throw new TypeError('invalid cross-country audit options');
  const limits = normalizeLimits(options.limits);
  const failures = [];
  const warnings = [];
  const packagesDir = path.resolve(options.packagesDir);
  const registryPath = path.resolve(options.registryPath);
  const packageDirectorySafe = await isSafeDirectory(packagesDir);
  if (!packageDirectorySafe) add(failures, 'GLOBAL', 'PACKAGE_DIRECTORY_INPUT_UNSAFE');
  const [registryInput, manifestInput] = await Promise.all([
    readMetadataJson(registryPath, MAX_REGISTRY_BYTES, 'REGISTRY_MISSING', 'REGISTRY_INPUT_UNSAFE', failures),
    packageDirectorySafe
      ? readMetadataJson(path.join(packagesDir, 'manifest.json'), MAX_MANIFEST_BYTES,
        'MANIFEST_MISSING', 'MANIFEST_INPUT_UNSAFE', failures)
      : Promise.resolve(null),
  ]);
  const countries = registryInput === null ? [] : readRegistry(registryInput, options.release, failures);
  const manifest = manifestInput === null
    ? new Map()
    : readManifest(manifestInput, options.release, countries, failures);

  let index = null;
  let indexBytes = 0;
  try {
    if (!packageDirectorySafe) throw new Error('unsafe package directory');
    const indexPath = path.join(packagesDir, 'area-index.json');
    const metadata = await lstat(indexPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error('unsafe index');
    indexBytes = metadata.size;
    if (metadata.size > limits.indexHardBytes) add(failures, 'GLOBAL', 'GLOBAL_INDEX_SIZE_HARD_LIMIT');
    else {
      const bytes = await readFile(indexPath);
      if (bytes.byteLength !== metadata.size) throw new Error('index changed while reading');
      index = readIndex(parseJson(bytes), options.release, failures);
    }
  } catch (error) {
    if (packageDirectorySafe && !failures.some(({ code }) => code === 'GLOBAL_INDEX_SIZE_HARD_LIMIT')) {
      add(failures, 'GLOBAL', isRecord(error) && error.code === 'ENOENT'
        ? 'GLOBAL_INDEX_MISSING' : 'GLOBAL_INDEX_INPUT_UNSAFE');
    }
  }

  const packageSizes = [];
  const countryMetrics = [];
  const divisionIds = new Set();
  let featureCount = 0;
  let peakPackageBytes = 0;
  let runtime;
  const validatePackage = options.validatePackage ?? ((...args) => runtime.validate(...args));
  const canProcess = index !== null && manifestInput !== null && registryInput !== null;
  if (!options.validatePackage && canProcess && countries.length > 0) {
    try { runtime = await loadRuntimeValidator(); }
    catch { add(failures, 'GLOBAL', 'RUNTIME_VALIDATOR_UNAVAILABLE'); }
  }

  try {
    if (canProcess) {
      for (const countryCode of countries) {
        const entry = manifest.get(countryCode);
        if (entry === undefined) continue;
        const packagePath = path.join(packagesDir, `${countryCode}.topojson`);
        let bytes;
        try {
          const metadata = await lstat(packagePath);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error('unsafe package');
          peakPackageBytes = Math.max(peakPackageBytes, metadata.size);
          packageSizes.push(metadata.size);
          if (metadata.size > limits.packageHardBytes) {
            add(failures, countryCode, 'PACKAGE_SIZE_HARD_LIMIT');
            continue;
          }
          if (metadata.size > limits.packageWarningBytes) add(warnings, countryCode, 'PACKAGE_SIZE_WARNING');
          bytes = await readFile(packagePath);
          if (bytes.byteLength !== metadata.size) throw new Error('package changed while reading');
        } catch (error) {
          add(failures, countryCode, isRecord(error) && error.code === 'ENOENT'
            ? 'PACKAGE_MISSING' : 'PACKAGE_INPUT_UNSAFE');
          continue;
        }
        if (bytes.byteLength !== entry.byteSize) {
          add(failures, countryCode, 'PACKAGE_SIZE_MISMATCH');
          continue;
        }
        if (createHash('sha256').update(bytes).digest('hex') !== entry.checksum) {
          add(failures, countryCode, 'PACKAGE_CHECKSUM_MISMATCH');
          continue;
        }
        let parsed;
        try { parsed = await validatePackage(bytes, entry); }
        catch { add(failures, countryCode, 'PACKAGE_RUNTIME_INVALID'); continue; }
        if (!isRecord(parsed) || parsed.countryCode !== countryCode) {
          add(failures, countryCode, 'PACKAGE_COUNTRY_MISMATCH');
          continue;
        }
        if (parsed.boundaryVersion !== options.release) add(failures, countryCode, 'PACKAGE_RELEASE_MISMATCH');
        if (!Array.isArray(parsed.features) || parsed.features.length !== entry.featureCount) {
          add(failures, countryCode, 'PACKAGE_FEATURE_COUNT_MISMATCH');
          continue;
        }
        let countryFeatureCount = 0;
        for (const feature of parsed.features) {
          const properties = isRecord(feature) ? feature.properties : undefined;
          if (!isRecord(properties) || typeof properties.areaId !== 'string'
            || typeof properties.sourceId !== 'string') {
            add(failures, countryCode, 'PACKAGE_RUNTIME_INVALID');
            continue;
          }
          countryFeatureCount += 1;
          featureCount += 1;
          if (divisionIds.has(properties.sourceId)) add(failures, countryCode, 'DIVISION_ID_DUPLICATE');
          else divisionIds.add(properties.sourceId);
          const indexRecord = index.records.get(properties.areaId);
          if (indexRecord === undefined) add(failures, countryCode, 'INDEX_ID_MISSING');
          else {
            if (indexRecord.countryCode !== countryCode) add(failures, countryCode, 'INDEX_COUNTRY_MISMATCH');
            if (indexRecord.boundaryVersion !== options.release) add(failures, countryCode, 'INDEX_RELEASE_MISMATCH');
            if (!sameNames(properties, indexRecord)) add(failures, countryCode, 'INDEX_NAME_MISMATCH');
            index.records.delete(properties.areaId);
          }
        }
        countryMetrics.push(Object.freeze({
          countryCode, featureCount: countryFeatureCount,
          packageByteSize: bytes.byteLength, packageChecksum: entry.checksum,
        }));
      }
    }
  } finally {
    await runtime?.close();
  }

  if (index !== null) {
    for (const record of index.records.values()) add(failures, record.countryCode, 'INDEX_ID_EXTRA');
    for (const code of countries) if (!index.countries.has(code)) add(failures, code, 'INDEX_COUNTRY_MISSING');
    for (const code of index.countries) if (!countries.includes(code)) add(failures, code, 'INDEX_COUNTRY_EXTRA');
  }

  packageSizes.sort((left, right) => left - right);
  countryMetrics.sort((left, right) => left.countryCode.localeCompare(right.countryCode, 'en'));
  const stableFailures = normalizeIssues(failures);
  const stableWarnings = normalizeIssues(warnings);
  const status = stableFailures.length === 0 ? 'verified' : 'failed';
  const metrics = Object.freeze({
    countryCount: countries.length,
    featureCount,
    divisionIdCount: divisionIds.size,
    indexAreaCount: index?.areaCount ?? 0,
    globalIndexBytes: indexBytes,
    totalPackageBytes: packageSizes.reduce((total, size) => total + size, 0),
    minimumPackageBytes: packageSizes[0] ?? 0,
    maximumPackageBytes: packageSizes.at(-1) ?? 0,
    p50PackageBytes: percentile(packageSizes, 0.5),
    p95PackageBytes: percentile(packageSizes, 0.95),
    peakPackageBytes,
    processingMode: 'sequential-packages',
  });
  const canonicalSummaryInput = Object.freeze({
    schemaVersion: 1,
    sourceRelease: options.release,
    status,
    countries: Object.freeze(countryMetrics),
    metrics,
    warnings: Object.freeze(stableWarnings),
    failures: Object.freeze(stableFailures),
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceRelease: options.release,
    status,
    failures: Object.freeze(stableFailures),
    warnings: Object.freeze(stableWarnings),
    metrics,
    canonicalSummaryInput,
  });
}

export function parseCrossCountryArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--release', '--packages', '--registry'].includes(key) || value === undefined || values.has(key)) {
      throw new Error('usage: verify-cross-country --release <release> --packages <dir> --registry <file>');
    }
    values.set(key, value);
  }
  for (const required of ['--release', '--packages', '--registry']) {
    if (!values.has(required)) throw new Error(`missing ${required}`);
  }
  return {
    release: values.get('--release'),
    packagesDir: path.resolve(values.get('--packages')),
    registryPath: path.resolve(values.get('--registry')),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyCrossCountry(parseCrossCountryArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'verified') process.exitCode = 1;
  }).catch(() => {
    process.stderr.write('cross-country audit failed\n');
    process.exitCode = 1;
  });
}
