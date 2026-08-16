import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { verifyCrossCountry } from './verify-cross-country.mjs';

const RELEASE = '2026-06-17.0';
const ATTRIBUTION = '© OpenStreetMap contributors, Overture Maps Foundation · ODbL 1.0';

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function area(countryCode, id, name = `${countryCode} ${id}`) {
  return {
    areaId: `${countryCode}:overture:${id}`, countryCode, sourceId: id, adminLevel: 'city',
    nameZh: `中${name}`, nameLocal: name, aliases: [`${name} alias`], centroid: [0.5, 0.5],
  };
}

function packageValue(countryCode, areas, release = RELEASE) {
  return {
    type: 'Topology', schemaVersion: 1, countryCode, boundaryVersion: release,
    administrativeScheme: 'city-equivalent', source: 'overture', attribution: ATTRIBUTION,
    objects: {
      areas: {
        type: 'GeometryCollection', geometries: areas.map((properties, index) => ({
          type: 'Polygon', properties, arcs: [[index]],
        })),
      },
    },
    arcs: areas.map(() => [[0, 0], [1, 0], [0, 1], [0, 0]]),
  };
}

async function makeFixture({ countries = [
  { sovereignCode: 'AA', sourceCountryCodes: ['AA'], areas: [area('AA', 'one')] },
  { sovereignCode: 'BB', sourceCountryCodes: ['BB'], areas: [area('BB', 'two')] },
] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cross-country-'));
  const packagesDir = path.join(root, 'packages');
  const registryPath = path.join(root, 'registry.json');
  await mkdir(packagesDir);
  const manifest = {};
  const index = [];
  const values = new Map();
  for (const country of countries) {
    const value = packageValue(country.sovereignCode, country.areas, country.release);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`);
    values.set(country.sovereignCode, value);
    await writeFile(path.join(packagesDir, `${country.sovereignCode}.topojson`), bytes);
    manifest[country.sovereignCode] = {
      schemaVersion: 1, countryCode: country.sovereignCode,
      boundaryVersion: country.release ?? RELEASE, administrativeScheme: 'city-equivalent',
      featureCount: country.areas.length, byteSize: bytes.byteLength,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      updatedAt: '2026-08-16T00:00:00.000Z', source: 'overture', attribution: ATTRIBUTION,
    };
    index.push({
      kind: 'country', countryCode: country.sovereignCode, boundaryVersion: country.release ?? RELEASE,
      nameLocal: country.sovereignCode, aliases: [],
    });
    for (const record of country.areas) index.push({
      kind: 'area', areaId: record.areaId, countryCode: country.sovereignCode,
      boundaryVersion: country.release ?? RELEASE, adminLevel: record.adminLevel,
      nameZh: record.nameZh, nameLocal: record.nameLocal, aliases: record.aliases,
    });
  }
  await writeFile(path.join(packagesDir, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  await writeFile(path.join(packagesDir, 'area-index.json'), `${canonicalJson(index)}\n`);
  await writeFile(registryPath, `${canonicalJson({
    release: RELEASE, schemaVersion: 'v1.17.0', countries: countries.map((country) => ({
      sovereignCode: country.sovereignCode, sourceCountryCodes: country.sourceCountryCodes,
    })),
  })}\n`);
  const validatorCalls = [];
  const validatePackage = async (bytes, entry) => {
    validatorCalls.push({ countryCode: entry.countryCode, bytes: bytes.byteLength });
    const value = JSON.parse(bytes.toString('utf8'));
    return {
      countryCode: value.countryCode, boundaryVersion: value.boundaryVersion,
      features: value.objects.areas.geometries.map(({ properties }) => ({ properties })),
    };
  };
  return {
    root, packagesDir, registryPath, values, validatorCalls,
    options: { release: RELEASE, packagesDir, registryPath, validatePackage },
  };
}

async function rewriteJson(filePath, mutate) {
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  mutate(value);
  await writeFile(filePath, `${canonicalJson(value)}\n`);
}

function has(result, code, countryCode = 'GLOBAL') {
  return result.failures.some((failure) => failure.code === code && failure.countryCode === countryCode);
}

test('returns a deterministic verified canonical summary while processing one package at a time', async () => {
  const fixture = await makeFixture();
  try {
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.metrics.countryCount, 2);
    assert.equal(result.metrics.featureCount, 2);
    assert.equal(result.metrics.divisionIdCount, 2);
    assert.equal(result.metrics.indexAreaCount, 2);
    assert.equal(result.metrics.processingMode, 'sequential-packages');
    assert.deepEqual(fixture.validatorCalls.map(({ countryCode }) => countryCode), ['AA', 'BB']);
    assert.deepEqual(result.canonicalSummaryInput.countries.map(({ countryCode }) => countryCode), ['AA', 'BB']);
    assert.equal(canonicalJson(result), canonicalJson(await verifyCrossCountry(fixture.options)));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('accepts a complete fixture through the real Chromium-compatible runtime validator', async () => {
  const fixture = await makeFixture();
  try {
    const result = await verifyCrossCountry({ ...fixture.options, validatePackage: undefined });
    assert.equal(result.status, 'verified');
    assert.equal(result.metrics.indexAreaCount, 2);
    assert.equal(result.metrics.featureCount, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects one source country code owned by two sovereign packages', async () => {
  const fixture = await makeFixture({ countries: [
    { sovereignCode: 'AA', sourceCountryCodes: ['AA', 'CC'], areas: [area('AA', 'one')] },
    { sovereignCode: 'BB', sourceCountryCodes: ['BB', 'CC'], areas: [area('BB', 'two')] },
  ] });
  try {
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(result.status, 'failed');
    assert.equal(has(result, 'SOURCE_OWNER_DUPLICATE'), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a divisionId reused across countries', async () => {
  const fixture = await makeFixture({ countries: [
    { sovereignCode: 'AA', sourceCountryCodes: ['AA'], areas: [area('AA', 'shared')] },
    { sovereignCode: 'BB', sourceCountryCodes: ['BB'], areas: [area('BB', 'shared')] },
  ] });
  try {
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(has(result, 'DIVISION_ID_DUPLICATE', 'BB'), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires exact area index IDs and package names', async () => {
  const fixture = await makeFixture();
  try {
    await rewriteJson(path.join(fixture.packagesDir, 'area-index.json'), (index) => {
      index.find((record) => record.kind === 'area' && record.countryCode === 'AA').nameLocal = 'Wrong';
      index.splice(index.findIndex((record) => record.kind === 'area' && record.countryCode === 'BB'), 1);
      index.push({
        kind: 'area', areaId: 'BB:overture:ghost', countryCode: 'BB', boundaryVersion: RELEASE,
        adminLevel: 'city', nameLocal: 'Ghost', aliases: [],
      });
    });
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(has(result, 'INDEX_NAME_MISMATCH', 'AA'), true);
    assert.equal(has(result, 'INDEX_ID_MISSING', 'BB'), true);
    assert.equal(has(result, 'INDEX_ID_EXTRA', 'BB'), true);
    assert.equal(result.metrics.indexAreaCount, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects mixed releases before accepting package identity', async () => {
  const fixture = await makeFixture({ countries: [
    { sovereignCode: 'AA', sourceCountryCodes: ['AA'], areas: [area('AA', 'one')] },
    { sovereignCode: 'BB', sourceCountryCodes: ['BB'], areas: [area('BB', 'two')], release: '2026-05-20.0' },
  ] });
  try {
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(has(result, 'PACKAGE_RELEASE_MISMATCH', 'BB'), true);
    assert.equal(has(result, 'INDEX_RELEASE_MISMATCH', 'BB'), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('warns above 5 MiB and hard-fails above 20 MiB using configurable fixture budgets', async () => {
  const fixture = await makeFixture();
  try {
    const manifest = JSON.parse(await readFile(path.join(fixture.packagesDir, 'manifest.json'), 'utf8'));
    const aaSize = manifest.AA.byteSize;
    const warning = await verifyCrossCountry({
      ...fixture.options,
      limits: { packageWarningBytes: aaSize - 1, packageHardBytes: aaSize + 1000, indexHardBytes: 1_000_000 },
    });
    assert.equal(warning.status, 'verified');
    assert.equal(warning.warnings.some(({ code }) => code === 'PACKAGE_SIZE_WARNING'), true);
    const failed = await verifyCrossCountry({
      ...fixture.options,
      limits: { packageWarningBytes: 1, packageHardBytes: aaSize - 1, indexHardBytes: 1_000_000 },
    });
    assert.equal(has(failed, 'PACKAGE_SIZE_HARD_LIMIT', 'AA'), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('enforces a bounded global index before parsing it', async () => {
  const fixture = await makeFixture();
  try {
    const size = (await readFile(path.join(fixture.packagesDir, 'area-index.json'))).byteLength;
    const result = await verifyCrossCountry({
      ...fixture.options,
      limits: { packageWarningBytes: 1_000_000, packageHardBytes: 2_000_000, indexHardBytes: size - 1 },
    });
    assert.equal(has(result, 'GLOBAL_INDEX_SIZE_HARD_LIMIT'), true);
    assert.equal(fixture.validatorCalls.length, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('checks package checksum and byte size before runtime validation', async () => {
  const fixture = await makeFixture();
  try {
    await rewriteJson(path.join(fixture.packagesDir, 'manifest.json'), (manifest) => {
      manifest.AA.checksum = '0'.repeat(64);
      manifest.BB.byteSize += 1;
    });
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(has(result, 'PACKAGE_CHECKSUM_MISMATCH', 'AA'), true);
    assert.equal(has(result, 'PACKAGE_SIZE_MISMATCH', 'BB'), true);
    assert.deepEqual(fixture.validatorCalls, []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('maps invalid JSON and unsafe TopoJSON to a stable runtime failure code', async () => {
  const fixture = await makeFixture();
  try {
    const packagePath = path.join(fixture.packagesDir, 'AA.topojson');
    const bytes = Buffer.from('{"type":"Topology","objects":');
    await writeFile(packagePath, bytes);
    await rewriteJson(path.join(fixture.packagesDir, 'manifest.json'), (manifest) => {
      manifest.AA.byteSize = bytes.byteLength;
      manifest.AA.checksum = createHash('sha256').update(bytes).digest('hex');
    });
    const result = await verifyCrossCountry({ ...fixture.options, validatePackage: undefined });
    assert.equal(has(result, 'PACKAGE_RUNTIME_INVALID', 'AA'), true);
    assert.equal(result.failures.every(({ detail }) => detail === undefined), true);

    const unsafe = packageValue('AA', [area('AA', 'one')]);
    unsafe.objects.areas.geometries[0].type = 'LineString';
    const unsafeBytes = Buffer.from(`${canonicalJson(unsafe)}\n`);
    await writeFile(packagePath, unsafeBytes);
    await rewriteJson(path.join(fixture.packagesDir, 'manifest.json'), (manifest) => {
      manifest.AA.byteSize = unsafeBytes.byteLength;
      manifest.AA.checksum = createHash('sha256').update(unsafeBytes).digest('hex');
    });
    const topologyResult = await verifyCrossCountry({ ...fixture.options, validatePackage: undefined });
    assert.equal(has(topologyResult, 'PACKAGE_RUNTIME_INVALID', 'AA'), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects symlinked package inputs without exposing filesystem paths', async () => {
  const fixture = await makeFixture();
  try {
    const target = path.join(fixture.root, 'outside.topojson');
    await writeFile(target, await readFile(path.join(fixture.packagesDir, 'AA.topojson')));
    await rm(path.join(fixture.packagesDir, 'AA.topojson'));
    await symlink(target, path.join(fixture.packagesDir, 'AA.topojson'));
    const result = await verifyCrossCountry(fixture.options);
    assert.equal(has(result, 'PACKAGE_INPUT_UNSAFE', 'AA'), true);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a symlinked package directory before reading its metadata', async () => {
  const fixture = await makeFixture();
  try {
    const linkedPackages = path.join(fixture.root, 'linked-packages');
    await symlink(fixture.packagesDir, linkedPackages, 'dir');
    const result = await verifyCrossCountry({ ...fixture.options, packagesDir: linkedPackages });
    assert.equal(has(result, 'PACKAGE_DIRECTORY_INPUT_UNSAFE'), true);
    assert.equal(fixture.validatorCalls.length, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
