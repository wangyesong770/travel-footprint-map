import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { profileCountry } from './profile-country.mjs';

const RELEASE = '2026-06-17.0';
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(sourceCodes = ['CN', 'HK']) {
  const root = await mkdtemp(path.join(tmpdir(), 'country-profile-'));
  temporaryDirectories.push(root);
  const snapshot = path.join(root, 'snapshot');
  const metadataRoot = path.join(snapshot, 'division-metadata');
  await mkdir(metadataRoot, { recursive: true });
  const rowCounts = {};
  for (const code of sourceCodes) {
    rowCounts[code] = code === 'CN' ? 12 : 3;
    const partition = path.join(metadataRoot, `sourceCountryCode=${code}`);
    await mkdir(partition);
    await writeFile(path.join(partition, 'data_0.parquet'), `fixture-${code}`);
  }
  await writeFile(path.join(snapshot, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    schema: { version: 1, format: 'partitioned-parquet', partitionKey: 'sourceCountryCode' },
    release: RELEASE,
    duckdbVersion: 'DuckDB v1.5.5',
    sourceSnapshotSha256: 'a'.repeat(64),
    totalRowCount: Object.values(rowCounts).reduce((sum, count) => sum + count, 0),
    rowCounts,
  })}\n`);
  return { root, snapshot, metadataRoot };
}

function successfulDuckDbRows() {
  return [
    { sourceCountryCode: 'HK', subtype: 'locality', adminLevel: 8, localType: 'district', count: 3, namedCount: 2 },
    { sourceCountryCode: 'CN', subtype: 'locality', adminLevel: 7, localType: 'city', count: 10, namedCount: 9 },
    { sourceCountryCode: 'CN', subtype: 'locality', adminLevel: null, localType: null, count: 2, namedCount: 0 },
  ];
}

describe('read-only country profile', () => {
  it('profiles only explicit local division-metadata partitions and emits canonical aggregate JSON', async () => {
    const f = await fixture();
    const calls = [];
    const runner = async (command, args, options) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: JSON.stringify(successfulDuckDbRows()), stderr: '' };
    };

    const result = await profileCountry([
      '--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'HK,CN',
    ], { runner, duckdbPath: 'duckdb-test' });

    expect(result).toEqual({
      exitCode: 0,
      result: {
        schemaVersion: 1,
        status: 'profiled',
        countryCode: 'CN',
        release: RELEASE,
        sourceCountryCodes: ['CN', 'HK'],
        totalCount: 15,
        nameCoverage: { namedCount: 11, missingCount: 4, ratio: 0.733333 },
        combinations: [
          { sourceCountryCode: 'CN', subtype: 'locality', adminLevel: null, localType: null, count: 2, namedCount: 0 },
          { sourceCountryCode: 'CN', subtype: 'locality', adminLevel: 7, localType: 'city', count: 10, namedCount: 9 },
          { sourceCountryCode: 'HK', subtype: 'locality', adminLevel: 8, localType: 'district', count: 3, namedCount: 2 },
        ],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'duckdb-test', args: ['-json', ':memory:'] });
    const sql = calls[0].options.input;
    expect(sql).toContain(path.join(f.metadataRoot, 'sourceCountryCode=CN', 'data_0.parquet'));
    expect(sql).toContain(path.join(f.metadataRoot, 'sourceCountryCode=HK', 'data_0.parquet'));
    expect(sql).not.toContain(path.join(f.snapshot, 'data'));
    expect(sql).not.toMatch(/geometry|https?:|s3:|\bINSTALL\b|\bLOAD\b/i);
    expect(calls[0].options.maxOutputBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('strictly rejects unsupported, duplicate, malformed, and output-path arguments before DuckDB', async () => {
    const f = await fixture();
    let called = false;
    const runner = async () => { called = true; return { exitCode: 0, stdout: '[]', stderr: '' }; };
    const cases = [
      ['--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN', '--output', 'leak.json'],
      ['--country', 'CN', '--country', 'US', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN'],
      ['--country', 'cn', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN'],
      ['--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN,CN'],
      ['--country', 'CN', '--release', '2026-02-30.0', '--snapshot', f.snapshot, '--source-codes', 'CN'],
    ];
    for (const args of cases) {
      const { exitCode, result } = await profileCountry(args, { runner });
      expect(exitCode).toBe(1);
      expect(result).toMatchObject({ status: 'failed', failures: [{ code: 'ARGUMENT_INVALID' }] });
    }
    expect(called).toBe(false);
  });

  it('rejects mismatched, malformed, and oversized snapshot metadata with redacted stable errors', async () => {
    for (const corruption of ['release', 'json', 'oversized', 'unknown-key']) {
      const f = await fixture(['CN']);
      const metadataPath = path.join(f.snapshot, 'metadata.json');
      if (corruption === 'release') {
        await writeFile(metadataPath, `${JSON.stringify({
          schemaVersion: 1,
          schema: { version: 1, format: 'partitioned-parquet', partitionKey: 'sourceCountryCode' },
          release: '2026-06-18.0', duckdbVersion: 'x', sourceSnapshotSha256: 'a'.repeat(64), totalRowCount: 12, rowCounts: { CN: 12 },
        })}\n`);
      } else if (corruption === 'json') await writeFile(metadataPath, '{not-json');
      else if (corruption === 'oversized') await truncate(metadataPath, 1024 * 1024 + 1);
      else {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        await writeFile(metadataPath, `${JSON.stringify({ ...metadata, unexpected: true })}\n`);
      }
      const output = await profileCountry([
        '--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN',
      ], { runner: async () => { throw new Error('must not run'); } });
      expect(output).toEqual({
        exitCode: 1,
        result: { status: 'failed', countryCode: 'CN', release: RELEASE, failures: [{ code: 'SNAPSHOT_INVALID', subject: 'snapshot' }] },
      });
      expect(JSON.stringify(output)).not.toContain(f.root);
    }
  });

  it('rejects symlinked snapshots, partitions, and parquet files before DuckDB', async () => {
    const original = await fixture(['CN']);
    const cases = [];
    const linkedRoot = path.join(original.root, 'linked-snapshot');
    await symlink(original.snapshot, linkedRoot, 'dir');
    cases.push(linkedRoot);

    const linkedPartition = await fixture(['CN']);
    const targetPartition = path.join(linkedPartition.root, 'outside');
    await mkdir(targetPartition);
    await writeFile(path.join(targetPartition, 'data.parquet'), 'outside');
    await rm(path.join(linkedPartition.metadataRoot, 'sourceCountryCode=CN'), { recursive: true });
    await symlink(targetPartition, path.join(linkedPartition.metadataRoot, 'sourceCountryCode=CN'), 'dir');
    cases.push(linkedPartition.snapshot);

    const linkedFile = await fixture(['CN']);
    const targetFile = path.join(linkedFile.root, 'outside.parquet');
    await writeFile(targetFile, 'outside');
    await rm(path.join(linkedFile.metadataRoot, 'sourceCountryCode=CN', 'data_0.parquet'));
    await symlink(targetFile, path.join(linkedFile.metadataRoot, 'sourceCountryCode=CN', 'data_0.parquet'));
    cases.push(linkedFile.snapshot);

    const linkedMetadata = await fixture(['CN']);
    const metadataTarget = path.join(linkedMetadata.root, 'outside-metadata.json');
    await rename(path.join(linkedMetadata.snapshot, 'metadata.json'), metadataTarget);
    await symlink(metadataTarget, path.join(linkedMetadata.snapshot, 'metadata.json'));
    cases.push(linkedMetadata.snapshot);

    let calls = 0;
    for (const snapshot of cases) {
      const output = await profileCountry([
        '--country', 'CN', '--release', RELEASE, '--snapshot', snapshot, '--source-codes', 'CN',
      ], { runner: async () => { calls += 1; return { exitCode: 0, stdout: '[]', stderr: '' }; } });
      expect(output.result.failures).toEqual([{ code: 'SNAPSHOT_UNSAFE', subject: 'snapshot' }]);
    }
    expect(calls).toBe(0);
  });

  it('rejects missing source partitions and oversized profile inputs without scanning', async () => {
    const missing = await fixture(['CN']);
    let calls = 0;
    const missingResult = await profileCountry([
      '--country', 'CN', '--release', RELEASE, '--snapshot', missing.snapshot, '--source-codes', 'CN,HK',
    ], { runner: async () => { calls += 1; return { exitCode: 0, stdout: '[]', stderr: '' }; } });
    expect(missingResult.result.failures).toEqual([{ code: 'SNAPSHOT_INVALID', subject: 'source-codes' }]);

    const oversized = await fixture(['CN']);
    await truncate(path.join(oversized.metadataRoot, 'sourceCountryCode=CN', 'data_0.parquet'), 1024 * 1024 * 1024 + 1);
    const oversizedResult = await profileCountry([
      '--country', 'CN', '--release', RELEASE, '--snapshot', oversized.snapshot, '--source-codes', 'CN',
    ], { runner: async () => { calls += 1; return { exitCode: 0, stdout: '[]', stderr: '' }; } });
    expect(oversizedResult.result.failures).toEqual([{ code: 'SNAPSHOT_TOO_LARGE', subject: 'division-metadata' }]);
    expect(calls).toBe(0);
  });

  it('maps DuckDB failures and malformed/truncated output to stable errors without leaking details', async () => {
    const f = await fixture(['CN']);
    for (const response of [
      { exitCode: 9, stdout: '', stderr: `secret ${f.root}` },
      { exitCode: 0, stdout: '{bad', stderr: '' },
      { exitCode: 0, stdout: '[]', stderr: '', stdoutTruncated: true },
    ]) {
      const output = await profileCountry([
        '--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN',
      ], { runner: async () => response });
      expect(output.result.failures).toEqual([{ code: 'DUCKDB_FAILED', subject: 'profile' }]);
      expect(JSON.stringify(output)).not.toContain(f.root);
    }
  });

  it('rejects a partial source profile instead of presenting it as complete', async () => {
    const f = await fixture(['CN', 'HK']);
    const output = await profileCountry([
      '--country', 'CN', '--release', RELEASE, '--snapshot', f.snapshot, '--source-codes', 'CN,HK',
    ], {
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(successfulDuckDbRows().filter(({ sourceCountryCode }) => sourceCountryCode === 'CN')),
        stderr: '',
      }),
    });
    expect(output.result.failures).toEqual([{ code: 'DUCKDB_FAILED', subject: 'profile' }]);
  });

  it('CLI emits exactly one compact JSON line for invalid input', () => {
    const modulePath = path.resolve(process.cwd(), 'scripts/audit/profile-country.mjs');
    let stdout = '';
    try {
      execFileSync(process.execPath, [modulePath, '--output', 'forbidden'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stdout = error.stdout;
      expect(error.status).toBe(1);
    }
    expect(stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(stdout)).toEqual({ status: 'failed', failures: [{ code: 'ARGUMENT_INVALID', subject: 'argument' }] });
  });
});
