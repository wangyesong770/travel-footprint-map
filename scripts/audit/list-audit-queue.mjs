#!/usr/bin/env node

import { open, readdir, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const ISO2 = /^[A-Z]{2}$/;
const WORLD_ID = /^[A-Z0-9-]{2,4}$/;
const CHINA_SOURCE_CODES = ['CN', 'HK', 'MO', 'TW'];
const MAX_SNAPSHOT_METADATA_BYTES = 1024 * 1024;
const NON_SOVEREIGN_POLICIES = Object.freeze({
  antarctica: Object.freeze({ sourceCountryCodes: ['AQ'], worldGeometryIds: ['AQ'] }),
  'bir-tawil': Object.freeze({ sourceCountryCodes: [], worldGeometryIds: ['BRT'] }),
  'brazilian-island': Object.freeze({ sourceCountryCodes: [], worldGeometryIds: ['BRI'] }),
});

const compare = (left, right) => left.localeCompare(right, 'en');

function requireCountryCode(value, label) {
  if (typeof value !== 'string' || !ISO2.test(value)) throw new Error(`INVALID_${label}`);
  return value;
}

function sortedUnique(values, label) {
  if (!Array.isArray(values)) throw new Error(`INVALID_${label}`);
  const normalized = values.map((value) => requireCountryCode(value, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`DUPLICATE_${label}`);
  return normalized.sort(compare);
}

function artifactStatus(codes, sovereignCode) {
  return codes.has(sovereignCode) ? 'present' : 'missing';
}

export function parseWorldMapIds(source) {
  if (typeof source !== 'string' || source.length === 0) throw new Error('WORLD_MAP_INVALID');
  const ids = [...source.matchAll(/\{"id":"([^"]+)"/g)].map((match) => match[1]);
  if (ids.length === 0) throw new Error('WORLD_MAP_EMPTY');
  const seen = new Set();
  for (const id of ids) {
    if (!WORLD_ID.test(id)) throw new Error(`WORLD_ID_INVALID:${id}`);
    if (seen.has(id)) throw new Error(`WORLD_ID_DUPLICATE:${id}`);
    seen.add(id);
  }
  return ids.sort(compare);
}

export function buildAuditQueue({
  registry,
  release,
  overtureSourceCodes,
  worldCountryIds,
  selectorCodes,
  reportCodes,
  packageCodes,
}) {
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.countries)) {
    throw new Error('REGISTRY_INVALID');
  }
  if (registry.release !== release) throw new Error('RELEASE_MISMATCH');

  const errors = [];
  const countries = [...registry.countries];
  const sovereignOwners = new Map();
  const sourceOwners = new Map();
  const worldGeometryOwners = new Map();
  if (!Array.isArray(registry.nonSovereignExclusions)) throw new Error('EXCLUSIONS_INVALID');
  if (registry.nonSovereignExclusions.length < 1 || registry.nonSovereignExclusions.length > 3) {
    throw new Error('EXCLUSIONS_INVALID');
  }
  const excludedSourceCodes = new Set();
  const excludedWorldIds = new Set();
  const exclusionKeys = new Set();
  for (const exclusion of registry.nonSovereignExclusions) {
    const policy = NON_SOVEREIGN_POLICIES[exclusion?.key];
    if (!policy || exclusionKeys.has(exclusion.key)
      || JSON.stringify(exclusion.sourceCountryCodes) !== JSON.stringify(policy.sourceCountryCodes)
      || JSON.stringify(exclusion.worldGeometryIds) !== JSON.stringify(policy.worldGeometryIds)
      || typeof exclusion.reason !== 'string' || exclusion.reason.trim() !== exclusion.reason
      || exclusion.reason.length === 0
      || !Array.isArray(exclusion.officialReferences) || exclusion.officialReferences.length === 0
      || exclusion.officialReferences.some((reference) => {
        if (!reference || typeof reference !== 'object' || typeof reference.url !== 'string') return true;
        try {
          const url = new URL(reference.url);
          return url.protocol !== 'https:' || url.username !== '' || url.password !== '';
        } catch {
          return true;
        }
      })) {
      throw new Error('EXCLUSIONS_INVALID');
    }
    exclusionKeys.add(exclusion.key);
    for (const code of exclusion.sourceCountryCodes) excludedSourceCodes.add(code);
    for (const id of exclusion.worldGeometryIds) excludedWorldIds.add(id);
  }
  for (const config of countries) {
    const sovereignCode = requireCountryCode(config.sovereignCode, 'SOVEREIGN_CODE');
    if (sovereignOwners.has(sovereignCode)) {
      errors.push({ code: 'SOVEREIGN_DUPLICATE', id: sovereignCode });
    } else {
      sovereignOwners.set(sovereignCode, config);
    }
    if (['HK', 'MO', 'TW'].includes(sovereignCode)) {
      errors.push({ code: 'CHINA_SUBENTRY_FORBIDDEN', id: sovereignCode });
    }
    for (const sourceCode of sortedUnique(config.sourceCountryCodes, 'SOURCE_CODE')) {
      if (excludedSourceCodes.has(sourceCode)) {
        errors.push({ code: 'EXCLUDED_SOURCE_HAS_OWNER', id: sourceCode });
      }
      if (sourceOwners.has(sourceCode)) {
        errors.push({ code: 'SOURCE_OWNER_DUPLICATE', id: sourceCode });
      } else {
        sourceOwners.set(sourceCode, sovereignCode);
      }
    }
    if (!Array.isArray(config.worldGeometryIds)) throw new Error('INVALID_WORLD_GEOMETRY_IDS');
    for (const worldId of config.worldGeometryIds) {
      if (typeof worldId !== 'string' || !WORLD_ID.test(worldId)) {
        throw new Error('INVALID_WORLD_GEOMETRY_IDS');
      }
      if (worldGeometryOwners.has(worldId)) {
        errors.push({ code: 'WORLD_OWNER_DUPLICATE', id: worldId });
      } else {
        worldGeometryOwners.set(worldId, sovereignCode);
      }
      if (excludedWorldIds.has(worldId)) {
        errors.push({ code: 'EXCLUDED_WORLD_HAS_OWNER', id: worldId });
      }
    }
  }

  const china = sovereignOwners.get('CN');
  for (const code of CHINA_SOURCE_CODES) {
    if (!china?.sourceCountryCodes?.includes(code)) errors.push({ code: 'CHINA_SOURCE_MISSING', id: code });
  }

  const actualSourceCodes = new Set(sortedUnique(overtureSourceCodes, 'OVERTURE_SOURCE_CODE'));
  for (const sourceCode of actualSourceCodes) {
    if (!sourceOwners.has(sourceCode) && !excludedSourceCodes.has(sourceCode)) {
      errors.push({ code: 'SOURCE_OWNER_MISSING', id: sourceCode });
    }
  }
  for (const sourceCode of [...sourceOwners.keys()].sort(compare)) {
    if (!actualSourceCodes.has(sourceCode) && !excludedSourceCodes.has(sourceCode)) {
      errors.push({ code: 'SOURCE_MAPPING_STALE', id: sourceCode });
    }
  }

  const worldIds = [...worldCountryIds].sort(compare);
  for (const worldId of worldIds) {
    const owner = worldGeometryOwners.get(worldId);
    if ((!owner || !sovereignOwners.has(owner)) && !excludedWorldIds.has(worldId)) {
      errors.push({ code: 'WORLD_OWNER_MISSING', id: worldId });
    }
  }
  for (const worldId of [...worldGeometryOwners.keys()].sort(compare)) {
    if (!worldIds.includes(worldId)) errors.push({ code: 'WORLD_MAPPING_STALE', id: worldId });
  }
  for (const config of countries) {
    if (config.worldGeometryIds.length === 0) {
      errors.push({ code: 'WORLD_GEOMETRY_MISSING', id: config.sovereignCode });
    }
  }

  const selectors = new Set(sortedUnique(selectorCodes, 'SELECTOR_CODE'));
  const reports = new Set(sortedUnique(reportCodes, 'REPORT_CODE'));
  const packages = new Set(sortedUnique(packageCodes, 'PACKAGE_CODE'));
  for (const [set, code] of [
    [packages, 'PACKAGE_UNREGISTERED'],
    [reports, 'REPORT_UNREGISTERED'],
    [selectors, 'SELECTOR_UNREGISTERED'],
  ]) {
    for (const id of [...set].sort(compare)) {
      if (!sovereignOwners.has(id)) errors.push({ code, id });
    }
  }

  const rows = countries
    .map((config) => ({
      sovereignCode: config.sovereignCode,
      sourceCountryCodes: [...config.sourceCountryCodes].sort(compare),
      perspective: config.perspective,
      configStatus: config.status,
      selectorStatus: artifactStatus(selectors, config.sovereignCode),
      reportStatus: artifactStatus(reports, config.sovereignCode),
      packageStatus: artifactStatus(packages, config.sovereignCode),
    }))
    .sort((left, right) => compare(left.sovereignCode, right.sovereignCode));

  errors.sort((left, right) => compare(`${left.code}:${left.id}`, `${right.code}:${right.id}`));
  return { release, rows, errors };
}

async function artifactCodes(directory, suffix) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix) && !entry.name.startsWith('_'))
      .map((entry) => entry.name.slice(0, -suffix.length))
      .filter((code) => ISO2.test(code));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function parseAuditQueueArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--release', '--snapshot'].includes(key) || value === undefined || values.has(key)) {
      throw new Error('INVALID_ARGUMENTS');
    }
    values.set(key, value);
  }
  const release = values.get('--release');
  if (!release) throw new Error('RELEASE_REQUIRED');
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)) throw new Error('INVALID_RELEASE');
  const snapshot = values.get('--snapshot');
  if (!snapshot) throw new Error('SNAPSHOT_REQUIRED');
  return { release, snapshotDir: path.resolve(snapshot) };
}

export async function readSnapshotSourceCodes(snapshotDir, release) {
  let file;
  try {
    file = await open(path.join(snapshotDir, 'metadata.json'), 'r');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('SNAPSHOT_METADATA_MISSING', { cause: error });
    }
    throw new Error('SNAPSHOT_METADATA_INVALID', { cause: error });
  }
  let text;
  try {
    const buffer = Buffer.alloc(MAX_SNAPSHOT_METADATA_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead > MAX_SNAPSHOT_METADATA_BYTES) {
      throw new Error('SNAPSHOT_METADATA_INVALID');
    }
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new Error('SNAPSHOT_METADATA_INVALID');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || metadata.schemaVersion !== 1 || !metadata.rowCounts
    || typeof metadata.rowCounts !== 'object' || Array.isArray(metadata.rowCounts)) {
    throw new Error('SNAPSHOT_METADATA_INVALID');
  }
  if (metadata.release !== release) throw new Error('SNAPSHOT_RELEASE_MISMATCH');
  const unresolved = metadata.unresolved;
  if (!unresolved || typeof unresolved !== 'object' || Array.isArray(unresolved)
    || !Number.isSafeInteger(unresolved.rowCount) || unresolved.rowCount < 0
    || !Number.isSafeInteger(unresolved.byteSize) || unresolved.byteSize < 1
    || typeof unresolved.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unresolved.sha256)) {
    throw new Error('SNAPSHOT_METADATA_INVALID');
  }
  if (unresolved.rowCount > 0) throw new Error('SNAPSHOT_UNRESOLVED_ROWS');
  const codes = Object.keys(metadata.rowCounts).sort(compare);
  if (codes.length === 0) throw new Error('SNAPSHOT_METADATA_INVALID');
  for (const code of codes) {
    if (!ISO2.test(code) || !Number.isSafeInteger(metadata.rowCounts[code]) || metadata.rowCounts[code] < 1) {
      throw new Error('SNAPSHOT_METADATA_INVALID');
    }
  }
  return codes;
}

async function main() {
  const { release, snapshotDir } = parseAuditQueueArguments(process.argv.slice(2));
  const registry = JSON.parse(await readFile('data-audit/sovereign-registry.json', 'utf8'));
  const worldCountryIds = parseWorldMapIds(await readFile('src/generated/world-map.ts', 'utf8'));
  const selectorCodes = await artifactCodes('data-audit/selectors', '.json');
  const reportCodes = await artifactCodes(path.join('data-audit/reports', release), '.json');
  const packageCodes = await artifactCodes('public/data/countries', '.topojson');
  const overtureSourceCodes = await readSnapshotSourceCodes(snapshotDir, release);
  const result = buildAuditQueue({
    registry,
    release,
    overtureSourceCodes,
    worldCountryIds,
    selectorCodes,
    reportCodes,
    packageCodes,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
