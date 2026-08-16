import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { buildCountryBoundaries, promoteDirectorySet } from './build-country-boundaries.mjs';
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

test('builder consumes selector output and derives package/index identity from divisionId', async () => {
  const inputDir = await mkdtemp(path.join(tmpdir(), 'selected-input-'));
  const outputDir = await mkdtemp(path.join(tmpdir(), 'selected-output-'));
  try {
    const input = await fixture();
    input.features[0].properties.divisionId = 'stable-beijing';
    input.features.push({
      ...JSON.parse(JSON.stringify(input.features[0])),
      id: 'excluded-region-area',
      properties: {
        ...input.features[0].properties,
        divisionId: 'excluded-region',
        subtype: 'region',
      },
    });
    await writeFile(path.join(inputDir, 'CN.geojson'), JSON.stringify(input));

    const manifest = await buildCountryBoundaries({ inputDir, outputDir });
    const topology = JSON.parse(await readFile(path.join(outputDir, 'CN.topojson'), 'utf8'));
    const index = JSON.parse(await readFile(path.join(outputDir, 'area-index.json'), 'utf8'));

    assert.equal(manifest.CN.featureCount, 2);
    assert.ok(topology.objects.areas.geometries.some(({ properties }) => properties.sourceId === 'stable-beijing'));
    assert.ok(index.some(({ kind, areaId }) => kind === 'area' && areaId === 'CN:overture:stable-beijing'));
    assert.ok(!index.some(({ kind, areaId }) => kind === 'area' && areaId === 'CN:overture:excluded-region'));
  } finally {
    await Promise.all([rm(inputDir, { recursive: true, force: true }), rm(outputDir, { recursive: true, force: true })]);
  }
});

test('builder accepts extractor camelCase properties while preserving the division identity chain', async () => {
  const inputDir = await mkdtemp(path.join(tmpdir(), 'extractor-shape-input-'));
  const outputDir = await mkdtemp(path.join(tmpdir(), 'extractor-shape-output-'));
  try {
    const input = await fixture();
    input.features = input.features.map((feature, index) => {
      const properties = { ...feature.properties };
      delete properties.admin_level;
      properties.divisionId = `extractor-division-${index}`;
      properties.sourceCountryCode = 'CN';
      properties.adminLevel = 2;
      properties.localType = 'prefecture';
      return { ...feature, id: `extractor-area-${index}`, properties };
    });
    await writeFile(path.join(inputDir, 'CN.geojson'), JSON.stringify(input));

    const manifest = await buildCountryBoundaries({ inputDir, outputDir });
    const topology = JSON.parse(await readFile(path.join(outputDir, 'CN.topojson'), 'utf8'));
    const index = JSON.parse(await readFile(path.join(outputDir, 'area-index.json'), 'utf8'));
    const packageIds = topology.objects.areas.geometries.map(({ properties }) => properties.areaId);
    const indexIds = index.filter(({ kind }) => kind === 'area').map(({ areaId }) => areaId);

    assert.equal(manifest.CN.featureCount, 2);
    assert.deepEqual(packageIds, ['CN:overture:extractor-division-0', 'CN:overture:extractor-division-1']);
    assert.deepEqual(indexIds, packageIds);
  } finally {
    await Promise.all([rm(inputDir, { recursive: true, force: true }), rm(outputDir, { recursive: true, force: true })]);
  }
});

test('builder binds optional audit reports and summary to bytes read back from final packages', async () => {
  const inputDir = await mkdtemp(path.join(tmpdir(), 'evidence-input-'));
  const outputDir = await mkdtemp(path.join(tmpdir(), 'evidence-output-'));
  const reportsDir = await mkdtemp(path.join(tmpdir(), 'evidence-reports-'));
  try {
    const input = await fixture();
    input.metadata.boundaryVersion = '2026-06-17.0';
    await writeFile(path.join(inputDir, 'CN.geojson'), JSON.stringify(input));
    const reportEvidenceByCountry = {
      CN: {
        schemaVersion: 1,
        countryCode: 'CN',
        status: 'verified',
        sourceRelease: '2026-06-17.0',
        selectorVersion: 4,
        productLevel: 'prefecture',
        sourceCountryCodes: ['CN'],
        counts: { source: 2, selected: 2, excluded: 0, allowlisted: 0, denylisted: 0 },
        geometry: { invalid: 0, duplicate: 0, overlap: 0, missingName: 0 },
        vertices: { p50: 5, p95: 5, max: 5 },
        compressedBytes: { topojson: 0, gzip: 0, brotli: 0 },
        performanceMs: { extract: 1, select: 1, audit: 1, build: 1, parse: 1 },
        exceptions: [],
        references: [{
          title: '中华人民共和国行政区划代码', url: 'https://www.mca.gov.cn/mzsj/xzqh/',
          retrievedOn: '2026-08-16', license: '中华人民共和国民政部公开信息',
        }],
        generatorCommit: '0123456789abcdef0123456789abcdef01234567',
        auditedOn: '2026-08-16',
        attribution: '© Overture Maps Foundation contributors; data available under ODbL 1.0',
      },
    };
    const manifestResult = await buildCountryBoundaries({
      inputDir,
      outputDir,
      auditReports: {
        reportsDir,
        evidenceByCountry: reportEvidenceByCountry,
        expectedSelectorVersions: { CN: 4 },
        sourceRelease: '2026-06-17.0',
        generatorCommit: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    const diskManifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
    const report = JSON.parse(await readFile(path.join(reportsDir, 'CN.json'), 'utf8'));
    const summary = JSON.parse(await readFile(path.join(reportsDir, 'summary.json'), 'utf8'));
    const packageBytes = await readFile(path.join(outputDir, 'CN.topojson'));
    const diskChecksum = createHash('sha256').update(packageBytes).digest('hex');
    assert.equal(manifestResult.CN.checksum, diskChecksum);
    assert.equal(diskManifest.CN.checksum, diskChecksum);
    assert.equal(report.packageChecksum, diskChecksum);
    assert.equal(report.packageByteSize, packageBytes.byteLength);
    assert.equal(summary.countries[0].packageChecksum, diskChecksum);
  } finally {
    await Promise.all([
      rm(inputDir, { recursive: true, force: true }),
      rm(outputDir, { recursive: true, force: true }),
      rm(reportsDir, { recursive: true, force: true }),
    ]);
  }
});

test('builder leaves an existing audit report set byte-identical when any country evidence fails', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'evidence-rollback-'));
  const inputDir = path.join(rootDir, 'input');
  const outputDir = path.join(rootDir, 'output');
  const reportsDir = path.join(rootDir, 'reports');
  const existingCountry = Buffer.from('{"previous":"country"}\n');
  const existingUsCountry = Buffer.from('{"previous":"us-country"}\n');
  const existingSummary = Buffer.from('{"previous":"summary"}\n');
  const existingCnPackage = Buffer.from('{"previous":"cn-package"}\n');
  const existingUsPackage = Buffer.from('{"previous":"us-package"}\n');
  const existingManifest = Buffer.from('{"previous":"manifest"}\n');
  const existingIndex = Buffer.from('[{"previous":"index"}]\n');
  try {
    await Promise.all([mkdir(inputDir), mkdir(outputDir), mkdir(reportsDir)]);
    for (const countryCode of ['CN', 'US']) {
      const input = await fixture(countryCode);
      input.metadata.boundaryVersion = '2026-06-17.0';
      await writeFile(path.join(inputDir, `${countryCode}.geojson`), JSON.stringify(input));
    }
    await Promise.all([
      writeFile(path.join(outputDir, 'CN.topojson'), existingCnPackage),
      writeFile(path.join(outputDir, 'US.topojson'), existingUsPackage),
      writeFile(path.join(outputDir, 'manifest.json'), existingManifest),
      writeFile(path.join(outputDir, 'area-index.json'), existingIndex),
      writeFile(path.join(reportsDir, 'CN.json'), existingCountry),
      writeFile(path.join(reportsDir, 'US.json'), existingUsCountry),
      writeFile(path.join(reportsDir, 'summary.json'), existingSummary),
    ]);

    const baseEvidence = {
      schemaVersion: 1,
      status: 'verified',
      sourceRelease: '2026-06-17.0',
      selectorVersion: 4,
      counts: { source: 2, selected: 2, excluded: 0, allowlisted: 0, denylisted: 0 },
      geometry: { invalid: 0, duplicate: 0, overlap: 0, missingName: 0 },
      vertices: { p50: 5, p95: 5, max: 5 },
      compressedBytes: { topojson: 0, gzip: 0, brotli: 0 },
      performanceMs: { extract: 1, select: 1, audit: 1, build: 1, parse: 1 },
      exceptions: [],
      references: [{
        title: 'Official administrative reference', url: 'https://example.gov/reference',
        retrievedOn: '2026-08-16', license: 'Public information',
      }],
      generatorCommit: '0123456789abcdef0123456789abcdef01234567',
      auditedOn: '2026-08-16',
      attribution: '© Overture Maps Foundation contributors; data available under ODbL 1.0',
    };

    await assert.rejects(
      buildCountryBoundaries({
        inputDir,
        outputDir,
        auditReports: {
          reportsDir,
          evidenceByCountry: {
            CN: { ...baseEvidence, countryCode: 'CN', productLevel: 'prefecture', sourceCountryCodes: ['CN'] },
            US: { ...baseEvidence, countryCode: 'US', productLevel: 'county-equivalent', sourceCountryCodes: ['US'], selectorVersion: 3 },
          },
          expectedSelectorVersions: { CN: 4, US: 4 },
          sourceRelease: '2026-06-17.0',
          generatorCommit: '0123456789abcdef0123456789abcdef01234567',
        },
      }),
      /selector version mismatch/i,
    );

    assert.deepEqual(await readFile(path.join(reportsDir, 'CN.json')), existingCountry);
    assert.deepEqual(await readFile(path.join(reportsDir, 'US.json')), existingUsCountry);
    assert.deepEqual(await readFile(path.join(reportsDir, 'summary.json')), existingSummary);
    assert.deepEqual(await readFile(path.join(outputDir, 'CN.topojson')), existingCnPackage);
    assert.deepEqual(await readFile(path.join(outputDir, 'US.topojson')), existingUsPackage);
    assert.deepEqual(await readFile(path.join(outputDir, 'manifest.json')), existingManifest);
    assert.deepEqual(await readFile(path.join(outputDir, 'area-index.json')), existingIndex);
    assert.deepEqual((await readdir(rootDir)).sort(), ['input', 'output', 'reports']);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('builder leaves no output or temporary artifacts when a first audited build fails', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'evidence-first-failure-'));
  const inputDir = path.join(rootDir, 'input');
  const outputDir = path.join(rootDir, 'output');
  const reportsDir = path.join(rootDir, 'reports');
  try {
    await mkdir(inputDir);
    const input = await fixture();
    input.metadata.boundaryVersion = '2026-06-17.0';
    await writeFile(path.join(inputDir, 'CN.geojson'), JSON.stringify(input));

    await assert.rejects(
      buildCountryBoundaries({
        inputDir,
        outputDir,
        auditReports: {
          reportsDir,
          evidenceByCountry: { CN: {} },
          expectedSelectorVersions: { CN: 4 },
          sourceRelease: '2026-06-17.0',
          generatorCommit: '0123456789abcdef0123456789abcdef01234567',
        },
      }),
      /report .*required|unknown report key/i,
    );

    assert.deepEqual(await readdir(rootDir), ['input']);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('directory promotion restores every backup and removes staging if the second destination switch fails', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'evidence-promotion-failure-'));
  const outputDir = path.join(rootDir, 'output');
  const reportsDir = path.join(rootDir, 'reports');
  const outputStagingDir = path.join(rootDir, '.output.staging');
  const reportsStagingDir = path.join(rootDir, '.reports.staging');
  try {
    await Promise.all([mkdir(outputDir), mkdir(reportsDir), mkdir(outputStagingDir), mkdir(reportsStagingDir)]);
    await Promise.all([
      writeFile(path.join(outputDir, 'old'), 'old-output'),
      writeFile(path.join(reportsDir, 'old'), 'old-reports'),
      writeFile(path.join(outputStagingDir, 'new'), 'new-output'),
      writeFile(path.join(reportsStagingDir, 'new'), 'new-reports'),
    ]);
    let renameCount = 0;
    const failSecondPromotion = async (from, to) => {
      renameCount += 1;
      if (renameCount === 4) throw new Error('injected second promotion failure');
      await rename(from, to);
    };

    await assert.rejects(
      promoteDirectorySet([
        { stagingDir: outputStagingDir, destinationDir: outputDir },
        { stagingDir: reportsStagingDir, destinationDir: reportsDir },
      ], { renamePath: failSecondPromotion }),
      /injected second promotion failure/,
    );

    assert.equal(await readFile(path.join(outputDir, 'old'), 'utf8'), 'old-output');
    assert.equal(await readFile(path.join(reportsDir, 'old'), 'utf8'), 'old-reports');
    assert.deepEqual((await readdir(rootDir)).sort(), ['output', 'reports']);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

function signedArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}
