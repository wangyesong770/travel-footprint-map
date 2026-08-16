import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { GlobalReleaseError, verifyGlobalRelease } from './verify-global-release.mjs';

const RELEASE = '2026-06-17.0';
const ATTRIBUTION = '© OpenStreetMap contributors, Overture Maps Foundation · ODbL 1.0';

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

async function makeFixture({ completeGlobal = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'global-gate-'));
  const packagesDir = path.join(root, 'packages');
  const reportsDir = path.join(root, 'reports');
  const registryPath = path.join(root, 'registry.json');
  const outputPath = path.join(root, 'release-ready.json');
  await Promise.all([mkdir(packagesDir), mkdir(reportsDir)]);

  const countries = [
    {
      sovereignCode: 'CN', sourceCountryCodes: ['CN', 'HK', 'MO', 'TW'], selectorVersion: 3,
      perspective: 'china-official', status: 'verified',
    },
    {
      sovereignCode: 'US', sourceCountryCodes: ['US', 'PR', 'GU'], selectorVersion: 2,
      perspective: 'overture-default', status: 'verified',
    },
  ];
  if (completeGlobal) {
    const reserved = new Set(['CN', 'US', 'HK', 'MO', 'TW', 'PR', 'GU']);
    for (let first = 65; first <= 90 && countries.length < 190; first += 1) {
      for (let second = 65; second <= 90 && countries.length < 190; second += 1) {
        const code = String.fromCharCode(first, second);
        if (reserved.has(code)) continue;
        countries.push({
          sovereignCode: code, sourceCountryCodes: [code], selectorVersion: 1,
          perspective: 'overture-default', status: 'verified',
        });
      }
    }
  }
  await writeFile(registryPath, JSON.stringify({ release: RELEASE, schemaVersion: 'v1.17.0', countries }));

  const manifest = {};
  const summaryCountries = [];
  for (const config of countries) {
    const code = config.sovereignCode;
    const packageBytes = Buffer.from(`${canonicalJson({
      type: 'Topology', schemaVersion: 1, countryCode: code, boundaryVersion: RELEASE,
      administrativeScheme: 'fixture', source: 'overture', attribution: ATTRIBUTION,
      objects: { areas: { type: 'GeometryCollection', geometries: [] } }, arcs: [],
    })}\n`);
    const checksum = createHash('sha256').update(packageBytes).digest('hex');
    await writeFile(path.join(packagesDir, `${code}.topojson`), packageBytes);
    manifest[code] = {
      schemaVersion: 1, countryCode: code, boundaryVersion: RELEASE,
      administrativeScheme: 'fixture', featureCount: 0, byteSize: packageBytes.byteLength,
      checksum, updatedAt: '2026-08-16T00:00:00.000Z', source: 'overture', attribution: ATTRIBUTION,
    };
    await writeFile(path.join(reportsDir, `${code}.json`), JSON.stringify({
      schemaVersion: 1, countryCode: code, sourceRelease: RELEASE,
      selectorVersion: config.selectorVersion, status: 'verified', packageChecksum: checksum,
      packageByteSize: packageBytes.byteLength, sourceCountryCodes: config.sourceCountryCodes,
      attribution: ATTRIBUTION,
    }));
    summaryCountries.push({
      countryCode: code, status: 'verified', selectorVersion: config.selectorVersion,
      packageByteSize: packageBytes.byteLength, packageChecksum: checksum,
    });
  }
  await writeFile(path.join(packagesDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(reportsDir, 'summary.json'), JSON.stringify({
    schemaVersion: 1, sourceRelease: RELEASE, generatorCommit: 'fixture',
    countries: summaryCountries,
  }));

  const validatorCalls = [];
  const options = {
    release: RELEASE, packagesDir, reportsDir, registryPath, outputPath,
    validatePackage: async (bytes, entry) => validatorCalls.push([bytes.byteLength, entry.countryCode]),
  };
  return { root, packagesDir, reportsDir, registryPath, outputPath, options, validatorCalls };
}

async function expectFailure(fixture, code, country = 'GLOBAL') {
  await assert.rejects(
    verifyGlobalRelease(fixture.options),
    (error) => error instanceof GlobalReleaseError
      && error.failures.some((failure) => failure.code === code && failure.countryCode === country),
  );
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
}

async function expectInputFailureWithoutPublishing(fixture, expectedCode) {
  const previous = Buffer.from('{"release":"previous"}\n');
  await writeFile(fixture.outputPath, previous);
  await assert.rejects(verifyGlobalRelease(fixture.options), (error) => {
    assert.ok(error instanceof GlobalReleaseError);
    assert.deepEqual(error.failures, [{ countryCode: 'GLOBAL', code: expectedCode }]);
    assert.equal(error.message.includes(fixture.root), false);
    return true;
  });
  assert.deepEqual(await readFile(fixture.outputPath), previous);
}

test('writes one canonical release-ready manifest only for the complete verified sovereign set', async () => {
  const fixture = await makeFixture({ completeGlobal: true });
  try {
    const result = await verifyGlobalRelease(fixture.options);
    assert.equal(result.release, RELEASE);
    assert.equal(result.countries.length, 190);
    assert.deepEqual(fixture.validatorCalls.map(([, code]) => code), result.countries);
    assert.deepEqual(JSON.parse(await readFile(fixture.outputPath, 'utf8')), result);
    assert.equal((await readFile(fixture.outputPath, 'utf8')).endsWith('\n'), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a seed-sized registry even when every listed country is verified', async () => {
  const fixture = await makeFixture();
  try {
    await expectFailure(fixture, 'REGISTRY_INCOMPLETE');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reports a missing report directory without leaking paths or replacing rollback state', async () => {
  const fixture = await makeFixture({ completeGlobal: true });
  try {
    await rm(fixture.reportsDir, { recursive: true });
    await expectInputFailureWithoutPublishing(fixture, 'REPORT_DIRECTORY_MISSING');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reports a missing summary without leaking paths or replacing rollback state', async () => {
  const fixture = await makeFixture({ completeGlobal: true });
  try {
    await rm(path.join(fixture.reportsDir, 'summary.json'));
    await expectInputFailureWithoutPublishing(fixture, 'SUMMARY_MISSING');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reports a missing package manifest without leaking paths or replacing rollback state', async () => {
  const fixture = await makeFixture({ completeGlobal: true });
  try {
    await rm(path.join(fixture.packagesDir, 'manifest.json'));
    await expectInputFailureWithoutPublishing(fixture, 'MANIFEST_MISSING');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a missing sovereign package using exact set equality', async () => {
  const fixture = await makeFixture();
  try {
    await rm(path.join(fixture.packagesDir, 'US.topojson'));
    await expectFailure(fixture, 'PACKAGE_MISSING', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects an extra unregistered country package', async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(path.join(fixture.packagesDir, 'ZZ.topojson'), '{}');
    await expectFailure(fixture, 'PACKAGE_EXTRA', 'ZZ');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects draft countries before package publication', async () => {
  const fixture = await makeFixture();
  try {
    const registry = JSON.parse(await readFile(fixture.registryPath, 'utf8'));
    registry.countries[1].status = 'draft';
    await writeFile(fixture.registryPath, JSON.stringify(registry));
    await expectFailure(fixture, 'COUNTRY_DRAFT', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects countries whose audit status is failed', async () => {
  const fixture = await makeFixture();
  try {
    const registry = JSON.parse(await readFile(fixture.registryPath, 'utf8'));
    registry.countries[1].status = 'failed';
    await writeFile(fixture.registryPath, JSON.stringify(registry));
    await expectFailure(fixture, 'COUNTRY_FAILED', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a missing country evidence report', async () => {
  const fixture = await makeFixture();
  try {
    await rm(path.join(fixture.reportsDir, 'US.json'));
    await expectFailure(fixture, 'REPORT_MISSING', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects extra report and manifest countries using exact set equality', async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(path.join(fixture.reportsDir, 'ZZ.json'), '{}');
    const manifestPath = path.join(fixture.packagesDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.ZZ = manifest.US;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyGlobalRelease(fixture.options), (error) => {
      assert.ok(error instanceof GlobalReleaseError);
      assert.ok(error.failures.some(({ countryCode, code }) => countryCode === 'ZZ' && code === 'REPORT_EXTRA'));
      assert.ok(error.failures.some(({ countryCode, code }) => countryCode === 'ZZ' && code === 'MANIFEST_COUNTRY_EXTRA'));
      return true;
    });
    await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects mixed registry, package, report, and summary releases', async () => {
  const fixture = await makeFixture({ completeGlobal: true });
  try {
    const manifest = JSON.parse(await readFile(path.join(fixture.packagesDir, 'manifest.json'), 'utf8'));
    manifest.US.boundaryVersion = '2026-05-20.0';
    await writeFile(path.join(fixture.packagesDir, 'manifest.json'), JSON.stringify(manifest));
    const report = JSON.parse(await readFile(path.join(fixture.reportsDir, 'CN.json'), 'utf8'));
    report.sourceRelease = '2026-05-20.0';
    await writeFile(path.join(fixture.reportsDir, 'CN.json'), JSON.stringify(report));
    const summary = JSON.parse(await readFile(path.join(fixture.reportsDir, 'summary.json'), 'utf8'));
    summary.sourceRelease = '2026-05-20.0';
    await writeFile(path.join(fixture.reportsDir, 'summary.json'), JSON.stringify(summary));
    await assert.rejects(verifyGlobalRelease(fixture.options), (error) => {
      assert.ok(error instanceof GlobalReleaseError);
      assert.deepEqual(error.failures.map(({ countryCode, code }) => `${countryCode}:${code}`), [
        'CN:REPORT_RELEASE_MISMATCH', 'GLOBAL:SUMMARY_RELEASE_MISMATCH', 'US:PACKAGE_RELEASE_MISMATCH',
      ]);
      return true;
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects report, manifest, or byte checksum disagreement', async () => {
  const fixture = await makeFixture();
  try {
    const report = JSON.parse(await readFile(path.join(fixture.reportsDir, 'US.json'), 'utf8'));
    report.packageChecksum = 'a'.repeat(64);
    await writeFile(path.join(fixture.reportsDir, 'US.json'), JSON.stringify(report));
    await expectFailure(fixture, 'CHECKSUM_MISMATCH', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a stale summary that is not bound to its country report', async () => {
  const fixture = await makeFixture();
  try {
    const summaryPath = path.join(fixture.reportsDir, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    summary.countries[1].packageChecksum = 'b'.repeat(64);
    await writeFile(summaryPath, JSON.stringify(summary));
    await expectFailure(fixture, 'SUMMARY_BINDING_MISMATCH', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects missing Overture, OpenStreetMap, or ODbL attribution', async () => {
  const fixture = await makeFixture();
  try {
    const manifest = JSON.parse(await readFile(path.join(fixture.packagesDir, 'manifest.json'), 'utf8'));
    manifest.US.attribution = 'Overture Maps Foundation';
    await writeFile(path.join(fixture.packagesDir, 'manifest.json'), JSON.stringify(manifest));
    await expectFailure(fixture, 'ATTRIBUTION_MISSING', 'US');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects China ownership unless CN contains CN, HK, MO, TW and uses china-official', async () => {
  const fixture = await makeFixture();
  try {
    const registry = JSON.parse(await readFile(fixture.registryPath, 'utf8'));
    registry.countries[0].sourceCountryCodes = ['CN', 'HK', 'MO'];
    registry.countries[0].perspective = 'overture-default';
    await writeFile(fixture.registryPath, JSON.stringify(registry));
    await expectFailure(fixture, 'CHINA_OWNERSHIP_MISMATCH', 'CN');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('preserves an existing rollback manifest byte-for-byte when verification fails', async () => {
  const fixture = await makeFixture();
  try {
    const previous = Buffer.from('{"release":"previous"}\n');
    await writeFile(fixture.outputPath, previous);
    await rm(path.join(fixture.reportsDir, 'CN.json'));
    await assert.rejects(verifyGlobalRelease(fixture.options), GlobalReleaseError);
    assert.deepEqual(await readFile(fixture.outputPath), previous);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('atomically replaces the prior manifest and leaves no temporary publication files', async () => {
  const fixture = await makeFixture({ completeGlobal: true });
  try {
    await writeFile(fixture.outputPath, '{"release":"previous"}\n');
    const result = await verifyGlobalRelease(fixture.options);
    assert.deepEqual(JSON.parse(await readFile(fixture.outputPath, 'utf8')), result);
    assert.deepEqual((await readdir(fixture.root)).filter((name) => name.includes('.tmp')), []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('production CI can publish only an exact audited main-branch release, never fixture or seed data', async () => {
  const workflow = await readFile('.github/workflows/global-boundary-audit.yml', 'utf8');
  const production = workflow.slice(workflow.indexOf('  production-release:'));
  assert.match(production, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(production, /npm run audit:global/u);
  assert.match(production, /--packages public\/data\/countries/u);
  assert.match(production, /--reports "data-audit\/reports\/\$OVERTURE_RELEASE"/u);
  assert.doesNotMatch(production, /fixture|seed/iu);
  assert.match(production, /if: \$\{\{ steps\.release-gate\.outcome == 'success' \}\}/u);
  assert.match(production, /environment: production-boundaries/u);
  assert.match(production, /test -s public\/data\/countries\/manifest\.json/u);
  assert.match(production, /test -s public\/data\/countries\/area-index\.json/u);
  assert.match(production, /test -s public\/data\/countries\/release-ready\.json/u);
  assert.match(production, /global-boundaries-\$\{\{ env\.OVERTURE_RELEASE \}\}-\$\{\{ github\.run_id \}\}/u);
});
