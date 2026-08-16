import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { topology } from 'topojson-server';
import { presimplify, simplify } from 'topojson-simplify';

import { selectCountryFeatures } from './audit/apply-selector.mjs';
import { writeAuditSummary, writeCountryAuditReport } from './audit/write-report.mjs';
import { normalizeFeatureCollection, normalizeMetadata } from './lib/boundary-normalize.mjs';

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const QUANTIZATION = 100_000;
export async function buildCountryBoundaries({ inputDir, outputDir, indexModulePath, auditReports, countryConfigs }) {
  if (typeof inputDir !== 'string' || typeof outputDir !== 'string') throw new Error('inputDir and outputDir are required');
  const reviewedConfigs = validateCountryConfigs(countryConfigs);
  const statuses = Object.values(reviewedConfigs).map(({ status }) => status);
  if (auditReports === undefined && statuses.includes('verified')) throw new Error('verified build requires audit reports');
  if (auditReports !== undefined && statuses.some((status) => status !== 'verified')) {
    throw new Error('audit reports require a verified build');
  }
  const entries = (await readdir(inputDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (entries.length === 0) throw new Error('input directory contains no country files');
  const manifest = {};
  const outputs = [];
  const indexRecords = [];
  const indexIds = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Z]{2}\.geojson$/.test(entry.name)) {
      throw new Error(`invalid country file name: ${entry.name}`);
    }
    const countryCode = entry.name.slice(0, 2);
    const config = reviewedConfigs[countryCode];
    if (!config) throw new Error(`country scheme is not configured: ${countryCode}`);
    const inputPath = path.join(inputDir, entry.name);
    const fileStat = await stat(inputPath);
    if (fileStat.size === 0 || fileStat.size > MAX_INPUT_BYTES) throw new Error(`input size limit exceeded: ${entry.name}`);
    const raw = await readFile(inputPath, 'utf8');
    const parsed = parseJson(raw, entry.name);
    const selectorRows = toSelectorRows(parsed);
    if (selectorRows.some(({ sovereignCountryCode }) => sovereignCountryCode !== countryCode)) {
      throw new Error(`input sovereign country mismatch: ${countryCode}`);
    }
    if (selectorRows.some(({ sourceCountryCode }) => !config.sourceCountryCodes.includes(sourceCountryCode))) {
      throw new Error(`input source ownership mismatch: ${countryCode}`);
    }
    const selected = selectCountryFeatures(selectorRows, config);
    const normalized = normalizeFeatureCollection(toSelectedFeatureCollection(parsed, selected), countryCode, { acceptedLevels: [config.productLevel] });
    const metadata = normalizeMetadata(parsed.metadata);
    if (metadata.boundaryVersion !== config.release) throw new Error(`boundary release mismatch: ${countryCode}`);
    const packageObject = createTopologyPackage(countryCode, config, metadata, normalized);
    const packageBytes = Buffer.from(`${canonicalJson(packageObject)}\n`, 'utf8');
    const checksum = createHash('sha256').update(packageBytes).digest('hex');

    manifest[countryCode] = {
      schemaVersion: 1,
      countryCode,
      boundaryVersion: metadata.boundaryVersion,
      administrativeScheme: config.administrativeScheme,
      featureCount: normalized.features.length,
      byteSize: packageBytes.byteLength,
      checksum,
      updatedAt: metadata.retrievedAt,
      source: metadata.source,
      attribution: metadata.attribution,
    };
    indexRecords.push({
      kind: 'country', countryCode, boundaryVersion: metadata.boundaryVersion,
      nameZh: config.nameZh, nameLocal: config.nameLocal, aliases: config.aliases,
    });
    for (const { properties } of normalized.features) {
      if (indexIds.has(properties.areaId)) throw new Error(`duplicate area index ID: ${properties.areaId}`);
      indexIds.add(properties.areaId);
      indexRecords.push({
        kind: 'area', areaId: properties.areaId, countryCode, boundaryVersion: metadata.boundaryVersion,
        adminLevel: properties.adminLevel, ...(properties.nameZh === undefined ? {} : { nameZh: properties.nameZh }),
        nameLocal: properties.nameLocal, aliases: properties.aliases,
      });
    }
    outputs.push([`${countryCode}.topojson`, packageBytes]);
  }

  indexRecords.sort((left, right) => indexIdentity(left).localeCompare(indexIdentity(right), 'en'));
  assertIndexParity(indexRecords, outputs);

  const outputStagingDir = await createSiblingStagingDirectory(outputDir);
  let reportsPromotion;
  const indexSource = indexModulePath === undefined ? undefined
    : `import type { AreaIndexRecord } from '../areas/area-index';\n\nexport const AREA_INDEX_RECORDS = ${escapeInlineScript(canonicalJson(indexRecords))} as const satisfies readonly AreaIndexRecord[];\n`;
  try {
    await mkdir(outputStagingDir);
    for (const [fileName, bytes] of outputs) await writeFile(path.join(outputStagingDir, fileName), bytes);
    await bindManifestToFinalPackageBytes(outputStagingDir, manifest);
    await atomicWriteText(path.join(outputStagingDir, 'manifest.json'), `${canonicalJson(manifest)}\n`);
    await atomicWriteText(path.join(outputStagingDir, 'area-index.json'), `${canonicalJson(indexRecords)}\n`);
    if (indexModulePath !== undefined && isPathInside(outputDir, indexModulePath)) {
      const stagedIndexModulePath = path.join(outputStagingDir, path.relative(path.resolve(outputDir), path.resolve(indexModulePath)));
      await atomicWriteText(stagedIndexModulePath, indexSource);
    }
    if (auditReports !== undefined) {
      assertSeparateReleaseDirectories(outputDir, auditReports?.reportsDir);
      reportsPromotion = await stageBoundAuditReports({ auditReports, manifest, outputDir: outputStagingDir });
    }
    await promoteDirectorySet([
      { stagingDir: outputStagingDir, destinationDir: outputDir },
      ...(reportsPromotion === undefined ? [] : [reportsPromotion]),
    ]);
  } catch (error) {
    await Promise.all([
      rm(outputStagingDir, { recursive: true, force: true }),
      reportsPromotion === undefined ? Promise.resolve() : rm(reportsPromotion.stagingDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
  if (indexModulePath !== undefined && !isPathInside(outputDir, indexModulePath)) {
    await atomicWriteText(indexModulePath, indexSource);
  }
  return manifest;
}

function validateCountryConfigs(input) {
  if (!isPlainObject(input) || Object.keys(input).length === 0) throw new Error('countryConfigs is required');
  const result = Object.create(null);
  for (const [countryCode, candidate] of Object.entries(input)) {
    if (!/^[A-Z]{2}$/.test(countryCode) || !isPlainObject(candidate) || candidate.sovereignCode !== countryCode) {
      throw new Error(`invalid country configuration: ${countryCode}`);
    }
    const allowedKeys = new Set([
      'sovereignCode', 'sourceCountryCodes', 'productLevel', 'selectorVersion', 'release', 'status',
      'overtureSelector', 'allowlist', 'denylist', 'administrativeScheme', 'simplificationTolerance',
      'nameZh', 'nameLocal', 'aliases',
    ]);
    if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) throw new Error(`unknown country configuration key: ${countryCode}`);
    if (!Array.isArray(candidate.sourceCountryCodes) || candidate.sourceCountryCodes.length === 0
      || new Set(candidate.sourceCountryCodes).size !== candidate.sourceCountryCodes.length
      || candidate.sourceCountryCodes.some((code) => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))
      || !candidate.sourceCountryCodes.includes(countryCode)) {
      throw new Error(`invalid source ownership: ${countryCode}`);
    }
    if (!boundedConfigText(candidate.productLevel) || !Number.isSafeInteger(candidate.selectorVersion) || candidate.selectorVersion < 1
      || typeof candidate.release !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(candidate.release)
      || (candidate.status !== 'draft' && candidate.status !== 'verified')
      || !boundedConfigText(candidate.nameZh) || !boundedConfigText(candidate.nameLocal)
      || !boundedConfigText(candidate.administrativeScheme ?? candidate.productLevel)
      || !Number.isFinite(candidate.simplificationTolerance ?? 1e-10)
      || (candidate.simplificationTolerance ?? 1e-10) < 0
      || !Array.isArray(candidate.aliases ?? []) || candidate.aliases.some((alias) => !boundedConfigText(alias))) {
      throw new Error(`invalid reviewed country configuration: ${countryCode}`);
    }
    // The selector performs the full predicate/allow/deny validation. Calling it with no rows
    // validates the reviewed predicate without inferring an administrative level.
    selectCountryFeatures([], candidate);
    result[countryCode] = Object.freeze({
      ...candidate,
      administrativeScheme: candidate.administrativeScheme ?? candidate.productLevel,
      simplificationTolerance: candidate.simplificationTolerance ?? 1e-10,
      aliases: Object.freeze([...(candidate.aliases ?? [])]),
    });
  }
  return Object.freeze(result);
}

export function createCountryBuildConfigs({ registry, selectorsByCountry, countryCodes }) {
  assertExactKeys(registry, ['release', 'schemaVersion', 'nonSovereignExclusions', 'countries'], 'registry');
  if (!Array.isArray(registry.countries) || !Array.isArray(registry.nonSovereignExclusions)
    || typeof registry.release !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(registry.release)
    || !boundedConfigText(registry.schemaVersion) || !Array.isArray(countryCodes)
    || !isPlainObject(selectorsByCountry)) {
    throw new Error('invalid registry');
  }
  const registryByCountry = new Map();
  for (const entry of registry.countries) {
    assertExactKeys(entry, [
      'sovereignCode', 'sourceCountryCodes', 'nameZh', 'nameLocal', 'auditRegion', 'worldGeometryIds',
      'productLevel', 'selectorVersion', 'overtureSelector', 'allowlist', 'denylist', 'expectedCount',
      'officialReferences', 'perspective', 'auditedAt', 'status',
    ], 'registry country');
    if (typeof entry.sovereignCode !== 'string' || registryByCountry.has(entry.sovereignCode)) {
      throw new Error('invalid registry country');
    }
    registryByCountry.set(entry.sovereignCode, entry);
  }
  const result = {};
  for (const countryCode of countryCodes) {
    if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode) || result[countryCode] !== undefined) {
      throw new Error('invalid requested country');
    }
    const entry = registryByCountry.get(countryCode);
    const selector = selectorsByCountry[countryCode];
    if (entry === undefined || !isPlainObject(selector)) throw new Error(`country scheme is not configured: ${countryCode}`);
    assertExactKeys(selector, [
      'schemaVersion', 'release', 'sovereignCode', 'status', 'productLevel', 'overtureSelector',
      'expectedCount', 'officialReferences', 'allowlist', 'denylist', 'sampleApplicability', 'samples',
    ], 'selector');
    if (selector.schemaVersion !== 1 || selector.release !== registry.release || selector.sovereignCode !== countryCode
      || selector.status !== 'draft' || selector.productLevel !== entry.productLevel
      || canonicalJson(selector.overtureSelector) !== canonicalJson(entry.overtureSelector)
      || canonicalJson(selector.allowlist) !== canonicalJson(entry.allowlist)
      || canonicalJson(selector.denylist) !== canonicalJson(entry.denylist)) {
      throw new Error(`registry selector mismatch: ${countryCode}`);
    }
    result[countryCode] = {
      sovereignCode: entry.sovereignCode,
      sourceCountryCodes: entry.sourceCountryCodes,
      productLevel: entry.productLevel,
      selectorVersion: entry.selectorVersion,
      release: registry.release,
      status: entry.status,
      overtureSelector: selector.overtureSelector,
      allowlist: selector.allowlist,
      denylist: selector.denylist,
      administrativeScheme: entry.productLevel,
      simplificationTolerance: 1e-10,
      nameZh: entry.nameZh,
      nameLocal: entry.nameLocal,
      aliases: [],
    };
  }
  return validateCountryConfigs(result);
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}`);
  const whitelist = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !whitelist.has(key));
  if (unknown !== undefined) throw new Error(`unknown ${label} key: ${unknown}`);
}

async function loadCliCountryConfigs(inputDir) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const countryCodes = entries.filter((entry) => entry.isFile() && /^[A-Z]{2}\.geojson$/.test(entry.name))
    .map(({ name }) => name.slice(0, 2)).sort((left, right) => left.localeCompare(right, 'en'));
  const auditRoot = path.resolve('data-audit');
  const registry = parseJson(await readFile(path.join(auditRoot, 'sovereign-registry.json'), 'utf8'), 'sovereign-registry.json');
  const selectorsByCountry = {};
  for (const countryCode of countryCodes) {
    selectorsByCountry[countryCode] = parseJson(
      await readFile(path.join(auditRoot, 'selectors', `${countryCode}.json`), 'utf8'),
      `${countryCode} selector`,
    );
  }
  return createCountryBuildConfigs({ registry, selectorsByCountry, countryCodes });
}

function boundedConfigText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && [...value].length <= 160
    && ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
    });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function bindManifestToFinalPackageBytes(outputDir, manifest) {
  for (const countryCode of Object.keys(manifest).sort((left, right) => left.localeCompare(right, 'en'))) {
    const bytes = await readFile(path.join(outputDir, `${countryCode}.topojson`));
    if (bytes.byteLength === 0) throw new Error(`final package is empty: ${countryCode}`);
    manifest[countryCode].byteSize = bytes.byteLength;
    manifest[countryCode].checksum = createHash('sha256').update(bytes).digest('hex');
  }
}

async function stageBoundAuditReports({ auditReports, manifest, outputDir }) {
  if (auditReports === null || typeof auditReports !== 'object' || Array.isArray(auditReports)) {
    throw new Error('auditReports must be an object');
  }
  const { reportsDir, evidenceByCountry, expectedSelectorVersions, sourceRelease, generatorCommit } = auditReports;
  if (typeof reportsDir !== 'string' || evidenceByCountry === null || typeof evidenceByCountry !== 'object'
    || Array.isArray(evidenceByCountry) || expectedSelectorVersions === null
    || typeof expectedSelectorVersions !== 'object' || Array.isArray(expectedSelectorVersions)) {
    throw new Error('invalid auditReports configuration');
  }
  const countries = Object.keys(manifest).sort((left, right) => left.localeCompare(right, 'en'));
  if (!sameStringSet(countries, Object.keys(evidenceByCountry))
    || !sameStringSet(countries, Object.keys(expectedSelectorVersions))) {
    throw new Error('audit report country set mismatch');
  }
  const reportsParent = path.dirname(reportsDir);
  const reportsName = path.basename(reportsDir);
  if (reportsName.length === 0 || reportsName === '.' || reportsName === path.sep) {
    throw new Error('invalid audit reports directory');
  }
  await mkdir(reportsParent, { recursive: true });
  const stagingDir = path.join(reportsParent, `.${reportsName}.${process.pid}.${randomUUID()}.staging`);
  try {
    const reportPaths = [];
    for (const countryCode of countries) {
      const reportPath = path.join(stagingDir, `${countryCode}.json`);
      await writeCountryAuditReport({
        packagePath: path.join(outputDir, `${countryCode}.topojson`),
        reportPath,
        manifestEntry: manifest[countryCode],
        evidence: evidenceByCountry[countryCode],
        expectedSelectorVersion: expectedSelectorVersions[countryCode],
      });
      reportPaths.push(reportPath);
    }
    await writeAuditSummary({
      reportPaths,
      outputPath: path.join(stagingDir, 'summary.json'),
      sourceRelease,
      generatorCommit,
    });
    return { stagingDir, destinationDir: reportsDir };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function createSiblingStagingDirectory(destinationDir) {
  const destinationName = path.basename(destinationDir);
  if (destinationName.length === 0 || destinationName === '.' || destinationName === path.sep) {
    throw new Error('invalid output directory');
  }
  const parent = path.dirname(destinationDir);
  await mkdir(parent, { recursive: true });
  return path.join(parent, `.${destinationName}.${process.pid}.${randomUUID()}.staging`);
}

export async function promoteDirectorySet(entries, { renamePath = rename } = {}) {
  const destinations = entries.map(({ destinationDir }) => path.resolve(destinationDir));
  if (new Set(destinations).size !== destinations.length) throw new Error('duplicate release destination');
  const prepared = [];
  try {
    for (const entry of entries) {
      const destinationStat = await stat(entry.destinationDir).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (destinationStat !== null && !destinationStat.isDirectory()) {
        throw new Error('release destination must be a directory');
      }
      prepared.push({ ...entry, destinationStat, backupDir: undefined, promoted: false });
    }
    for (const entry of prepared) {
      if (entry.destinationStat === null) continue;
      const backupDir = path.join(
        path.dirname(entry.destinationDir),
        `.${path.basename(entry.destinationDir)}.${process.pid}.${randomUUID()}.backup`,
      );
      await renamePath(entry.destinationDir, backupDir);
      entry.backupDir = backupDir;
    }
    for (const entry of prepared) {
      await renamePath(entry.stagingDir, entry.destinationDir);
      entry.promoted = true;
    }
  } catch (error) {
    let rollbackError;
    for (const entry of [...prepared].reverse()) {
      try {
        if (entry.promoted) await rm(entry.destinationDir, { recursive: true, force: true });
        if (entry.backupDir !== undefined) await renamePath(entry.backupDir, entry.destinationDir);
      } catch (candidate) {
        rollbackError ??= candidate;
      }
    }
    await Promise.allSettled(entries.map(({ stagingDir }) => rm(stagingDir, { recursive: true, force: true })));
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        'release directory promotion and rollback failed',
        { cause: error },
      );
    }
    throw error;
  }
  await Promise.all(prepared.map(({ backupDir }) => (
    backupDir === undefined ? Promise.resolve() : rm(backupDir, { recursive: true, force: true })
  )));
}

function assertSeparateReleaseDirectories(outputDir, reportsDir) {
  if (typeof reportsDir !== 'string') return;
  const output = path.resolve(outputDir);
  const reports = path.resolve(reportsDir);
  if (output === reports || output.startsWith(`${reports}${path.sep}`) || reports.startsWith(`${output}${path.sep}`)) {
    throw new Error('output and audit reports directories must be separate');
  }
}

function isPathInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function sameStringSet(expected, actual) {
  return expected.length === actual.length
    && [...actual].sort((left, right) => left.localeCompare(right, 'en')).every((value, index) => value === expected[index]);
}

async function atomicWriteText(outputPath, contents) {
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

function toSelectorRows(collection) {
  if (!collection || !Array.isArray(collection.features)) return [];
  return collection.features.map((feature) => ({
    divisionId: feature?.properties?.divisionId ?? feature?.id,
    divisionAreaId: feature?.id,
    sovereignCountryCode: feature?.properties?.country,
    sourceCountryCode: feature?.properties?.sourceCountryCode ?? feature?.properties?.country,
    subtype: feature?.properties?.subtype,
    adminLevel: feature?.properties?.adminLevel ?? feature?.properties?.admin_level,
    localType: feature?.properties?.localType ?? feature?.properties?.local_type,
    isLand: feature?.properties?.isLand ?? feature?.properties?.is_land ?? true,
    names: feature?.properties?.names,
    aliases: feature?.properties?.aliases,
    geometry: feature?.geometry,
  }));
}

function toSelectedFeatureCollection(original, selected) {
  return {
    type: 'FeatureCollection',
    metadata: original.metadata,
    features: selected.map((row) => ({
      type: 'Feature',
      id: row.divisionAreaId,
      properties: {
        divisionId: row.divisionId,
        country: row.sovereignCode,
        subtype: row.productLevel,
        names: row.names,
        aliases: row.aliases,
      },
      geometry: row.geometry,
    })),
  };
}

function indexIdentity(record) {
  return record.kind === 'country' ? `0:${record.countryCode}` : `1:${record.areaId}`;
}

function assertIndexParity(records, outputs) {
  const packageIds = new Set();
  for (const [fileName, bytes] of outputs) {
    const packageObject = JSON.parse(bytes.toString('utf8'));
    for (const geometry of packageObject.objects.areas.geometries) {
      const areaId = geometry.properties?.areaId;
      if (typeof areaId !== 'string' || packageIds.has(areaId)) throw new Error(`duplicate or missing package area ID in ${fileName}`);
      packageIds.add(areaId);
    }
  }
  const indexAreaIds = records.filter(({ kind }) => kind === 'area').map(({ areaId }) => areaId);
  if (indexAreaIds.length !== packageIds.size || indexAreaIds.some((areaId) => !packageIds.has(areaId))) {
    throw new Error('area index IDs do not match country packages');
  }
}

function escapeInlineScript(value) {
  return value.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function createTopologyPackage(countryCode, config, metadata, collection) {
  let result = topology({ areas: collection }, QUANTIZATION);
  result = presimplify(result);
  result = simplify(result, config.simplificationTolerance);
  return {
    type: 'Topology',
    schemaVersion: 1,
    countryCode,
    boundaryVersion: metadata.boundaryVersion,
    administrativeScheme: config.administrativeScheme,
    source: metadata.source,
    attribution: metadata.attribution,
    objects: result.objects,
    arcs: result.arcs,
    ...(result.transform === undefined ? {} : { transform: result.transform }),
    ...(result.bbox === undefined ? {} : { bbox: result.bbox }),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('cannot serialize undefined');
  return serialized;
}

function parseJson(raw, fileName) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${fileName}`);
  }
}

function parseCliArguments(argv) {
  if ((argv.length !== 4 && argv.length !== 6) || argv[0] !== '--input' || argv[2] !== '--output' || (argv.length === 6 && argv[4] !== '--index-module')) {
    throw new Error('usage: node scripts/build-country-boundaries.mjs --input <dir> --output <dir> [--index-module <file>]');
  }
  return { inputDir: path.resolve(argv[1]), outputDir: path.resolve(argv[3]), ...(argv[5] === undefined ? {} : { indexModulePath: path.resolve(argv[5]) }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCliArguments(process.argv.slice(2));
  loadCliCountryConfigs(options.inputDir)
    .then((countryConfigs) => buildCountryBoundaries({ ...options, countryConfigs }))
    .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'boundary build failed'}\n`);
    process.exitCode = 1;
  });
}
