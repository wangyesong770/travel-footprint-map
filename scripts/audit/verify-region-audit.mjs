#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/u;
const COUNTRY = /^[A-Z]{2}$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const REGIONS = Object.freeze([
  'east-asia-pacific',
  'south-central-asia',
  'europe',
  'middle-east-north-africa',
  'sub-saharan-africa',
  'north-america-caribbean',
  'latin-america',
]);
const LIMITS = Object.freeze({
  REGISTRY: 4 * 1024 * 1024,
  MANIFEST: 16 * 1024 * 1024,
  SELECTOR: 1024 * 1024,
  REPORT: 16 * 1024 * 1024,
  PACKAGE: 256 * 1024 * 1024,
});

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('undefined is not canonical JSON');
  return serialized;
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (left, right) => left.localeCompare(right, 'en');
const failureKey = ({ countryCode, code }) => `${countryCode}:${code}`;

function validRelease(value) {
  if (typeof value !== 'string' || !RELEASE.test(value)) return false;
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(date);
}

export class RegionAuditError extends Error {
  constructor({ region, release, countries, failures }) {
    const sorted = [...new Map(failures.map((failure) => [failureKey(failure), failure])).values()]
      .sort((left, right) => compare(failureKey(left), failureKey(right)));
    super(sorted.map(failureKey).join('\n'));
    this.name = 'RegionAuditError';
    this.region = region;
    this.release = release;
    this.countries = Object.freeze([...countries].sort(compare));
    this.failures = Object.freeze(sorted.map(Object.freeze));
  }

  toResult() {
    return {
      status: 'failed', region: this.region, release: this.release,
      countries: [...this.countries], failures: [...this.failures],
    };
  }
}

class InputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'InputError';
    this.code = code;
  }
}

function add(failures, countryCode, code) {
  failures.push({ countryCode, code });
}

async function assertRealDirectory(directoryPath, subject) {
  const resolved = path.resolve(directoryPath);
  try {
    const [info, target] = await Promise.all([stat(resolved), realpath(resolved)]);
    if (!info.isDirectory() || target !== resolved) throw new InputError(`${subject}_DIRECTORY_UNREADABLE`);
    return resolved;
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error?.code === 'ENOENT') throw new InputError(`${subject}_DIRECTORY_MISSING`);
    throw new InputError(`${subject}_DIRECTORY_UNREADABLE`);
  }
}

async function readBounded(filePath, subject, limit) {
  let handle;
  try {
    const resolved = path.resolve(filePath);
    const parent = path.dirname(resolved);
    if (await realpath(parent) !== parent) throw new InputError(`${subject}_UNREADABLE`);
    handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new InputError(`${subject}_UNREADABLE`);
    if (info.size === 0) throw new InputError(`${subject}_EMPTY`);
    if (info.size > limit) throw new InputError(`${subject}_TOO_LARGE`);
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, (limit + 1) - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > limit) throw new InputError(`${subject}_TOO_LARGE`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error?.code === 'ENOENT') throw new InputError(`${subject}_MISSING`);
    throw new InputError(`${subject}_UNREADABLE`);
  } finally {
    await handle?.close();
  }
}

async function readJson(filePath, subject, limit) {
  const bytes = await readBounded(filePath, subject, limit);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new InputError(`${subject}_JSON_INVALID`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InputError(`${subject}_JSON_INVALID`);
  }
}

async function readDirectory(directoryPath, subject) {
  const resolved = await assertRealDirectory(directoryPath, subject);
  try {
    return await readdir(resolved, { withFileTypes: true });
  } catch {
    throw new InputError(`${subject}_DIRECTORY_UNREADABLE`);
  }
}

function artifactCodes(entries, suffix) {
  const pattern = new RegExp(`^([A-Z]{2})\\.${suffix}$`, 'u');
  return new Set(entries.flatMap((entry) => {
    const match = pattern.exec(entry.name);
    return match === null ? [] : [match[1]];
  }));
}

function readRegistry(input, region, release, failures) {
  if (!isRecord(input) || input.release !== release || !Array.isArray(input.countries)) {
    add(failures, 'GLOBAL', 'REGISTRY_INVALID');
    return { countries: [], allCodes: new Set(), usable: false };
  }
  const allCodes = new Set();
  const countries = [];
  for (const config of input.countries) {
    if (!isRecord(config) || typeof config.sovereignCode !== 'string' || !COUNTRY.test(config.sovereignCode)
      || typeof config.auditRegion !== 'string' || !REGIONS.includes(config.auditRegion)) {
      add(failures, 'GLOBAL', 'REGISTRY_INVALID');
      continue;
    }
    if (allCodes.has(config.sovereignCode)) add(failures, config.sovereignCode, 'CONFIG_DUPLICATE');
    allCodes.add(config.sovereignCode);
    if (config.auditRegion !== region) continue;
    countries.push(config);
    if (config.status !== 'verified') {
      add(failures, config.sovereignCode, config.status === 'draft' ? 'CONFIG_DRAFT' : 'CONFIG_FAILED');
    }
  }
  if (countries.length === 0) add(failures, 'GLOBAL', 'REGION_EMPTY');
  countries.sort((left, right) => compare(left.sovereignCode, right.sovereignCode));
  return { countries, allCodes, usable: true };
}

function findExtras(codes, allCodes, kind, failures) {
  for (const code of codes) if (!allCodes.has(code)) add(failures, code, `${kind}_EXTRA`);
}

function requireExpected(expected, actual, kind, failures) {
  for (const code of expected) if (!actual.has(code)) add(failures, code, `${kind}_MISSING`);
}

function inputFailure(failures, countryCode, error, fallback) {
  add(failures, countryCode, error instanceof InputError ? error.code : fallback);
}

let strictRegistryValidatorPromise;

async function createStrictRegistryValidator() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule('/src/audit/registry.ts');
    if (typeof module.loadAuditRegistry !== 'function') throw new Error('strict registry validator unavailable');
    return module.loadAuditRegistry;
  } finally {
    await server.close();
  }
}

function loadStrictRegistryValidator() {
  strictRegistryValidatorPromise ??= createStrictRegistryValidator();
  return strictRegistryValidatorPromise;
}

function validateSelector(selector, config, release, failures) {
  const code = config.sovereignCode;
  if (!isRecord(selector)) return add(failures, code, 'SELECTOR_INVALID');
  if (selector.status !== 'verified') add(failures, code, selector.status === 'draft' ? 'SELECTOR_DRAFT' : 'SELECTOR_FAILED');
  if (selector.release !== release) add(failures, code, 'SELECTOR_RELEASE_MISMATCH');
  if (selector.sovereignCode !== code) add(failures, code, 'SELECTOR_COUNTRY_MISMATCH');
  if (canonicalJson(selector.overtureSelector) !== canonicalJson(config.overtureSelector)) {
    add(failures, code, 'SELECTOR_CONFIG_MISMATCH');
  }
}

function validateReport(report, config, release, failures) {
  const code = config.sovereignCode;
  if (!isRecord(report)) return add(failures, code, 'REPORT_INVALID');
  if (report.status !== 'verified') add(failures, code, report.status === 'draft' ? 'REPORT_DRAFT' : 'REPORT_FAILED');
  if (report.sourceRelease !== release) add(failures, code, 'REPORT_RELEASE_MISMATCH');
  if (report.countryCode !== code) add(failures, code, 'REPORT_COUNTRY_MISMATCH');
  if (report.selectorVersion !== config.selectorVersion) add(failures, code, 'SELECTOR_VERSION_MISMATCH');
  const sourceCodes = Array.isArray(report.sourceCountryCodes) ? [...report.sourceCountryCodes].sort(compare) : null;
  if (sourceCodes === null || canonicalJson(sourceCodes) !== canonicalJson([...config.sourceCountryCodes].sort(compare))) {
    add(failures, code, 'SOURCE_OWNERSHIP_MISMATCH');
  }
}

function validatePackageBinding(bytes, entry, report, code, release, failures) {
  if (!isRecord(entry)) return add(failures, code, 'MANIFEST_ENTRY_INVALID');
  if (entry.countryCode !== code) add(failures, code, 'PACKAGE_COUNTRY_MISMATCH');
  if (entry.boundaryVersion !== release) add(failures, code, 'PACKAGE_RELEASE_MISMATCH');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (!CHECKSUM.test(entry.checksum ?? '') || entry.checksum !== checksum
    || entry.byteSize !== bytes.byteLength
    || (isRecord(report) && (report.packageChecksum !== checksum || report.packageByteSize !== bytes.byteLength))) {
    add(failures, code, 'CHECKSUM_MISMATCH');
  }
  if (isRecord(report) && report.attribution !== entry.attribution) add(failures, code, 'ATTRIBUTION_MISMATCH');
}

export async function verifyRegionAudit(options) {
  const { region, release, selectorsDir, reportsDir, packagesDir, registryPath } = options ?? {};
  if (!REGIONS.includes(region)) throw new Error('invalid region');
  if (!validRelease(release)) throw new Error('invalid release');
  if (![selectorsDir, reportsDir, packagesDir, registryPath].every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error('input paths are required');
  }
  const failures = [];
  let registry;
  let selectorEntries;
  let reportEntries;
  let packageEntries;
  let manifest;
  try { registry = await readJson(registryPath, 'REGISTRY', LIMITS.REGISTRY); }
  catch (error) { inputFailure(failures, 'GLOBAL', error, 'REGISTRY_UNREADABLE'); }
  try { selectorEntries = await readDirectory(selectorsDir, 'SELECTOR'); }
  catch (error) { inputFailure(failures, 'GLOBAL', error, 'SELECTOR_DIRECTORY_UNREADABLE'); }
  try { reportEntries = await readDirectory(reportsDir, 'REPORT'); }
  catch (error) { inputFailure(failures, 'GLOBAL', error, 'REPORT_DIRECTORY_UNREADABLE'); }
  try { packageEntries = await readDirectory(packagesDir, 'PACKAGE'); }
  catch (error) { inputFailure(failures, 'GLOBAL', error, 'PACKAGE_DIRECTORY_UNREADABLE'); }
  if (packageEntries !== undefined) {
    try { manifest = await readJson(path.join(packagesDir, 'manifest.json'), 'MANIFEST', LIMITS.MANIFEST); }
    catch (error) { inputFailure(failures, 'GLOBAL', error, 'MANIFEST_UNREADABLE'); }
  }

  let registryValid = registry !== undefined;
  if (registryValid) {
    try {
      const validateRegistry = options.validateRegistry ?? await loadStrictRegistryValidator();
      validateRegistry(registry);
    } catch {
      add(failures, 'GLOBAL', 'REGISTRY_INVALID');
      registryValid = false;
    }
  }

  const parsed = !registryValid
    ? { countries: [], allCodes: new Set(), usable: false }
    : readRegistry(registry, region, release, failures);
  const expected = new Set(parsed.countries.map(({ sovereignCode }) => sovereignCode));
  const selectorCodes = selectorEntries === undefined ? undefined : artifactCodes(selectorEntries, 'json');
  const reportCodes = reportEntries === undefined ? undefined : artifactCodes(reportEntries, 'json');
  const packageCodes = packageEntries === undefined ? undefined : artifactCodes(packageEntries, 'topojson');
  const manifestCodes = manifest === undefined
    ? undefined
    : new Set(isRecord(manifest) ? Object.keys(manifest).filter((code) => COUNTRY.test(code)) : []);
  if (manifest !== undefined && !isRecord(manifest)) add(failures, 'GLOBAL', 'MANIFEST_INVALID');

  if (parsed.usable) {
    for (const [actual, kind] of [
      [selectorCodes, 'SELECTOR'], [reportCodes, 'REPORT'], [packageCodes, 'PACKAGE'], [manifestCodes, 'MANIFEST'],
    ]) {
      if (actual === undefined) continue;
      requireExpected(expected, actual, kind, failures);
      findExtras(actual, parsed.allCodes, kind, failures);
    }
  }

  for (const config of parsed.countries) {
    const code = config.sovereignCode;
    let selector;
    let report;
    let packageBytes;
    if (selectorCodes?.has(code)) {
      try { selector = await readJson(path.join(selectorsDir, `${code}.json`), 'SELECTOR', LIMITS.SELECTOR); }
      catch (error) { inputFailure(failures, code, error, 'SELECTOR_UNREADABLE'); }
    }
    if (reportCodes?.has(code)) {
      try { report = await readJson(path.join(reportsDir, `${code}.json`), 'REPORT', LIMITS.REPORT); }
      catch (error) { inputFailure(failures, code, error, 'REPORT_UNREADABLE'); }
    }
    if (packageCodes?.has(code)) {
      try { packageBytes = await readBounded(path.join(packagesDir, `${code}.topojson`), 'PACKAGE', LIMITS.PACKAGE); }
      catch (error) { inputFailure(failures, code, error, 'PACKAGE_UNREADABLE'); }
    }
    if (selector !== undefined) validateSelector(selector, config, release, failures);
    if (report !== undefined) validateReport(report, config, release, failures);
    if (packageBytes !== undefined && manifest?.[code] !== undefined) {
      validatePackageBinding(packageBytes, manifest[code], report, code, release, failures);
    }
  }

  const countries = [...expected].sort(compare);
  if (failures.length > 0) throw new RegionAuditError({ region, release, countries, failures });
  return { status: 'passed', region, release, countries, failures: [] };
}

function parseArguments(args) {
  if (!Array.isArray(args)) throw new InputError('ARGUMENT_INVALID');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--region', '--release'].includes(flag) || typeof value !== 'string' || value.length === 0 || values.has(flag)) {
      throw new InputError('ARGUMENT_INVALID');
    }
    values.set(flag, value);
  }
  if (!REGIONS.includes(values.get('--region'))) throw new InputError('ARGUMENT_REGION_INVALID');
  if (!validRelease(values.get('--release'))) throw new InputError('ARGUMENT_RELEASE_INVALID');
  return { region: values.get('--region'), release: values.get('--release') };
}

export async function runRegionAuditCli(args, options = {}) {
  let parsed;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    const rawRelease = args?.[args.indexOf?.('--release') + 1];
    return {
      exitCode: 1,
      result: {
        status: 'failed', region: 'unknown', release: typeof rawRelease === 'string' ? rawRelease : 'unknown',
        countries: [], failures: [{ countryCode: 'GLOBAL', code: error instanceof InputError ? error.code : 'ARGUMENT_INVALID' }],
      },
    };
  }
  const root = path.resolve(options.cwd ?? process.cwd());
  try {
    const result = await verifyRegionAudit({
      ...parsed,
      registryPath: path.join(root, 'data-audit', 'sovereign-registry.json'),
      selectorsDir: path.join(root, 'data-audit', 'selectors'),
      reportsDir: path.join(root, 'data-audit', 'reports', parsed.release),
      packagesDir: path.join(root, 'public', 'data', 'countries'),
    });
    return { exitCode: 0, result };
  } catch (error) {
    if (error instanceof RegionAuditError) return { exitCode: 1, result: error.toResult() };
    return {
      exitCode: 1,
      result: {
        status: 'failed', region: parsed.region, release: parsed.release, countries: [],
        failures: [{ countryCode: 'GLOBAL', code: 'INTERNAL_ERROR' }],
      },
    };
  }
}

async function main() {
  const { exitCode, result } = await runRegionAuditCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
