import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { RegionAuditError, runRegionAuditCli, verifyRegionAudit } from './verify-region-audit.mjs';

const RELEASE = '2026-06-17.0';
const REGION = 'europe';
const ATTRIBUTION = '© OpenStreetMap contributors, Overture Maps Foundation · ODbL 1.0';

function country(code, region = REGION, status = 'verified') {
  return {
    sovereignCode: code,
    sourceCountryCodes: [code],
    nameZh: code,
    nameLocal: code,
    auditRegion: region,
    worldGeometryIds: [code],
    productLevel: 'municipality-equivalent',
    selectorVersion: code === 'FR' ? 2 : 1,
    overtureSelector: { subtypes: ['locality'], adminLevels: [8], localTypeRules: [] },
    allowlist: [],
    denylist: [],
    expectedCount: { minimum: 1, maximum: 100000, referenceDate: '2026-08-16' },
    officialReferences: [{
      title: 'Official register', url: 'https://example.gov/register', retrievedOn: '2026-08-16', license: 'public record',
    }],
    perspective: 'overture-default',
    auditedAt: '2026-08-16',
    status,
  };
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'region-gate-'));
  const auditRoot = path.join(root, 'data-audit');
  const selectorsDir = path.join(auditRoot, 'selectors');
  const reportsDir = path.join(auditRoot, 'reports', RELEASE);
  const packagesDir = path.join(root, 'public', 'data', 'countries');
  const registryPath = path.join(auditRoot, 'sovereign-registry.json');
  await Promise.all([
    mkdir(selectorsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true }),
    mkdir(packagesDir, { recursive: true }),
  ]);
  const countries = [country('DE'), country('FR'), country('JP', 'east-asia-pacific')];
  await writeFile(registryPath, JSON.stringify({
    release: RELEASE,
    schemaVersion: 'v1.17.0',
    nonSovereignExclusions: [{
      key: 'antarctica', sourceCountryCodes: ['AQ'], worldGeometryIds: ['AQ'], reason: 'not a sovereign country',
      officialReferences: [{
        title: 'Antarctic Treaty', url: 'https://www.ats.aq/e/antarctictreaty.html',
        retrievedOn: '2026-08-16', license: 'public record',
      }],
    }],
    countries,
  }));
  const manifest = {};
  for (const config of countries) {
    const code = config.sovereignCode;
    const bytes = Buffer.from(`package:${code}\n`);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(packagesDir, `${code}.topojson`), bytes);
    manifest[code] = {
      countryCode: code, boundaryVersion: RELEASE, byteSize: bytes.byteLength,
      checksum, attribution: ATTRIBUTION,
    };
    await writeFile(path.join(selectorsDir, `${code}.json`), JSON.stringify({
      schemaVersion: 1, release: RELEASE, sovereignCode: code, status: 'verified',
      overtureSelector: config.overtureSelector,
    }));
    await writeFile(path.join(reportsDir, `${code}.json`), JSON.stringify({
      schemaVersion: 1, countryCode: code, sourceRelease: RELEASE, status: 'verified',
      selectorVersion: config.selectorVersion, sourceCountryCodes: config.sourceCountryCodes,
      packageByteSize: bytes.byteLength, packageChecksum: checksum, attribution: ATTRIBUTION,
    }));
  }
  await writeFile(path.join(packagesDir, 'manifest.json'), JSON.stringify(manifest));
  return {
    root, auditRoot, selectorsDir, reportsDir, packagesDir, registryPath,
    options: { region: REGION, release: RELEASE, selectorsDir, reportsDir, packagesDir, registryPath },
  };
}

async function failures(fixture) {
  try {
    await verifyRegionAudit(fixture.options);
  } catch (error) {
    assert.ok(error instanceof RegionAuditError);
    assert.equal(error.message.includes(fixture.root), false);
    return error.failures;
  }
  assert.fail('expected RegionAuditError');
}

test('passes an exact verified regional subset while ignoring registered artifacts from other regions', async () => {
  const fixture = await makeFixture();
  try {
    const before = await readdir(fixture.root, { recursive: true });
    const result = await verifyRegionAudit(fixture.options);
    assert.deepEqual(result, { status: 'passed', region: REGION, release: RELEASE, countries: ['DE', 'FR'], failures: [] });
    assert.deepEqual(await readdir(fixture.root, { recursive: true }), before);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reports stable sorted exact-set failures for missing and unregistered artifacts', async () => {
  const fixture = await makeFixture();
  try {
    await rm(path.join(fixture.selectorsDir, 'FR.json'));
    await rm(path.join(fixture.reportsDir, 'DE.json'));
    await writeFile(path.join(fixture.selectorsDir, 'ZZ.json'), '{}');
    await writeFile(path.join(fixture.reportsDir, 'ZZ.json'), '{}');
    await writeFile(path.join(fixture.packagesDir, 'ZZ.topojson'), 'x');
    const manifestPath = path.join(fixture.packagesDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.ZZ = manifest.DE;
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await failures(fixture), [
      { countryCode: 'DE', code: 'REPORT_MISSING' },
      { countryCode: 'FR', code: 'SELECTOR_MISSING' },
      { countryCode: 'ZZ', code: 'MANIFEST_EXTRA' },
      { countryCode: 'ZZ', code: 'PACKAGE_EXTRA' },
      { countryCode: 'ZZ', code: 'REPORT_EXTRA' },
      { countryCode: 'ZZ', code: 'SELECTOR_EXTRA' },
    ]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects draft and failed configs, selectors, and reports with stable country codes', async () => {
  const fixture = await makeFixture();
  try {
    const registry = JSON.parse(await readFile(fixture.registryPath, 'utf8'));
    registry.countries[0].status = 'draft';
    registry.countries[1].status = 'failed';
    await writeFile(fixture.registryPath, JSON.stringify(registry));
    const selector = JSON.parse(await readFile(path.join(fixture.selectorsDir, 'DE.json'), 'utf8'));
    selector.status = 'draft';
    await writeFile(path.join(fixture.selectorsDir, 'DE.json'), JSON.stringify(selector));
    const report = JSON.parse(await readFile(path.join(fixture.reportsDir, 'FR.json'), 'utf8'));
    report.status = 'failed';
    await writeFile(path.join(fixture.reportsDir, 'FR.json'), JSON.stringify(report));
    assert.deepEqual(await failures(fixture), [
      { countryCode: 'DE', code: 'CONFIG_DRAFT' },
      { countryCode: 'DE', code: 'SELECTOR_DRAFT' },
      { countryCode: 'FR', code: 'CONFIG_FAILED' },
      { countryCode: 'FR', code: 'REPORT_FAILED' },
    ]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('binds release, country, selector predicate/version, source ownership, checksum and byte size', async () => {
  const fixture = await makeFixture();
  try {
    const selectorPath = path.join(fixture.selectorsDir, 'DE.json');
    const selector = JSON.parse(await readFile(selectorPath, 'utf8'));
    selector.release = '2026-05-20.0';
    selector.overtureSelector.adminLevels = [7];
    await writeFile(selectorPath, JSON.stringify(selector));
    const reportPath = path.join(fixture.reportsDir, 'FR.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    report.selectorVersion = 99;
    report.sourceCountryCodes = ['XX'];
    report.packageChecksum = 'a'.repeat(64);
    await writeFile(reportPath, JSON.stringify(report));
    const manifestPath = path.join(fixture.packagesDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.FR.boundaryVersion = '2026-05-20.0';
    manifest.FR.byteSize += 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await failures(fixture), [
      { countryCode: 'DE', code: 'SELECTOR_CONFIG_MISMATCH' },
      { countryCode: 'DE', code: 'SELECTOR_RELEASE_MISMATCH' },
      { countryCode: 'FR', code: 'CHECKSUM_MISMATCH' },
      { countryCode: 'FR', code: 'PACKAGE_RELEASE_MISMATCH' },
      { countryCode: 'FR', code: 'SELECTOR_VERSION_MISMATCH' },
      { countryCode: 'FR', code: 'SOURCE_OWNERSHIP_MISMATCH' },
    ]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a malformed manifest entry instead of silently skipping package verification', async () => {
  const fixture = await makeFixture();
  try {
    const manifestPath = path.join(fixture.packagesDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.DE = 'not-an-entry';
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await failures(fixture), [{ countryCode: 'DE', code: 'MANIFEST_ENTRY_INVALID' }]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('uses the strict registry contract and rejects unknown fields before evaluating a region', async () => {
  const fixture = await makeFixture();
  try {
    const registry = JSON.parse(await readFile(fixture.registryPath, 'utf8'));
    registry.countries[0].unreviewedFallback = true;
    await writeFile(fixture.registryPath, JSON.stringify(registry));
    assert.deepEqual(await failures(fixture), [{ countryCode: 'GLOBAL', code: 'REGISTRY_INVALID' }]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('turns missing, invalid, oversized, and symlinked inputs into redacted stable failures', async () => {
  const scenarios = [
    ['missing registry', async (f) => rm(f.registryPath), 'REGISTRY_MISSING'],
    ['invalid manifest JSON', async (f) => writeFile(path.join(f.packagesDir, 'manifest.json'), '{'), 'MANIFEST_JSON_INVALID'],
    ['oversized selector', async (f) => writeFile(path.join(f.selectorsDir, 'DE.json'), ' '.repeat((1024 * 1024) + 1)), 'SELECTOR_TOO_LARGE'],
    ['symlinked report', async (f) => {
      const target = path.join(f.root, 'outside.json');
      await writeFile(target, '{}');
      await rm(path.join(f.reportsDir, 'DE.json'));
      await symlink(target, path.join(f.reportsDir, 'DE.json'));
    }, 'REPORT_UNREADABLE'],
  ];
  for (const [name, mutate, expected] of scenarios) {
    const fixture = await makeFixture();
    try {
      await mutate(fixture);
      const result = await failures(fixture);
      assert.deepEqual(result, [{ countryCode: name === 'symlinked report' || name === 'oversized selector' ? 'DE' : 'GLOBAL', code: expected }], name);
      assert.equal(JSON.stringify(result).includes(fixture.root), false);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test('CLI accepts only one of seven regions and emits the same stable result with exit 0/1', async () => {
  const fixture = await makeFixture();
  try {
    const passed = await runRegionAuditCli(['--region', REGION, '--release', RELEASE], { cwd: fixture.root });
    assert.equal(passed.exitCode, 0);
    assert.equal(JSON.stringify(passed.result).includes(fixture.root), false);
    const invalid = await runRegionAuditCli(['--region', 'mars', '--release', RELEASE], { cwd: fixture.root });
    assert.deepEqual(invalid, {
      exitCode: 1,
      result: { status: 'failed', region: 'unknown', release: RELEASE, countries: [], failures: [{ countryCode: 'GLOBAL', code: 'ARGUMENT_REGION_INVALID' }] },
    });
    const badDate = await runRegionAuditCli(['--region', REGION, '--release', '2026-02-31.0'], { cwd: fixture.root });
    assert.deepEqual(badDate.result.failures, [{ countryCode: 'GLOBAL', code: 'ARGUMENT_RELEASE_INVALID' }]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
