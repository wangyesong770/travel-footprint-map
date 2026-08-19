import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'vitest';

import { promoteCountryArtifacts, readGeoJsonSequence, runCountryAudit } from './country-runner.mjs';
import { buildCountryBoundaries } from '../build-country-boundaries.mjs';

const RELEASE = '2026-06-17.0';

test('reads GeoJSONSeq through a bounded line stream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'country-stream-'));
  const filePath = path.join(root, 'areas.geojsonseq');
  const feature = { type: 'Feature', properties: { divisionId: 'one' }, geometry: null };
  try {
    await writeFile(filePath, `${JSON.stringify(feature)}\n${JSON.stringify({ ...feature, properties: { divisionId: 'two' } })}\n`);
    const rows = await readGeoJsonSequence(filePath, { maximumBytes: 1024 });
    assert.deepEqual(rows.map(({ divisionId }) => divisionId), ['one', 'two']);
    await assert.rejects(() => readGeoJsonSequence(filePath, { maximumBytes: 16 }), /invalid extraction output/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reconstructs names flattened by the DuckDB GDAL GeoJSONSeq writer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'country-flattened-names-'));
  const filePath = path.join(root, 'areas.geojsonseq');
  const feature = {
    type: 'Feature',
    properties: {
      divisionId: 'parish-one',
      'names.primary': 'Canillo',
      'names.common': { ca: 'Canillo', zh: '卡尼略' },
    },
    geometry: null,
  };
  try {
    await writeFile(filePath, `${JSON.stringify(feature)}\n`);
    const [row] = await readGeoJsonSequence(filePath, { maximumBytes: 4096 });
    assert.deepEqual(row.names, { primary: 'Canillo', common: { ca: 'Canillo', zh: '卡尼略' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture({ country = 'CN', status = 'verified', sourceCountryCodes = ['CN', 'HK', 'MO', 'TW'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'country-runner-'));
  const snapshotDir = path.join(root, 'snapshot');
  await Promise.all([
    mkdir(path.join(root, 'data-audit', 'selectors'), { recursive: true }),
    mkdir(path.join(root, 'data-audit', 'exceptions'), { recursive: true }),
    mkdir(path.join(root, 'public', 'data', 'countries'), { recursive: true }),
    mkdir(snapshotDir, { recursive: true }),
  ]);
  const registry = {
    release: RELEASE,
    countries: [{
      sovereignCode: country, status, sourceCountryCodes, selectorVersion: 3,
      nameZh: country === 'CN' ? '中国' : country,
      nameLocal: country === 'CN' ? 'China' : country,
      productLevel: 'city',
      overtureSelector: { subtypes: ['city'], adminLevels: [], localTypeRules: [] },
      allowlist: [], denylist: [], expectedCount: { minimum: 1, maximum: 1 },
    }],
  };
  const selector = {
    schemaVersion: 1, sovereignCode: country, release: RELEASE, status, productLevel: 'city',
    overtureSelector: { subtypes: ['city'], adminLevels: [], localTypeRules: [] },
    allowlist: [], denylist: [], expectedCount: { kind: 'exact', value: 1, referenceIds: ['official'] },
    officialReferences: [{
      id: 'official', publisher: 'Official publisher', title: 'Official divisions', url: 'https://example.gov/divisions',
      capturedOn: '2026-08-16', effectiveOn: '2026-01-01', license: 'Public information', machineReadable: true,
    }],
    samples: [
      { category: 'capital', divisionId: 'capital', expectedInclusion: true, institutionalCategory: 'city', referenceIds: ['official'] },
      { category: 'ordinary', divisionId: 'ordinary', expectedInclusion: false, institutionalCategory: 'city', referenceIds: ['official'] },
      { category: 'small-rural', divisionId: 'rural', expectedInclusion: false, institutionalCategory: 'city', referenceIds: ['official'] },
    ],
    sampleApplicability: {
      border: { applicable: false, reason: 'not applicable' },
      coastal: { applicable: false, reason: 'not applicable' }, specialCaseCategories: [],
    },
  };
  const exceptions = {
    schemaVersion: 1, sovereignCode: country, release: RELEASE, status,
    exceptions: [], overlapExceptions: [],
  };
  const unresolvedOverrides = {
    schemaVersion: 1, release: RELEASE,
    unresolved: { rowCount: 0, byteSize: 128, sha256: 'a'.repeat(64) },
    overrides: [],
  };
  await Promise.all([
    writeFile(path.join(root, 'data-audit', 'sovereign-registry.json'), JSON.stringify(registry)),
    writeFile(path.join(root, 'data-audit', 'selectors', `${country}.json`), JSON.stringify(selector)),
    writeFile(path.join(root, 'data-audit', 'exceptions', `${country}.json`), JSON.stringify(exceptions)),
    writeFile(path.join(root, 'data-audit', 'unresolved-source-overrides.json'), JSON.stringify(unresolvedOverrides)),
    writeFile(path.join(snapshotDir, 'metadata.json'), JSON.stringify({ schemaVersion: 1, release: RELEASE, rowCounts: Object.fromEntries(sourceCountryCodes.map((code) => [code, 1])), unresolved: unresolvedOverrides.unresolved })),
  ]);
  return { root, snapshotDir, country, registry, selector, exceptions };
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      async extractCountry(options) {
        calls.push(['extract', options.sourceCountryCodes, options.unresolvedOverrideDocument?.schemaVersion]);
        await mkdir(options.outputDir, { recursive: true });
        const feature = {
          type: 'Feature', id: 'area-capital',
          properties: { divisionId: 'capital', sourceCountryCode: options.sourceCountryCodes[0], subtype: 'city', isLand: true, names: { primary: 'Capital' } },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        };
        await writeFile(path.join(options.outputDir, 'areas.geojsonseq'), `${JSON.stringify(feature)}\n`);
        return { outputPath: path.join(options.outputDir, 'areas.geojsonseq') };
      },
      selectCountryFeatures(rows) {
        calls.push(['select', rows.length]);
        return rows.map((row) => ({ ...row, sovereignCode: 'CN', productLevel: 'city' }));
      },
      verifySelectorEvidence() {
        calls.push(['evidence']);
        return { status: 'passed', failures: [], metrics: { finalCount: 1, referenceCount: 1, sampleCount: 3, exceptionCount: 0 } };
      },
      normalizeSelected(rows, config, release) {
        calls.push(['normalize']);
        return {
          type: 'FeatureCollection',
          metadata: { boundaryVersion: release, retrievedAt: '2026-08-16', source: 'overture', attribution: '© Overture Maps Foundation contributors; data available under ODbL 1.0' },
          features: rows.map((row) => ({
            type: 'Feature', id: row.divisionAreaId,
            properties: { divisionId: row.divisionId, sourceId: row.divisionId, areaId: `${config.sovereignCode}:overture:${row.divisionId}`, countryCode: config.sovereignCode, nameLocal: 'Capital', adminLevel: config.productLevel },
            geometry: row.geometry,
          })),
        };
      },
      auditCountry() {
        calls.push(['qa']);
        return { status: 'verified', metrics: { featureCount: 1, vertexCount: 4, vertices: { p50: 4, p95: 4, max: 4 }, compressedBytes: 0, warnings: [] }, exceptions: [] };
      },
      async buildCountryBoundaries({ outputDir, auditReports }) {
        calls.push(['build']);
        await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(auditReports.reportsDir, { recursive: true })]);
        await Promise.all([
          writeFile(path.join(outputDir, 'CN.topojson'), 'new-package'),
          writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({ CN: { checksum: 'a'.repeat(64), byteSize: 11 } })),
          writeFile(path.join(outputDir, 'area-index.json'), JSON.stringify([{ kind: 'country', countryCode: 'CN' }])),
          writeFile(path.join(auditReports.reportsDir, 'CN.json'), 'new-report'),
        ]);
        return { CN: { checksum: 'a'.repeat(64), byteSize: 11 } };
      },
      async promoteCountryArtifacts({ builtPackagesDir, builtReportsDir, packagesDir, reportsDir, country }) {
        calls.push(['promote']);
        await mkdir(reportsDir, { recursive: true });
        await Promise.all([
          writeFile(path.join(packagesDir, `${country}.topojson`), await readFile(path.join(builtPackagesDir, `${country}.topojson`))),
          writeFile(path.join(reportsDir, `${country}.json`), await readFile(path.join(builtReportsDir, `${country}.json`))),
        ]);
      },
      generatorCommit: '0123456789abcdef0123456789abcdef01234567',
      auditedOn: '2026-08-16',
      now: () => 0,
      ...overrides,
    },
  };
}

async function run(fixtureValue, deps, extraArgs = []) {
  return runCountryAudit([
    '--country', fixtureValue.country, '--release', RELEASE, '--snapshot', fixtureValue.snapshotDir, ...extraArgs,
  ], { cwd: fixtureValue.root, deps });
}

test('runs the local-snapshot pipeline and promotes one verified country', async () => {
  const f = await fixture();
  const { calls, deps } = dependencies();
  try {
    const result = await run(f, deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.result));
    assert.deepEqual(result.result, { status: 'verified', countryCode: 'CN', release: RELEASE, featureCount: 1 });
    assert.deepEqual(calls.map(([name]) => name), ['extract', 'select', 'evidence', 'normalize', 'qa', 'build', 'promote']);
    assert.deepEqual(calls[0][1], ['CN', 'HK', 'MO', 'TW']);
    assert.equal(calls[0][2], 1);
    assert.equal(await readFile(path.join(f.root, 'public/data/countries/CN.topojson'), 'utf8'), 'new-package');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('passes only reviewed overlap exceptions into geometry QA', async () => {
  const f = await fixture();
  f.exceptions.overlapExceptions = [{
    id: 'reviewed-overlap', kind: 'overlap', divisionIds: ['capital', 'ordinary'],
    reason: 'Officially shared surface.', referenceIds: ['official'],
  }];
  await writeFile(path.join(f.root, 'data-audit/exceptions/CN.json'), JSON.stringify(f.exceptions));
  let received;
  const { deps } = dependencies({
    auditCountry(_collection, _config, reference) {
      received = reference.exceptions;
      return {
        status: 'verified',
        metrics: { featureCount: 1, vertexCount: 4, vertices: { p50: 4, p95: 4, max: 4 }, compressedBytes: 0, warnings: [] },
        exceptions: ['reviewed-overlap'],
      };
    },
  });
  try {
    const result = await run(f, deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.result));
    assert.deepEqual(received, [{ id: 'reviewed-overlap', kind: 'overlap', divisionIds: ['capital', 'ordinary'] }]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('default adapters build and bind a real consolidated CN package from a non-mainland source row', async () => {
  const f = await fixture();
  f.registry.countries[0].productLevel = 'prefecture';
  f.registry.countries[0].overtureSelector = { subtypes: ['prefecture'], adminLevels: [], localTypeRules: [] };
  f.registry.countries[0].expectedCount = { minimum: 1, maximum: 1 };
  f.selector.productLevel = 'prefecture';
  f.selector.overtureSelector.subtypes = ['prefecture'];
  await Promise.all([
    writeFile(path.join(f.root, 'data-audit/sovereign-registry.json'), JSON.stringify(f.registry)),
    writeFile(path.join(f.root, 'data-audit/selectors/CN.json'), JSON.stringify(f.selector)),
  ]);
  const fake = dependencies().deps.extractCountry;
  const extractCountry = async (options) => {
    const result = await fake(options);
    const feature = JSON.parse((await readFile(result.outputPath, 'utf8')).trim());
    feature.properties.subtype = 'prefecture';
    feature.properties.adminLevel = 2;
    feature.properties.sourceCountryCode = 'HK';
    feature.properties.names = { primary: 'Capital', common: { zh: '首都' } };
    await writeFile(result.outputPath, `${JSON.stringify(feature)}\n`);
    return result;
  };
  let builderError;
  const build = async (options) => {
    try { return await buildCountryBoundaries(options); }
    catch (error) { builderError = error; throw error; }
  };
  try {
    const result = await runCountryAudit([
      '--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshotDir,
    ], {
      cwd: f.root,
      deps: { extractCountry, buildCountryBoundaries: build, generatorCommit: '0123456789abcdef0123456789abcdef01234567', auditedOn: '2026-08-16' },
    });
    assert.equal(result.exitCode, 0, builderError?.message ?? JSON.stringify(result.result));
    const manifest = JSON.parse(await readFile(path.join(f.root, 'public/data/countries/manifest.json'), 'utf8'));
    const report = JSON.parse(await readFile(path.join(f.root, 'data-audit/reports', RELEASE, 'CN.json'), 'utf8'));
    assert.equal(manifest.CN.checksum, report.packageChecksum);
    assert.equal(manifest.CN.featureCount, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('default adapters build a third registry country instead of failing the legacy CN/US allowlist', async () => {
  const f = await fixture({ country: 'AD', sourceCountryCodes: ['AD'] });
  f.registry.countries[0].nameZh = '安道尔';
  f.registry.countries[0].nameLocal = 'Andorra';
  f.registry.countries[0].productLevel = 'municipality-equivalent-parish';
  f.registry.countries[0].overtureSelector = { subtypes: ['region'], adminLevels: [1], localTypeRules: [] };
  f.registry.countries[0].expectedCount = { minimum: 1, maximum: 1 };
  f.selector.productLevel = 'municipality-equivalent-parish';
  f.selector.overtureSelector = { subtypes: ['region'], adminLevels: [1], localTypeRules: [] };
  await Promise.all([
    writeFile(path.join(f.root, 'data-audit/sovereign-registry.json'), JSON.stringify(f.registry)),
    writeFile(path.join(f.root, 'data-audit/selectors/AD.json'), JSON.stringify(f.selector)),
  ]);
  const fake = dependencies().deps.extractCountry;
  const extractCountry = async (options) => {
    const result = await fake(options);
    const feature = JSON.parse((await readFile(result.outputPath, 'utf8')).trim());
    feature.properties.subtype = 'region';
    feature.properties.adminLevel = 1;
    feature.properties.sourceCountryCode = 'AD';
    feature.properties.names = { primary: 'Canillo', common: { zh: '卡尼略' } };
    await writeFile(result.outputPath, `${JSON.stringify(feature)}\n`);
    return result;
  };
  let builderError;
  const build = async (options) => {
    try { return await buildCountryBoundaries(options); }
    catch (error) { builderError = error; throw error; }
  };
  try {
    const result = await runCountryAudit([
      '--country', 'AD', '--release', RELEASE, '--snapshot', f.snapshotDir,
    ], {
      cwd: f.root,
      deps: { extractCountry, buildCountryBoundaries: build, generatorCommit: '0123456789abcdef0123456789abcdef01234567', auditedOn: '2026-08-16' },
    });
    assert.equal(result.exitCode, 0, builderError?.message ?? JSON.stringify(result.result));
    const manifest = JSON.parse(await readFile(path.join(f.root, 'public/data/countries/manifest.json'), 'utf8'));
    assert.equal(manifest.AD.administrativeScheme, 'municipality-equivalent-parish');
    assert.equal(manifest.AD.featureCount, 1);
    assert.match(manifest.AD.attribution, /OpenStreetMap contributors/u);
    assert.match(manifest.AD.attribution, /Overture Maps Foundation/u);
    assert.match(manifest.AD.attribution, /ODbL 1\.0/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('does not build or promote when selector evidence is unverified', async () => {
  const f = await fixture();
  const { calls, deps } = dependencies({ verifySelectorEvidence: () => ({ status: 'failed', failures: [{ code: 'SAMPLE_RESULT_MISMATCH' }] }) });
  try {
    const result = await run(f, deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.failures[0].code, 'SELECTOR_UNVERIFIED');
    assert.deepEqual(calls.map(([name]) => name), ['extract', 'select']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a selector whose reviewed product level no longer matches the registry before extraction', async () => {
  const f = await fixture({ country: 'AD', sourceCountryCodes: ['AD'] });
  f.selector.productLevel = 'municipality';
  await writeFile(path.join(f.root, 'data-audit/selectors/AD.json'), JSON.stringify(f.selector));
  const { calls, deps } = dependencies();
  try {
    const result = await run(f, deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.result.failures, [{ code: 'REGISTRY_SELECTOR_MISMATCH', subject: 'AD' }]);
    assert.deepEqual(calls, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('does not build or promote after QA failure', async () => {
  const f = await fixture();
  const { calls, deps } = dependencies({ auditCountry: () => ({ status: 'failed', failures: [{ code: 'COUNT_MISMATCH' }], metrics: {} }) });
  try {
    const result = await run(f, deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.result.failures, [{ code: 'QA_FAILED', subject: 'COUNT_MISMATCH' }]);
    assert.doesNotMatch(calls.map(([name]) => name).join(','), /build|promote/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('builder failure leaves existing formal package and report byte-identical', async () => {
  const f = await fixture();
  const packagePath = path.join(f.root, 'public/data/countries/CN.topojson');
  const reportDir = path.join(f.root, 'data-audit/reports', RELEASE);
  const reportPath = path.join(reportDir, 'CN.json');
  await mkdir(reportDir, { recursive: true });
  await Promise.all([writeFile(packagePath, 'old-package'), writeFile(reportPath, 'old-report')]);
  const { deps } = dependencies({ buildCountryBoundaries: async () => { throw new Error('/private/host/build failed'); } });
  try {
    const result = await run(f, deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.result.failures, [{ code: 'BUILD_FAILED', subject: 'country-package' }]);
    assert.equal(await readFile(packagePath, 'utf8'), 'old-package');
    assert.equal(await readFile(reportPath, 'utf8'), 'old-report');
    assert.doesNotMatch(JSON.stringify(result), /private|host/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test.each([
  ['unregistered country', { country: 'US' }, 'COUNTRY_NOT_REGISTERED'],
  ['draft registry row', { status: 'draft' }, 'COUNTRY_STATUS_INVALID'],
])('rejects %s before extraction', async (_label, options, code) => {
  const f = await fixture(options);
  const { calls, deps } = dependencies();
  try {
    if (options.country === 'US') f.country = 'CN';
    const result = await run(f, deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.failures[0].code, code);
    assert.deepEqual(calls, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects release mismatch and arbitrary output arguments', async () => {
  const f = await fixture();
  const { deps } = dependencies();
  try {
    const wrong = await runCountryAudit(['--country', 'CN', '--release', '2026-08-18.0', '--snapshot', f.snapshotDir], { cwd: f.root, deps });
    assert.equal(wrong.result.failures[0].code, 'RELEASE_MISMATCH');
    const output = await run(f, deps, ['--output', '/tmp/escape']);
    assert.equal(output.result.failures[0].code, 'ARGUMENT_UNSUPPORTED');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a symlinked snapshot without exposing its target path', async () => {
  const f = await fixture();
  const link = path.join(f.root, 'snapshot-link');
  await symlink(f.snapshotDir, link);
  f.snapshotDir = link;
  const { calls, deps } = dependencies();
  try {
    const result = await run(f, deps);
    assert.equal(result.result.failures[0].code, 'SNAPSHOT_UNSAFE');
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(result), /snapshot-link|country-runner-/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('atomically merges the country package, manifest, index, and report while invalidating stale summary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'country-promotion-'));
  const builtPackagesDir = path.join(root, 'built-packages');
  const builtReportsDir = path.join(root, 'built-reports');
  const packagesDir = path.join(root, 'packages');
  const reportsDir = path.join(root, 'reports');
  await Promise.all([builtPackagesDir, builtReportsDir, packagesDir, reportsDir].map((directory) => mkdir(directory)));
  await Promise.all([
    writeFile(path.join(packagesDir, 'US.topojson'), 'us-package'),
    writeFile(path.join(packagesDir, 'manifest.json'), JSON.stringify({ US: { checksum: 'u' } })),
    writeFile(path.join(packagesDir, 'area-index.json'), JSON.stringify([{ kind: 'country', countryCode: 'US' }])),
    writeFile(path.join(reportsDir, 'US.json'), 'us-report'),
    writeFile(path.join(reportsDir, 'summary.json'), 'stale-summary'),
    writeFile(path.join(builtPackagesDir, 'CN.topojson'), 'cn-package'),
    writeFile(path.join(builtPackagesDir, 'manifest.json'), JSON.stringify({ CN: { checksum: 'c' } })),
    writeFile(path.join(builtPackagesDir, 'area-index.json'), JSON.stringify([
      { kind: 'country', countryCode: 'CN' }, { kind: 'area', countryCode: 'CN', areaId: 'CN:overture:capital' },
    ])),
    writeFile(path.join(builtReportsDir, 'CN.json'), 'cn-report'),
  ]);
  try {
    await promoteCountryArtifacts({ builtPackagesDir, builtReportsDir, packagesDir, reportsDir, country: 'CN' });
    assert.deepEqual(JSON.parse(await readFile(path.join(packagesDir, 'manifest.json'), 'utf8')), {
      CN: { checksum: 'c' }, US: { checksum: 'u' },
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(packagesDir, 'area-index.json'), 'utf8')).map((entry) => entry.countryCode), ['CN', 'US', 'CN']);
    assert.equal(await readFile(path.join(packagesDir, 'CN.topojson'), 'utf8'), 'cn-package');
    assert.equal(await readFile(path.join(packagesDir, 'US.topojson'), 'utf8'), 'us-package');
    assert.equal(await readFile(path.join(reportsDir, 'CN.json'), 'utf8'), 'cn-report');
    assert.equal(await readFile(path.join(reportsDir, 'US.json'), 'utf8'), 'us-report');
    await assert.rejects(readFile(path.join(reportsDir, 'summary.json')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI prints one stable JSON failure and exits 1 for unsupported arguments', () => {
  const result = spawnSync(process.execPath, ['scripts/audit/country-runner.mjs', '--output', '/tmp/escape'], {
    cwd: path.resolve('.'), encoding: 'utf8', shell: false,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'failed', failures: [{ code: 'ARGUMENT_UNSUPPORTED', subject: 'argument' }],
  });
});
