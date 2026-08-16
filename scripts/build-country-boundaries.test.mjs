import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { buildCountryBoundaries } from './build-country-boundaries.mjs';
import { normalizeFeatureCollection } from './lib/boundary-normalize.mjs';

const fixtures = path.resolve('scripts/fixtures/boundaries');

const fixture = async (countryCode = 'CN') =>
  JSON.parse(await readFile(path.join(fixtures, `${countryCode}.geojson`), 'utf8'));

test('normalizes Overture identities, whitelist properties, winding, and stable ordering', async () => {
  const normalized = normalizeFeatureCollection(await fixture(), 'CN');
  assert.deepEqual(normalized.features.map(({ properties }) => properties.areaId), [
    'CN:overture:gers-cn-beijing',
    'CN:overture:gers-cn-shanghai',
  ]);
  assert.deepEqual(Object.keys(normalized.features[1].properties).sort(), [
    'adminLevel', 'aliases', 'areaId', 'centroid', 'countryCode', 'nameLocal', 'nameZh', 'sourceId',
  ]);
  assert.equal(normalized.features[1].properties.aliases[1], '<上海 & 海上>');
  const ring = normalized.features[1].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(signedArea(ring) > 0, 'outer ring is counter-clockwise');
});

test('rejects duplicate source IDs and wrong-country features', async () => {
  const duplicate = await fixture();
  duplicate.features.push(JSON.parse(JSON.stringify(duplicate.features[0])));
  assert.throws(() => normalizeFeatureCollection(duplicate, 'CN'), /duplicate source ID/i);

  const wrongCountry = await fixture();
  wrongCountry.features[0].properties.country = 'US';
  assert.throws(() => normalizeFeatureCollection(wrongCountry, 'CN'), /country mismatch/i);
});

test('rejects ambiguous source IDs instead of emitting an unparseable areaId', async () => {
  const input = await fixture();
  input.features[0].id = 'gers:cn:shanghai';
  assert.throws(() => normalizeFeatureCollection(input, 'CN'), /source ID/i);
});

test('rejects an Overture division subtype outside the configured country scheme', async () => {
  const input = await fixture();
  input.features[0].properties.subtype = 'county';
  assert.throws(
    () => normalizeFeatureCollection(input, 'CN', { acceptedLevels: ['prefecture'] }),
    /administrative level/i,
  );
});

test('rejects unsafe country paths, invalid coordinates, unclosed rings, and unsupported geometry', async () => {
  const valid = await fixture();
  assert.throws(() => normalizeFeatureCollection(valid, '../CN'), /country code/i);

  const invalidCoordinate = await fixture();
  invalidCoordinate.features[0].geometry.coordinates[0][1][0] = 181;
  assert.throws(() => normalizeFeatureCollection(invalidCoordinate, 'CN'), /coordinate/i);

  const unclosed = await fixture();
  unclosed.features[0].geometry.coordinates[0].pop();
  assert.throws(() => normalizeFeatureCollection(unclosed, 'CN'), /closed/i);

  const point = await fixture();
  point.features[0].geometry = { type: 'Point', coordinates: [121, 31] };
  assert.throws(() => normalizeFeatureCollection(point, 'CN'), /Polygon|MultiPolygon/);
});

test('emits consumable TopoJSON and byte-identical builds with matching SHA-256 metadata', async () => {
  const firstDir = await mkdtemp(path.join(tmpdir(), 'boundaries-a-'));
  const secondDir = await mkdtemp(path.join(tmpdir(), 'boundaries-b-'));
  try {
    const firstManifest = await buildCountryBoundaries({ inputDir: fixtures, outputDir: firstDir });
    const secondManifest = await buildCountryBoundaries({ inputDir: fixtures, outputDir: secondDir });
    assert.equal(firstManifest.CN.checksum, secondManifest.CN.checksum);
    assert.equal(firstManifest.CN.featureCount, 2);
    assert.match(firstManifest.CN.attribution, /Overture Maps Foundation/);
    for (const fileName of ['manifest.json', 'area-index.json', 'CN.topojson', 'US.topojson']) {
      assert.deepEqual(await readFile(path.join(firstDir, fileName)), await readFile(path.join(secondDir, fileName)));
    }

    const topology = JSON.parse(await readFile(path.join(firstDir, 'CN.topojson'), 'utf8'));
    assert.equal(topology.type, 'Topology');
    assert.ok(Array.isArray(topology.arcs));
    assert.equal(topology.objects.areas.type, 'GeometryCollection');
    assert.equal(topology.objects.areas.geometries.length, 2);
    assert.deepEqual(topology.objects.areas.geometries.map(({ properties }) => properties.areaId), [
      'CN:overture:gers-cn-beijing', 'CN:overture:gers-cn-shanghai',
    ]);
    const packageBytes = await readFile(path.join(firstDir, 'CN.topojson'));
    assert.equal(packageBytes.byteLength, firstManifest.CN.byteSize);
    assert.equal(createHash('sha256').update(packageBytes).digest('hex'), firstManifest.CN.checksum);
  } finally {
    await Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })]);
  }
});

test('emits a compact geometry-free index with exact package ID parity and deterministic safe source', async () => {
  const firstDir = await mkdtemp(path.join(tmpdir(), 'area-index-a-'));
  const secondDir = await mkdtemp(path.join(tmpdir(), 'area-index-b-'));
  const firstModule = path.join(firstDir, 'area-index.data.ts');
  const secondModule = path.join(secondDir, 'area-index.data.ts');
  try {
    const maliciousInput = await fixture();
    maliciousInput.features[0].properties.aliases.push('</script><script>alert(1)</script>');
    const inputDir = await mkdtemp(path.join(tmpdir(), 'area-index-input-'));
    try {
      await writeFile(path.join(inputDir, 'CN.geojson'), JSON.stringify(maliciousInput));
      await buildCountryBoundaries({ inputDir, outputDir: firstDir, indexModulePath: firstModule });
      await buildCountryBoundaries({ inputDir, outputDir: secondDir, indexModulePath: secondModule });

      const records = JSON.parse(await readFile(path.join(firstDir, 'area-index.json'), 'utf8'));
      const topology = JSON.parse(await readFile(path.join(firstDir, 'CN.topojson'), 'utf8'));
      const areaRecords = records.filter(({ kind }) => kind === 'area');
      assert.deepEqual(
        areaRecords.map(({ areaId }) => areaId),
        topology.objects.areas.geometries.map(({ properties }) => properties.areaId),
      );
      assert.ok(records.some(({ kind, countryCode }) => kind === 'country' && countryCode === 'CN'));
      assert.ok(areaRecords.every((record) => !('geometry' in record) && !('centroid' in record)));
      assert.equal(new Set(areaRecords.map(({ areaId }) => areaId)).size, areaRecords.length);

      const source = await readFile(firstModule, 'utf8');
      assert.doesNotMatch(source, /<\/script>/i);
      assert.match(source, /\\u003c\/script\\u003e/i);
      assert.deepEqual(await readFile(firstModule), await readFile(secondModule));
      assert.deepEqual(await readFile(path.join(firstDir, 'area-index.json')), await readFile(path.join(secondDir, 'area-index.json')));
    } finally {
      await rm(inputDir, { recursive: true, force: true });
    }
  } finally {
    await Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })]);
  }
});

test('CLI rejects input file path traversal through country names', async () => {
  const inputDir = await mkdtemp(path.join(tmpdir(), 'boundaries-input-'));
  const outputDir = await mkdtemp(path.join(tmpdir(), 'boundaries-output-'));
  try {
    await writeFile(path.join(inputDir, 'CN.geojson'), JSON.stringify(await fixture()));
    await writeFile(path.join(inputDir, 'CN.evil.geojson'), JSON.stringify(await fixture()));
    await assert.rejects(buildCountryBoundaries({ inputDir, outputDir }), /country file name/i);
  } finally {
    await Promise.all([rm(inputDir, { recursive: true, force: true }), rm(outputDir, { recursive: true, force: true })]);
  }
});

function signedArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}
