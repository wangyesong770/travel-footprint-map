import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { buildCountryBoundaries, promoteDirectorySet } from '../build-country-boundaries.mjs';
import { normalizeFeatureCollection } from '../lib/boundary-normalize.mjs';
import { selectCountryFeatures } from './apply-selector.mjs';
import { extractCountry } from './extract-overture.mjs';
import { auditCountry } from './qa-country.mjs';
import { verifySelectorEvidence } from './verify-selector-evidence.mjs';
import { runProcess } from './lib/process-runner.mjs';

const FIXED_RELEASE = '2026-06-17.0';
const COUNTRY = /^[A-Z]{2}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_EXTRACT_BYTES = 1024 * 1024 * 1024;
const ATTRIBUTION = '© OpenStreetMap contributors, Overture Maps Foundation · ODbL 1.0';

export async function runCountryAudit(args, options = {}) {
  try {
    return await executeCountryAudit(args, options);
  } catch {
    return failure('INTERNAL_ERROR', 'country-runner');
  }
}

async function executeCountryAudit(args, options = {}) {
  let parsed;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    return failure(error.code ?? 'ARGUMENT_INVALID', error.subject ?? 'arguments');
  }
  if (parsed.release !== FIXED_RELEASE) return failure('RELEASE_MISMATCH', parsed.release, parsed);

  const root = path.resolve(options.cwd ?? process.cwd());
  const deps = dependencies(options.deps);
  const auditRoot = path.join(root, 'data-audit');
  let registry;
  let config;
  let selector;
  let exceptions;
  let unresolvedOverrides;
  try {
    await assertSafeSnapshot(parsed.snapshotDir);
    registry = await readSafeJson(path.join(auditRoot, 'sovereign-registry.json'), 'registry');
    if (registry?.release !== parsed.release) return failure('RELEASE_MISMATCH', parsed.release, parsed);
    config = Array.isArray(registry?.countries)
      ? registry.countries.find((entry) => entry?.sovereignCode === parsed.country)
      : undefined;
    if (config === undefined) return failure('COUNTRY_NOT_REGISTERED', parsed.country, parsed);
    if (config.status !== 'verified') return failure('COUNTRY_STATUS_INVALID', parsed.country, parsed);
    if (!Array.isArray(config.sourceCountryCodes) || config.sourceCountryCodes.length === 0
      || config.sourceCountryCodes.some((code) => typeof code !== 'string' || !COUNTRY.test(code))) {
      return failure('REGISTRY_INVALID', parsed.country, parsed);
    }
    [selector, exceptions, unresolvedOverrides] = await Promise.all([
      readSafeJson(path.join(auditRoot, 'selectors', `${parsed.country}.json`), 'selector'),
      readSafeJson(path.join(auditRoot, 'exceptions', `${parsed.country}.json`), 'exceptions'),
      readSafeJson(path.join(auditRoot, 'unresolved-source-overrides.json'), 'unresolved-overrides'),
    ]);
    if (!selectorMatchesRegistry(selector, config, parsed)) {
      return failure('REGISTRY_SELECTOR_MISMATCH', parsed.country, parsed);
    }
  } catch (error) {
    return failure(error.code ?? 'INPUT_UNREADABLE', error.subject ?? 'country-input', parsed);
  }

  const workRoot = path.join(auditRoot, 'work', parsed.release, parsed.country);
  try {
    await resetCanonicalWorkDirectory(workRoot);
  } catch {
    return failure('WORK_DIRECTORY_UNSAFE', 'country-work', parsed);
  }
  const extractDir = path.join(workRoot, 'extract');
  let extraction;
  try {
    extraction = await deps.extractCountry({
      release: parsed.release,
      country: parsed.country,
      sourceCountryCodes: config.sourceCountryCodes,
      snapshotDir: parsed.snapshotDir,
      outputDir: extractDir,
      unresolvedOverrideDocument: unresolvedOverrides,
    });
  } catch {
    return failure('EXTRACTION_FAILED', 'local-snapshot', parsed);
  }

  let rows;
  let selected;
  try {
    rows = await readGeoJsonSequence(extraction.outputPath);
    selected = deps.selectCountryFeatures(rows, { ...config, ...selector });
  } catch {
    return failure('SELECTION_FAILED', 'country-selector', parsed);
  }
  const divisionIds = selected.map(({ divisionId }) => divisionId);
  await writeFile(path.join(workRoot, 'final-division-ids.json'), `${JSON.stringify({
    schemaVersion: 1, release: parsed.release, sovereignCode: parsed.country, divisionIds,
  })}\n`);
  const evidenceResult = deps.verifySelectorEvidence(
    { selector, exceptions, finalDivisionIds: divisionIds },
    { requiredStatus: 'verified' },
  );
  if (evidenceResult?.status !== 'passed') {
    return failure('SELECTOR_UNVERIFIED', firstFailureCode(evidenceResult), parsed);
  }

  let collection;
  let qa;
  try {
    collection = deps.normalizeSelected(selected, config, parsed.release);
    const indexIds = collection.features.map(({ properties }) => properties.areaId);
    qa = deps.auditCountry(collection, config, {
      indexIds,
      exceptions: exceptions.overlapExceptions.map(({ id, kind, divisionIds }) => ({
        id,
        kind,
        divisionIds: [...divisionIds],
      })),
    });
  } catch {
    return failure('QA_FAILED', 'QA_INTERNAL_ERROR', parsed);
  }
  if (qa?.status !== 'verified') return failure('QA_FAILED', firstFailureCode(qa), parsed);

  const inputDir = path.join(workRoot, 'build-input');
  const builtPackagesDir = path.join(workRoot, 'built-packages');
  const builtReportsDir = path.join(workRoot, 'built-reports');
  await mkdir(inputDir, { recursive: true });
  await writeFile(path.join(inputDir, `${parsed.country}.geojson`), `${JSON.stringify(toBuilderCollection(selected, parsed, deps.auditedOn))}\n`);
  const generatorCommit = deps.generatorCommit ?? await gitCommit(root);
  const reportEvidence = makeReportEvidence({
    parsed, config, selector, sourceCount: rows.length, selectedCount: selected.length,
    qa, generatorCommit, auditedOn: deps.auditedOn,
  });
  let manifest;
  try {
    manifest = await deps.buildCountryBoundaries({
      inputDir,
      outputDir: builtPackagesDir,
      countryConfigs: {
        [parsed.country]: {
          sovereignCode: config.sovereignCode,
          sourceCountryCodes: config.sourceCountryCodes,
          productLevel: config.productLevel,
          selectorVersion: config.selectorVersion,
          release: parsed.release,
          status: 'verified',
          overtureSelector: selector.overtureSelector,
          allowlist: selector.allowlist,
          denylist: selector.denylist,
          administrativeScheme: config.administrativeScheme ?? config.productLevel,
          simplificationTolerance: 1e-10,
          nameZh: config.nameZh,
          nameLocal: config.nameLocal,
          aliases: [],
        },
      },
      auditReports: {
        reportsDir: builtReportsDir,
        evidenceByCountry: { [parsed.country]: reportEvidence },
        expectedSelectorVersions: { [parsed.country]: config.selectorVersion },
        sourceRelease: parsed.release,
        generatorCommit,
      },
    });
  } catch {
    return failure('BUILD_FAILED', 'country-package', parsed);
  }
  try {
    await deps.promoteCountryArtifacts({
      builtPackagesDir,
      builtReportsDir,
      packagesDir: path.join(root, 'public', 'data', 'countries'),
      reportsDir: path.join(auditRoot, 'reports', parsed.release),
      country: parsed.country,
    });
  } catch {
    return failure('PROMOTION_FAILED', 'country-artifacts', parsed);
  }
  return {
    exitCode: 0,
    result: { status: 'verified', countryCode: parsed.country, release: parsed.release, featureCount: manifest[parsed.country].featureCount ?? selected.length },
  };
}

function selectorMatchesRegistry(selector, config, parsed) {
  return selector?.schemaVersion === 1
    && selector.sovereignCode === parsed.country
    && selector.release === parsed.release
    && selector.status === 'verified'
    && selector.productLevel === config.productLevel
    && canonicalJson(selector.overtureSelector) === canonicalJson(config.overtureSelector)
    && canonicalJson(selector.allowlist) === canonicalJson(config.allowlist)
    && canonicalJson(selector.denylist) === canonicalJson(config.denylist);
}

function dependencies(overrides = {}) {
  return {
    extractCountry,
    selectCountryFeatures,
    verifySelectorEvidence,
    normalizeSelected: defaultNormalizeSelected,
    auditCountry,
    buildCountryBoundaries,
    promoteCountryArtifacts,
    auditedOn: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}

function parseArguments(args) {
  if (!Array.isArray(args)) throw new RunnerError('ARGUMENT_INVALID', 'arguments');
  const names = new Map([['--country', 'country'], ['--release', 'release'], ['--snapshot', 'snapshot']]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]);
    if (name === undefined) throw new RunnerError('ARGUMENT_UNSUPPORTED', 'argument');
    if (values[name] !== undefined || typeof args[index + 1] !== 'string' || args[index + 1].length === 0) {
      throw new RunnerError('ARGUMENT_INVALID', name);
    }
    values[name] = args[index + 1];
  }
  if (!COUNTRY.test(values.country ?? '')) throw new RunnerError('ARGUMENT_INVALID', 'country');
  if (typeof values.release !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(values.release)) {
    throw new RunnerError('ARGUMENT_INVALID', 'release');
  }
  if (typeof values.snapshot !== 'string') throw new RunnerError('ARGUMENT_INVALID', 'snapshot');
  return { country: values.country, release: values.release, snapshotDir: path.resolve(values.snapshot) };
}

async function assertSafeSnapshot(snapshotDir) {
  const [info, canonical] = await Promise.all([lstat(snapshotDir), realpath(snapshotDir)]);
  if (!info.isDirectory() || canonical !== snapshotDir) throw new RunnerError('SNAPSHOT_UNSAFE', 'snapshot');
  const metadataPath = path.join(snapshotDir, 'metadata.json');
  const metadataInfo = await lstat(metadataPath);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) throw new RunnerError('SNAPSHOT_UNSAFE', 'snapshot');
}

async function resetCanonicalWorkDirectory(workRoot) {
  const info = await lstat(workRoot).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (info?.isSymbolicLink() || (info !== undefined && !info.isDirectory())) throw new Error('unsafe work directory');
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
}

async function readSafeJson(filePath, subject) {
  let handle;
  try {
    if (await realpath(path.dirname(filePath)) !== path.dirname(filePath)) throw new RunnerError('INPUT_UNREADABLE', subject);
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_BYTES) throw new RunnerError('INPUT_UNREADABLE', subject);
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new RunnerError('INPUT_UNREADABLE', subject);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('INPUT_UNREADABLE', subject);
  } finally {
    await handle?.close();
  }
}

export async function readGeoJsonSequence(filePath, { maximumBytes = MAX_EXTRACT_BYTES } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > MAX_EXTRACT_BYTES) {
    throw new Error('invalid extraction output');
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const rows = [];
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2 || info.size > maximumBytes) throw new Error('invalid extraction output');
    const lines = createInterface({ input: handle.createReadStream({ autoClose: false }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      const feature = JSON.parse(line);
      if (feature?.type !== 'Feature') throw new Error('invalid GeoJSONSeq feature');
      const properties = feature.properties;
      rows.push({
        divisionId: properties?.divisionId,
        divisionAreaId: feature.id ?? properties?.divisionAreaId,
        sourceCountryCode: properties?.sourceCountryCode,
        subtype: properties?.subtype,
        adminLevel: properties?.adminLevel,
        localType: properties?.localType,
        isLand: properties?.isLand,
        names: properties?.names ?? {
          primary: properties?.['names.primary'],
          common: properties?.['names.common'],
        },
        aliases: properties?.aliases,
        geometry: feature.geometry,
      });
    }
    const finalInfo = await handle.stat();
    if (finalInfo.size !== info.size) throw new Error('invalid extraction output');
  } finally {
    await handle.close();
  }
  if (rows.length === 0) throw new Error('empty extraction output');
  return rows;
}

function toBuilderCollection(selected, parsed, retrievedAt) {
  return {
    type: 'FeatureCollection',
    metadata: {
      boundaryVersion: parsed.release,
      retrievedAt,
      source: 'Overture Maps Divisions division_area',
      license: 'ODbL-1.0',
      attribution: ATTRIBUTION,
    },
    features: selected.map((row) => ({
      type: 'Feature', id: row.divisionAreaId,
      properties: {
        // Selection has already enforced explicit source ownership. Preserve the upstream
        // source code (including reviewed territory consolidation such as HK/MO/TW -> CN)
        // while the package country remains the sovereign owner.
        divisionId: row.divisionId, sourceCountryCode: row.sourceCountryCode,
        country: parsed.country, subtype: row.subtype, adminLevel: row.adminLevel,
        localType: row.localType, isLand: true, names: row.names, aliases: row.aliases,
      },
      geometry: row.geometry,
    })),
  };
}

function defaultNormalizeSelected(selected, config, release) {
  const productRows = selected.map((row) => ({ ...row, subtype: row.productLevel }));
  const raw = toBuilderCollection(productRows, { country: config.sovereignCode, release }, new Date().toISOString().slice(0, 10));
  return normalizeFeatureCollection(raw, config.sovereignCode, { acceptedLevels: [config.productLevel] });
}

function makeReportEvidence({ parsed, config, selector, sourceCount, selectedCount, qa, generatorCommit, auditedOn }) {
  const exceptionIds = Array.isArray(qa.exceptions) ? qa.exceptions : [];
  return {
    schemaVersion: 1, countryCode: parsed.country, status: 'verified', sourceRelease: parsed.release,
    selectorVersion: config.selectorVersion, productLevel: config.productLevel,
    sourceCountryCodes: config.sourceCountryCodes,
    counts: {
      source: sourceCount, selected: selectedCount, excluded: sourceCount - selectedCount,
      allowlisted: config.allowlist.length, denylisted: config.denylist.length,
    },
    geometry: { invalid: 0, duplicate: 0, overlap: 0, missingName: 0 },
    vertices: qa.metrics.vertices,
    compressedBytes: { topojson: 0, gzip: 0, brotli: 0 },
    performanceMs: { extract: 0, select: 0, audit: 0, build: 0, parse: 0 },
    exceptions: exceptionIds,
    references: selector.officialReferences.map((reference) => ({
      title: reference.title, url: reference.url, retrievedOn: reference.capturedOn, license: reference.license,
    })),
    generatorCommit, auditedOn, attribution: ATTRIBUTION,
  };
}

export async function promoteCountryArtifacts({ builtPackagesDir, builtReportsDir, packagesDir, reportsDir, country }) {
  const packageStaging = siblingStaging(packagesDir);
  const reportStaging = siblingStaging(reportsDir);
  await Promise.all([mkdir(packageStaging, { recursive: true }), mkdir(reportStaging, { recursive: true })]);
  try {
    await Promise.all([copyRegularFiles(packagesDir, packageStaging), copyRegularFiles(reportsDir, reportStaging, new Set(['summary.json']))]);
    const builtManifest = JSON.parse(await readFile(path.join(builtPackagesDir, 'manifest.json'), 'utf8'));
    const builtIndex = JSON.parse(await readFile(path.join(builtPackagesDir, 'area-index.json'), 'utf8'));
    const existingManifest = await optionalJson(path.join(packageStaging, 'manifest.json'), {});
    const existingIndex = await optionalJson(path.join(packageStaging, 'area-index.json'), []);
    const manifest = { ...existingManifest, [country]: builtManifest[country] };
    const index = [
      ...existingIndex.filter((entry) => entry?.countryCode !== country),
      ...builtIndex.filter((entry) => entry?.countryCode === country),
    ].sort((left, right) => indexIdentity(left).localeCompare(indexIdentity(right), 'en'));
    await Promise.all([
      copyFile(path.join(builtPackagesDir, `${country}.topojson`), path.join(packageStaging, `${country}.topojson`)),
      copyFile(path.join(builtReportsDir, `${country}.json`), path.join(reportStaging, `${country}.json`)),
      writeFile(path.join(packageStaging, 'manifest.json'), `${canonicalJson(manifest)}\n`),
      writeFile(path.join(packageStaging, 'area-index.json'), `${canonicalJson(index)}\n`),
    ]);
    await promoteDirectorySet([
      { stagingDir: packageStaging, destinationDir: packagesDir },
      { stagingDir: reportStaging, destinationDir: reportsDir },
    ]);
  } catch (error) {
    await Promise.allSettled([rm(packageStaging, { recursive: true, force: true }), rm(reportStaging, { recursive: true, force: true })]);
    throw error;
  }
}

async function copyRegularFiles(source, destination, ignored = new Set()) {
  const entries = await readdir(source, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('release directory contains unsafe entry');
    await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

async function optionalJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

async function gitCommit(root) {
  const result = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, shell: false, maxOutputBytes: 1024 });
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim())) throw new Error('git commit unavailable');
  return result.stdout.trim();
}

function siblingStaging(destination) {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.staging`);
}

function indexIdentity(record) { return record.kind === 'country' ? `0:${record.countryCode}` : `1:${record.areaId}`; }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function firstFailureCode(result) { return result?.failures?.[0]?.code ?? 'UNKNOWN_FAILURE'; }

function failure(code, subject, parsed = {}) {
  return {
    exitCode: 1,
    result: { status: 'failed', ...(parsed.country ? { countryCode: parsed.country } : {}), ...(parsed.release ? { release: parsed.release } : {}), failures: [{ code, subject }] },
  };
}

class RunnerError extends Error {
  constructor(code, subject) { super(code); this.code = code; this.subject = subject; }
}

async function main() {
  const { exitCode, result } = await runCountryAudit(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
