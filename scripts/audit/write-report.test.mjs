import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  canonicalJson,
  verifyCountryReportBinding,
  writeAuditSummary,
  writeCountryAuditReport,
} from './write-report.mjs';

async function withFixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'audit-report-'));
  const packagePath = path.join(directory, 'CN.topojson');
  const reportPath = path.join(directory, 'CN.json');
  const bytes = Buffer.from('{"arcs":[],"type":"Topology"}\n');
  await writeFile(packagePath, bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  try {
    await run({ directory, packagePath, reportPath, bytes, checksum });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    countryCode: 'CN',
    status: 'verified',
    sourceRelease: '2026-06-17.0',
    selectorVersion: 4,
    productLevel: 'prefecture',
    sourceCountryCodes: ['TW', 'CN', 'HK', 'MO'],
    counts: { source: 410, selected: 350, excluded: 60, allowlisted: 2, denylisted: 1 },
    geometry: { invalid: 0, duplicate: 0, overlap: 0, missingName: 0 },
    vertices: { p50: 110, p95: 900, max: 1400 },
    compressedBytes: { topojson: 31, gzip: 22, brotli: 18 },
    performanceMs: { extract: 50, select: 4, audit: 20, build: 30, parse: 8 },
    exceptions: ['CN-FLYWAY-001'],
    references: [{
      title: '中华人民共和国行政区划代码',
      url: 'https://www.mca.gov.cn/mzsj/xzqh/',
      retrievedOn: '2026-08-16',
      license: '中华人民共和国民政部公开信息',
    }],
    generatorCommit: '0123456789abcdef0123456789abcdef01234567',
    auditedOn: '2026-08-16',
    attribution: '© Overture Maps Foundation contributors; ODbL 1.0',
    ...overrides,
  };
}

function manifest(checksum, byteSize) {
  return {
    countryCode: 'CN',
    boundaryVersion: '2026-06-17.0',
    attribution: '© Overture Maps Foundation contributors; ODbL 1.0',
    checksum,
    byteSize,
  };
}

test('writes canonical reports with stable bytes and sorted source codes', async () => {
  await withFixture(async ({ directory, packagePath, reportPath, bytes, checksum }) => {
    const secondPath = path.join(directory, 'CN-second.json');
    const input = evidence();
    const first = await writeCountryAuditReport({
      packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength), evidence: input,
      expectedSelectorVersion: 4,
    });
    await writeCountryAuditReport({
      packagePath, reportPath: secondPath, manifestEntry: manifest(checksum, bytes.byteLength), evidence: input,
      expectedSelectorVersion: 4,
    });

    assert.deepEqual(await readFile(reportPath), await readFile(secondPath));
    assert.equal((await readFile(reportPath, 'utf8')), `${canonicalJson(first)}\n`);
    assert.deepEqual(first.sourceCountryCodes, ['CN', 'HK', 'MO', 'TW']);
    assert.equal(first.packageChecksum, checksum);
    assert.equal(first.packageByteSize, bytes.byteLength);
  });
});

test('rejects checksum or byte-size disagreement with final package bytes', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    await assert.rejects(
      writeCountryAuditReport({
        packagePath, reportPath, manifestEntry: manifest('0'.repeat(64), bytes.byteLength),
        evidence: evidence(), expectedSelectorVersion: 4,
      }),
      /checksum mismatch/i,
    );
    await assert.rejects(
      writeCountryAuditReport({
        packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength + 1),
        evidence: evidence(), expectedSelectorVersion: 4,
      }),
      /byte size mismatch/i,
    );
  });
});

test('rejects country, release, or attribution disagreement with the manifest', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    const base = { packagePath, reportPath, evidence: evidence(), expectedSelectorVersion: 4 };
    await assert.rejects(
      writeCountryAuditReport({ ...base, manifestEntry: { ...manifest(checksum, bytes.byteLength), countryCode: 'US' } }),
      /country mismatch/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, manifestEntry: { ...manifest(checksum, bytes.byteLength), boundaryVersion: '2026-07-23.0' } }),
      /release mismatch/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, manifestEntry: { ...manifest(checksum, bytes.byteLength), attribution: 'different' } }),
      /attribution mismatch/i,
    );
  });
});

test('rejects a stale selector version', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    await assert.rejects(
      writeCountryAuditReport({
        packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength),
        evidence: evidence({ selectorVersion: 3 }), expectedSelectorVersion: 4,
      }),
      /selector version mismatch/i,
    );
  });
});

test('requires dated and licensed official references', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    const base = { packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength), expectedSelectorVersion: 4 };
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ references: [{ title: 'MCA', url: 'https://www.mca.gov.cn/', license: '公开信息' }] }) }),
      /reference retrievedOn/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ references: [{ title: 'MCA', url: 'https://www.mca.gov.cn/', retrievedOn: '2026-08-16' }] }) }),
      /reference license/i,
    );
  });
});

test('rejects secret-looking fields, absolute host paths, and nondeterministic timestamps', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    const base = { packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength), expectedSelectorVersion: 4 };
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ apiToken: 'ghp_example' }) }),
      /secret-looking key/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ exceptions: ['/home/alice/audit.json'] }) }),
      /absolute host path/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ productLevel: '/workspace/private' }) }),
      /absolute host path/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ auditedOn: '2026-08-16T12:34:56.000Z' }) }),
      /date-only|timestamp/i,
    );
    await assert.rejects(
      writeCountryAuditReport({ ...base, evidence: evidence({ auditedOn: '2026-02-31' }) }),
      /date-only/i,
    );
    await assert.rejects(
      writeCountryAuditReport({
        ...base,
        evidence: evidence({
          references: [{
            title: 'MCA', url: 'https://www.mca.gov.cn/reference?access_token=ghp_example',
            retrievedOn: '2026-08-16', license: '公开信息',
          }],
        }),
      }),
      /credential|secret/i,
    );
  });
});

test('rejects unknown non-secret fields instead of silently preserving unreviewed evidence', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    await assert.rejects(
      writeCountryAuditReport({
        packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength),
        evidence: evidence({ workstation: 'builder-7' }), expectedSelectorVersion: 4,
      }),
      /unknown report key/i,
    );
  });
});

test('does not reuse a report after package bytes change', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    await writeCountryAuditReport({
      packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength), evidence: evidence(), expectedSelectorVersion: 4,
    });
    await writeFile(packagePath, '{"changed":true}\n');
    await assert.rejects(
      verifyCountryReportBinding({ packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength) }),
      /checksum mismatch|byte size mismatch/i,
    );
  });
});

test('revalidates nested whitelist fields when checking a stored report', async () => {
  await withFixture(async ({ packagePath, reportPath, bytes, checksum }) => {
    const report = await writeCountryAuditReport({
      packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength), evidence: evidence(), expectedSelectorVersion: 4,
    });
    report.counts.unreviewed = 1;
    await writeFile(reportPath, `${canonicalJson(report)}\n`);
    await assert.rejects(
      verifyCountryReportBinding({ packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength) }),
      /unknown counts key/i,
    );
  });
});

test('writes a deterministic summary bound to verified country reports', async () => {
  await withFixture(async ({ directory, packagePath, reportPath, bytes, checksum }) => {
    await writeCountryAuditReport({
      packagePath, reportPath, manifestEntry: manifest(checksum, bytes.byteLength), evidence: evidence(), expectedSelectorVersion: 4,
    });
    const summaryPath = path.join(directory, 'summary.json');
    const secondPath = path.join(directory, 'summary-second.json');
    const options = {
      reportPaths: [reportPath], sourceRelease: '2026-06-17.0',
      generatorCommit: '0123456789abcdef0123456789abcdef01234567',
    };
    const summary = await writeAuditSummary({ ...options, outputPath: summaryPath });
    await writeAuditSummary({ ...options, outputPath: secondPath });
    assert.deepEqual(await readFile(summaryPath), await readFile(secondPath));
    assert.deepEqual(summary.countries, [{
      countryCode: 'CN', packageByteSize: bytes.byteLength, packageChecksum: checksum,
      selectorVersion: 4, status: 'verified',
    }]);
  });
});
