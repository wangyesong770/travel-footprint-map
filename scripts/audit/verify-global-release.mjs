import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const COUNTRY_CODE = /^[A-Z]{2}$/u;
const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MIN_GLOBAL_SOVEREIGN_COUNT = 190;
const REQUIRED_CHINA_CODES = Object.freeze(['CN', 'HK', 'MO', 'TW']);

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('cannot serialize undefined');
  return serialized;
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

async function readJson(filePath) {
  const file = await stat(filePath);
  if (!file.isFile() || file.size === 0 || file.size > MAX_METADATA_BYTES) {
    throw new Error(`invalid metadata file: ${path.basename(filePath)}`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`invalid JSON: ${path.basename(filePath)}`);
  }
}

const isMissingPath = (error) => isRecord(error) && error.code === 'ENOENT';

async function readRequiredJson(filePath, missingCode, invalidCode, failures) {
  try {
    return await readJson(filePath);
  } catch (error) {
    add(failures, 'GLOBAL', isMissingPath(error) ? missingCode : invalidCode);
    return null;
  }
}

async function readRequiredDirectory(directoryPath, missingCode, invalidCode, failures) {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    add(failures, 'GLOBAL', isMissingPath(error) ? missingCode : invalidCode);
    return null;
  }
}

const failureKey = ({ countryCode, code }) => `${countryCode}:${code}`;

export class GlobalReleaseError extends Error {
  constructor(failures) {
    const sorted = [...new Map(failures.map((failure) => [failureKey(failure), failure])).values()]
      .sort((left, right) => failureKey(left).localeCompare(failureKey(right), 'en'));
    super(sorted.map(failureKey).join('\n'));
    this.name = 'GlobalReleaseError';
    this.failures = Object.freeze(sorted.map(Object.freeze));
  }
}

const add = (failures, countryCode, code) => failures.push({ countryCode, code });

function countryFileSet(entries, suffix, ignored = new Set()) {
  const result = new Set();
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const match = new RegExp(`^([A-Z]{2})\\.${suffix.replace('.', '\\.')}$$`, 'u').exec(entry.name);
    if (entry.isFile() && match) result.add(match[1]);
  }
  return result;
}

function compareSets(expected, actual, missingCode, extraCode, failures) {
  for (const code of expected) if (!actual.has(code)) add(failures, code, missingCode);
  for (const code of actual) if (!expected.has(code)) add(failures, code, extraCode);
}

function validAttribution(value) {
  return typeof value === 'string'
    && /OpenStreetMap contributors/iu.test(value)
    && /Overture Maps Foundation/iu.test(value)
    && /ODbL(?:\s*1\.0)?/iu.test(value);
}

async function loadRuntimeValidator() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule('/src/areas/package-validator.ts');
    if (typeof module.parseCountryPackage !== 'function') throw new Error('runtime package validator is unavailable');
    return {
      validate: (bytes, entry) => module.parseCountryPackage(bytes, entry),
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

function readRegistry(input, release, failures) {
  if (!isRecord(input) || input.release !== release || !Array.isArray(input.countries)) {
    add(failures, 'GLOBAL', 'REGISTRY_RELEASE_MISMATCH');
    return [];
  }
  const sovereignCodes = new Set();
  const sourceOwners = new Map();
  const countries = [];
  for (const raw of input.countries) {
    if (!isRecord(raw) || typeof raw.sovereignCode !== 'string' || !COUNTRY_CODE.test(raw.sovereignCode)) {
      add(failures, 'GLOBAL', 'REGISTRY_INVALID');
      continue;
    }
    const code = raw.sovereignCode;
    if (sovereignCodes.has(code)) add(failures, code, 'SOVEREIGN_DUPLICATE');
    sovereignCodes.add(code);
    if (raw.status !== 'verified') add(failures, code, raw.status === 'draft' ? 'COUNTRY_DRAFT' : 'COUNTRY_FAILED');
    if (!Number.isSafeInteger(raw.selectorVersion) || raw.selectorVersion < 1) add(failures, code, 'SELECTOR_VERSION_INVALID');
    if (!Array.isArray(raw.sourceCountryCodes) || raw.sourceCountryCodes.length === 0) {
      add(failures, code, 'SOURCE_OWNERSHIP_INVALID');
    } else {
      for (const sourceCode of raw.sourceCountryCodes) {
        if (typeof sourceCode !== 'string' || !COUNTRY_CODE.test(sourceCode) || sourceOwners.has(sourceCode)) {
          add(failures, code, 'SOURCE_OWNERSHIP_INVALID');
        } else sourceOwners.set(sourceCode, code);
      }
    }
    countries.push(raw);
  }
  if (sovereignCodes.size < MIN_GLOBAL_SOVEREIGN_COUNT) add(failures, 'GLOBAL', 'REGISTRY_INCOMPLETE');
  const china = countries.find(({ sovereignCode }) => sovereignCode === 'CN');
  const chinaCodes = new Set(Array.isArray(china?.sourceCountryCodes) ? china.sourceCountryCodes : []);
  if (!china || china.perspective !== 'china-official'
    || REQUIRED_CHINA_CODES.some((code) => !chinaCodes.has(code) || sourceOwners.get(code) !== 'CN')) {
    add(failures, 'CN', 'CHINA_OWNERSHIP_MISMATCH');
  }
  return countries.sort((left, right) => left.sovereignCode.localeCompare(right.sovereignCode, 'en'));
}

function validateSummary(summary, release, expected, failures) {
  if (!isRecord(summary) || summary.sourceRelease !== release || !Array.isArray(summary.countries)) {
    add(failures, 'GLOBAL', 'SUMMARY_RELEASE_MISMATCH');
    return null;
  }
  const codes = new Set();
  const entries = new Map();
  for (const entry of summary.countries) {
    if (!isRecord(entry) || typeof entry.countryCode !== 'string' || !COUNTRY_CODE.test(entry.countryCode)) {
      add(failures, 'GLOBAL', 'SUMMARY_INVALID');
      continue;
    }
    codes.add(entry.countryCode);
    entries.set(entry.countryCode, entry);
    if (entry.status !== 'verified') add(failures, entry.countryCode, 'SUMMARY_NOT_VERIFIED');
  }
  compareSets(expected, codes, 'SUMMARY_COUNTRY_MISSING', 'SUMMARY_COUNTRY_EXTRA', failures);
  return entries;
}

export async function verifyGlobalRelease(options) {
  const { release, packagesDir, reportsDir, registryPath } = options ?? {};
  if (typeof release !== 'string' || !RELEASE.test(release)) throw new Error('invalid release');
  if (![packagesDir, reportsDir, registryPath].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('packagesDir, reportsDir, and registryPath are required');
  }
  const outputPath = options.outputPath ?? path.join(packagesDir, 'release-ready.json');
  const failures = [];
  const [registry, packageEntries, reportEntries] = await Promise.all([
    readRequiredJson(registryPath, 'REGISTRY_MISSING', 'REGISTRY_INVALID', failures),
    readRequiredDirectory(packagesDir, 'PACKAGE_DIRECTORY_MISSING', 'PACKAGE_DIRECTORY_INVALID', failures),
    readRequiredDirectory(reportsDir, 'REPORT_DIRECTORY_MISSING', 'REPORT_DIRECTORY_INVALID', failures),
  ]);
  const [packageManifest, summary] = await Promise.all([
    packageEntries === null
      ? null
      : readRequiredJson(path.join(packagesDir, 'manifest.json'), 'MANIFEST_MISSING', 'MANIFEST_INVALID', failures),
    reportEntries === null
      ? null
      : readRequiredJson(path.join(reportsDir, 'summary.json'), 'SUMMARY_MISSING', 'SUMMARY_INVALID', failures),
  ]);
  const countries = registry === null ? [] : readRegistry(registry, release, failures);
  const expected = new Set(countries.map(({ sovereignCode }) => sovereignCode));
  const packageFiles = packageEntries === null
    ? null
    : countryFileSet(packageEntries, 'topojson', new Set(['manifest.json', 'area-index.json', 'release-ready.json']));
  const reportFiles = reportEntries === null
    ? null
    : countryFileSet(reportEntries, 'json', new Set(['summary.json']));
  if (packageFiles !== null) compareSets(expected, packageFiles, 'PACKAGE_MISSING', 'PACKAGE_EXTRA', failures);
  if (reportFiles !== null) compareSets(expected, reportFiles, 'REPORT_MISSING', 'REPORT_EXTRA', failures);
  if (packageManifest !== null) {
    const manifestCodes = new Set(isRecord(packageManifest) ? Object.keys(packageManifest) : []);
    compareSets(expected, manifestCodes, 'MANIFEST_COUNTRY_MISSING', 'MANIFEST_COUNTRY_EXTRA', failures);
  }
  const summaryByCountry = summary === null ? null : validateSummary(summary, release, expected, failures);

  let runtime;
  const validatePackage = options.validatePackage ?? ((...args) => runtime.validate(...args));
  const comparableCountries = packageFiles === null || reportFiles === null || packageManifest === null
    ? []
    : countries.filter(({ sovereignCode }) => packageFiles.has(sovereignCode)
      && reportFiles.has(sovereignCode) && isRecord(packageManifest[sovereignCode]));
  if (!options.validatePackage && comparableCountries.length > 0) runtime = await loadRuntimeValidator();
  try {
    for (const config of comparableCountries) {
      const code = config.sovereignCode;
      const entry = packageManifest[code];
      const report = await readJson(path.join(reportsDir, `${code}.json`));
      const bytes = await readFile(path.join(packagesDir, `${code}.topojson`));
      const byteChecksum = createHash('sha256').update(bytes).digest('hex');
      if (entry.countryCode !== code) add(failures, code, 'PACKAGE_COUNTRY_MISMATCH');
      if (entry.boundaryVersion !== release) add(failures, code, 'PACKAGE_RELEASE_MISMATCH');
      if (report.sourceRelease !== release) add(failures, code, 'REPORT_RELEASE_MISMATCH');
      if (report.countryCode !== code) add(failures, code, 'REPORT_COUNTRY_MISMATCH');
      if (report.status !== 'verified') add(failures, code, 'REPORT_NOT_VERIFIED');
      if (report.selectorVersion !== config.selectorVersion) add(failures, code, 'SELECTOR_VERSION_MISMATCH');
      if (summaryByCountry !== null) {
        const summaryEntry = summaryByCountry.get(code);
        if (!isRecord(summaryEntry)
          || summaryEntry.selectorVersion !== report.selectorVersion
          || summaryEntry.packageByteSize !== report.packageByteSize
          || summaryEntry.packageChecksum !== report.packageChecksum) {
          add(failures, code, 'SUMMARY_BINDING_MISMATCH');
        }
      }
      if (!Array.isArray(report.sourceCountryCodes)
        || canonicalJson([...report.sourceCountryCodes].sort()) !== canonicalJson([...config.sourceCountryCodes].sort())) {
        add(failures, code, 'SOURCE_OWNERSHIP_MISMATCH');
      }
      if (!CHECKSUM.test(entry.checksum ?? '') || entry.checksum !== byteChecksum
        || report.packageChecksum !== byteChecksum || entry.byteSize !== bytes.byteLength
        || report.packageByteSize !== bytes.byteLength) {
        add(failures, code, 'CHECKSUM_MISMATCH');
      }
      if (!validAttribution(entry.attribution) || report.attribution !== entry.attribution) {
        add(failures, code, 'ATTRIBUTION_MISSING');
      }
      try {
        await validatePackage(bytes, entry);
      } catch {
        add(failures, code, 'RUNTIME_VALIDATION_FAILED');
      }
    }
  } finally {
    await runtime?.close();
  }

  if (failures.length > 0) throw new GlobalReleaseError(failures);
  const result = {
    schemaVersion: 1,
    release,
    countries: [...expected].sort((left, right) => left.localeCompare(right, 'en')),
    manifest: Object.fromEntries([...expected].sort().map((code) => [code, packageManifest[code]])),
    registryChecksum: createHash('sha256').update(canonicalJson(registry)).digest('hex'),
    reportSummaryChecksum: createHash('sha256').update(canonicalJson(summary)).digest('hex'),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${canonicalJson(result)}\n`, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return result;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--release', '--packages', '--reports', '--registry', '--output'].includes(key) || value === undefined) {
      throw new Error('usage: verify-global-release --release <release> --packages <dir> --reports <dir> [--registry <file>] [--output <file>]');
    }
    values.set(key, value);
  }
  for (const required of ['--release', '--packages', '--reports']) if (!values.has(required)) throw new Error(`missing ${required}`);
  const packagesDir = path.resolve(values.get('--packages'));
  return {
    release: values.get('--release'), packagesDir,
    reportsDir: path.resolve(values.get('--reports')),
    registryPath: path.resolve(values.get('--registry') ?? 'data-audit/sovereign-registry.json'),
    outputPath: path.resolve(values.get('--output') ?? path.join(packagesDir, 'release-ready.json')),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyGlobalRelease(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'global release verification failed'}\n`);
    process.exitCode = 1;
  });
}
