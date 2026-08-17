import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { URL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import * as overtureExtractor from './extract-overture.mjs';
import { extractCountry } from './extract-overture.mjs';
import { snapshotSourceManifest } from './snapshot-source-manifest.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'overture-extract-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function localSnapshot(directory, rowCounts, metadataOverrides = {}) {
  const snapshotDir = path.join(directory, 'snapshot');
  await Promise.all([
    mkdir(path.join(snapshotDir, 'data'), { recursive: true }),
    mkdir(path.join(snapshotDir, 'division-metadata', 'sourceCountryCode=MO'), { recursive: true }),
  ]);
  await writeFile(path.join(snapshotDir, 'division-metadata', 'sourceCountryCode=MO', 'fixture.parquet'), 'fixture', 'utf8');
  await writeFile(path.join(snapshotDir, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    release: '2026-06-17.0',
    sourceSnapshotSha256: 'a'.repeat(64),
    rowCounts,
    totalRowCount: Object.values(rowCounts).reduce((sum, count) => sum + count, 0),
    unresolved: { rowCount: 0, byteSize: 128, sha256: 'b'.repeat(64) },
    ...metadataOverrides,
  })}\n`, 'utf8');
  return snapshotDir;
}

function response(body, status = 200) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* streamBody() { yield bytes; })(),
    async text() { return new TextDecoder().decode(bytes); },
  };
}

const sourceManifest = (overrides = {}) => ({
  schemaVersion: 1,
  release: '2026-06-17.0',
  retrievedAt: '2026-08-16',
  objects: [
    {
      key: 'theme=divisions/type=division/part.parquet', byteSize: 3, etag: 'division-etag',
      url: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme%3Ddivisions/type%3Ddivision/part.parquet',
      sha256: 'a'.repeat(64),
    },
    {
      key: 'theme=divisions/type=division_area/part.parquet', byteSize: 4, etag: 'area-etag',
      url: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme%3Ddivisions/type%3Ddivision_area/part.parquet',
      sha256: 'b'.repeat(64),
    },
  ],
  ...overrides,
});

describe('fixed-release Overture extractor', () => {
  it('provides a one-time release snapshot stage before country extraction', () => {
    expect(overtureExtractor.createDivisionSnapshot).toBeTypeOf('function');
  });

  it('refuses country extraction when unresolved snapshot evidence is missing or nonzero', async () => {
    const directory = await temporaryDirectory();
    const runner = async () => {
      throw new Error('DuckDB must not run for an untrusted snapshot');
    };

    const missingContract = await localSnapshot(directory, { US: 1 }, { unresolved: undefined });
    await expect(extractCountry({
      release: '2026-06-17.0', country: 'US', snapshotDir: missingContract,
      outputDir: path.join(directory, 'missing-output'), runner,
    })).rejects.toThrow(/invalid unresolved evidence/);

    const unresolvedDirectory = await temporaryDirectory();
    const unresolvedSnapshot = await localSnapshot(unresolvedDirectory, { US: 1 }, {
      unresolved: { rowCount: 1, byteSize: 128, sha256: 'b'.repeat(64) },
    });
    await expect(extractCountry({
      release: '2026-06-17.0', country: 'US', snapshotDir: unresolvedSnapshot,
      outputDir: path.join(unresolvedDirectory, 'unresolved-output'), runner,
    })).rejects.toThrow(/snapshot has unresolved rows/);
  });

  it('exposes separate snapshot and country CLI modes', () => {
    expect(overtureExtractor.parseCliArguments([
      'snapshot', '--release', '2026-06-17.0', '--snapshot', 'cache/release', '--source-manifest', 'source.json',
    ])).toMatchObject({ mode: 'snapshot', release: '2026-06-17.0' });
    expect(overtureExtractor.parseCliArguments([
      'country', '--release', '2026-06-17.0', '--country', 'CN', '--snapshot', 'cache/release', '--output', 'out', '--source-codes', 'CN,HK,MO,TW',
    ])).toMatchObject({
      mode: 'country', release: '2026-06-17.0', country: 'CN', sourceCountryCodes: ['CN', 'HK', 'MO', 'TW'],
    });
  });

  it('snapshots a fixed release once with bounded memory, spill storage, and source-bound metadata', async () => {
    const directory = await temporaryDirectory();
    const snapshotDir = path.join(directory, 'snapshot');
    const sourceManifestPath = path.join(directory, 'source.json');
    const sourceBytes = `${JSON.stringify(sourceManifest(), null, 2)}\n`;
    await writeFile(sourceManifestPath, sourceBytes, 'utf8');
    const calls = [];
    const runner = async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.5.5\n', stderr: '' };
      await mkdir(path.join(options.expectedDivisionMetadataDirectory, 'sourceCountryCode=MO'), { recursive: true });
      await writeFile(path.join(options.expectedDivisionMetadataDirectory, 'sourceCountryCode=MO', 'data.parquet'), 'parquet', 'utf8');
      await mkdir(path.join(options.expectedDataDirectory, 'sourceCountryCode=MO'), { recursive: true });
      await writeFile(path.join(options.expectedDataDirectory, 'sourceCountryCode=MO', 'data.parquet'), 'parquet', 'utf8');
      await mkdir(path.join(options.expectedDataDirectory, 'sourceCountryCode=__HIVE_DEFAULT_PARTITION__'));
      await writeFile(path.join(options.expectedDataDirectory, 'sourceCountryCode=__HIVE_DEFAULT_PARTITION__', 'data.parquet'), 'invalid', 'utf8');
      await mkdir(path.join(options.expectedDataDirectory, 'sourceCountryCode=BAD'));
      await writeFile(path.join(options.expectedDataDirectory, 'sourceCountryCode=BAD', 'data.parquet'), 'invalid', 'utf8');
      await writeFile(options.expectedRowCountsPath, '[{"sourceCountryCode":"MO","rowCount":2}]\n', 'utf8');
      await writeFile(options.expectedUnresolvedPath, 'unresolved-parquet', 'utf8');
      await writeFile(options.expectedUnresolvedCountPath, '[{"rowCount":1}]\n', 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const result = await overtureExtractor.createDivisionSnapshot({
      release: '2026-06-17.0', snapshotDir, sourceManifestPath, runner,
    });

    expect(calls).toHaveLength(2);
    const sql = calls[1].options.input;
    expect(sql).toContain("SET memory_limit = '2GB'");
    expect(sql).toContain('SET threads = 1');
    expect(sql).toContain('SET partitioned_write_max_open_files = 8');
    expect(sql).toContain('SET partitioned_write_flush_threshold = 65536');
    expect(sql).toContain('SET temp_directory =');
    const divisionUrl = 's3://overturemaps-us-west-2/release/2026-06-17.0/theme=divisions/type=division/*';
    const areaUrl = 's3://overturemaps-us-west-2/release/2026-06-17.0/theme=divisions/type=division_area/*';
    expect(sql.split(divisionUrl)).toHaveLength(2);
    expect(sql.split(areaUrl)).toHaveLength(2);
    expect(sql.match(/PARTITION_BY \(sourceCountryCode\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/INNER\s+JOIN/i);
    expect(sql).not.toMatch(/CREATE\s+TEMP(?:ORARY)?\s+TABLE/i);
    expect(sql).toContain('WHERE is_land = true');
    expect(sql).toMatch(/WHERE regexp_full_match\(sourceCountryCode, '\^\[A-Z\]\{2\}\$'\)/);
    expect(sql).toMatch(/WHERE NOT coalesce\(regexp_full_match\(sourceCountryCode, '\^\[A-Z\]\{2\}\$'\), false\)/);
    expect(sql).toContain(`TO '${calls[1].options.expectedUnresolvedPath}'`);
    expect(sql).toContain(`TO '${calls[1].options.expectedDivisionMetadataDirectory}'`);
    expect(sql).toContain(`FROM read_parquet('${path.join(calls[1].options.expectedDataDirectory, '**', '*.parquet')}'`);
    const metadata = JSON.parse(await readFile(path.join(snapshotDir, 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      schema: { version: 1, format: 'partitioned-parquet', partitionKey: 'sourceCountryCode' },
      release: '2026-06-17.0',
      duckdbVersion: 'DuckDB v1.5.5',
      sourceSnapshotSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      totalRowCount: 2,
      rowCounts: { MO: 2 },
      unresolved: {
        rowCount: 1,
        byteSize: 18,
        sha256: createHash('sha256').update('unresolved-parquet').digest('hex'),
      },
    });
    expect(result.metadata).toEqual(metadata);
    expect(await readdir(path.join(snapshotDir, 'data'))).toEqual(['sourceCountryCode=MO']);
    expect((await readdir(directory)).some((name) => name.includes('.partial'))).toBe(false);
  });

  it('rejects an incomplete or forged source manifest before starting DuckDB', async () => {
    const directory = await temporaryDirectory();
    const sourceManifestPath = path.join(directory, 'source.json');
    const invalid = sourceManifest({
      objects: [{
        ...sourceManifest().objects[0],
        url: 'https://attacker.example/release/2026-06-17.0/division.parquet',
      }],
    });
    await writeFile(sourceManifestPath, `${JSON.stringify(invalid)}\n`, 'utf8');
    let called = false;

    await expect(overtureExtractor.createDivisionSnapshot({
      release: '2026-06-17.0',
      snapshotDir: path.join(directory, 'snapshot'),
      sourceManifestPath,
      runner: async () => { called = true; return { exitCode: 0, stdout: 'unexpected', stderr: '' }; },
    })).rejects.toThrow(/source manifest/i);
    expect(called).toBe(false);
  });

  it('reuses one local snapshot for multiple countries and country SQL contains no remote URL', async () => {
    const directory = await temporaryDirectory();
    const snapshotDir = path.join(directory, 'snapshot');
    const sourceManifestPath = path.join(directory, 'source.json');
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest())}\n`, 'utf8');
    const sqlCalls = [];
    let remoteSnapshotCalls = 0;
    const runner = async (_command, args, options) => {
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.5.5', stderr: '' };
      if (options.expectedDataDirectory) {
        remoteSnapshotCalls += 1;
        await mkdir(path.join(options.expectedDivisionMetadataDirectory, 'sourceCountryCode=MO'), { recursive: true });
        await writeFile(path.join(options.expectedDivisionMetadataDirectory, 'sourceCountryCode=MO', 'data.parquet'), 'fixture', 'utf8');
        await mkdir(path.join(options.expectedDataDirectory, 'sourceCountryCode=MO'), { recursive: true });
        await writeFile(path.join(options.expectedDataDirectory, 'sourceCountryCode=MO', 'data.parquet'), 'fixture', 'utf8');
        await writeFile(options.expectedRowCountsPath, '[{"sourceCountryCode":"MO","rowCount":1},{"sourceCountryCode":"US","rowCount":1}]\n', 'utf8');
        await writeFile(options.expectedUnresolvedPath, 'empty-parquet', 'utf8');
        await writeFile(options.expectedUnresolvedCountPath, '[{"rowCount":0}]\n', 'utf8');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      sqlCalls.push(options.input);
      await writeFile(options.expectedOutputPath, '{"type":"Feature"}\n', 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await overtureExtractor.createDivisionSnapshot({ release: '2026-06-17.0', snapshotDir, sourceManifestPath, runner });
    await extractCountry({ release: '2026-06-17.0', country: 'MO', snapshotDir, outputDir: path.join(directory, 'mo'), runner });
    await extractCountry({ release: '2026-06-17.0', country: 'US', snapshotDir, outputDir: path.join(directory, 'us'), runner });

    expect(remoteSnapshotCalls).toBe(1);
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls.every((sql) => !/s3:|https?:/i.test(sql))).toBe(true);
    expect(sqlCalls.every((sql) => !/\bINSTALL\b/i.test(sql))).toBe(true);
    expect(sqlCalls.every((sql) => sql.includes(path.join(snapshotDir, 'data')))).toBe(true);
  });

  it('leaves no snapshot or partial directory when remote snapshot creation fails', async () => {
    const directory = await temporaryDirectory();
    const snapshotDir = path.join(directory, 'snapshot');
    const sourceManifestPath = path.join(directory, 'source.json');
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest())}\n`, 'utf8');
    const runner = async (_command, args, options) => {
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.5.5', stderr: '' };
      await mkdir(options.expectedDataDirectory, { recursive: true });
      await writeFile(path.join(options.expectedDataDirectory, 'partial.parquet'), 'partial', 'utf8');
      return { exitCode: 9, stdout: '', stderr: 'remote join failed' };
    };

    await expect(overtureExtractor.createDivisionSnapshot({
      release: '2026-06-17.0', snapshotDir, sourceManifestPath, runner,
    })).rejects.toThrow(/snapshot failed.*remote join failed/);
    expect((await readdir(directory)).sort()).toEqual(['source.json']);
  });

  it('rejects oversized unresolved evidence without leaving a partial snapshot', async () => {
    const directory = await temporaryDirectory();
    const snapshotDir = path.join(directory, 'snapshot');
    const sourceManifestPath = path.join(directory, 'source.json');
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest())}\n`, 'utf8');
    const runner = async (_command, args, options) => {
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.5.5', stderr: '' };
      await mkdir(path.join(options.expectedDivisionMetadataDirectory, 'sourceCountryCode=MO'), { recursive: true });
      await writeFile(path.join(options.expectedDivisionMetadataDirectory, 'sourceCountryCode=MO', 'data.parquet'), 'fixture');
      await mkdir(path.join(options.expectedDataDirectory, 'sourceCountryCode=MO'), { recursive: true });
      await writeFile(path.join(options.expectedDataDirectory, 'sourceCountryCode=MO', 'data.parquet'), 'fixture');
      await writeFile(options.expectedRowCountsPath, '[{"sourceCountryCode":"MO","rowCount":1}]\n');
      await writeFile(options.expectedUnresolvedPath, 'x');
      await truncate(options.expectedUnresolvedPath, 64 * 1024 * 1024 + 1);
      await writeFile(options.expectedUnresolvedCountPath, '[{"rowCount":1}]\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await expect(overtureExtractor.createDivisionSnapshot({
      release: '2026-06-17.0', snapshotDir, sourceManifestPath, runner,
    })).rejects.toThrow(/invalid unresolved data/);
    expect((await readdir(directory)).sort()).toEqual(['source.json']);
  });

  it('executes SQL supplied on stdin through the real process runner', async () => {
    const directory = await temporaryDirectory();
    const outputDir = path.join(directory, 'output');
    const snapshotDir = await localSnapshot(directory, { MO: 1 });
    const fakeDuckDb = path.join(directory, 'duckdb');
    await writeFile(fakeDuckDb, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('-version')) {
  process.stdout.write('DuckDB fake integration v1\\n');
  process.exit(0);
}
if (process.argv.includes('-no-stdin')) process.exit(0);
const sql = readFileSync(0, 'utf8');
const match = sql.match(/\\) TO '([^']+)' WITH/);
if (!match) process.exit(2);
writeFileSync(match[1], '{"type":"Feature"}\\n');
`, 'utf8');
    await chmod(fakeDuckDb, 0o755);

    const result = await extractCountry({
      release: '2026-06-17.0',
      country: 'MO',
      snapshotDir,
      outputDir,
      duckdbPath: fakeDuckDb,
    });

    expect(await readFile(result.outputPath, 'utf8')).toBe('{"type":"Feature"}\n');
    expect((await readdir(outputDir)).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('uses bound source codes, the local snapshot, and stable ID ordering', async () => {
    const directory = await temporaryDirectory();
    const outputDir = path.join(directory, 'output');
    const snapshotDir = await localSnapshot(directory, { CN: 1, HK: 1, MO: 1, TW: 1 });
    const calls = [];
    const runner = async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.4.0\n', stderr: '' };
      await writeFile(options.expectedOutputPath, '{"type":"Feature"}\n', 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const result = await extractCountry({
      release: '2026-06-17.0',
      country: 'CN',
      sourceCountryCodes: ['CN', 'HK', 'MO', 'TW'],
      snapshotDir,
      outputDir,
      runner,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: 'duckdb', args: ['-version'], options: { shell: false } });
    expect(calls[1].command).toBe('duckdb');
    expect(calls[1].options.shell).toBe(false);
    const sql = calls[1].options.input;
    expect(sql).not.toMatch(/s3:|https?:/i);
    expect(sql).toContain(path.join(snapshotDir, 'data'));
    expect(sql).toContain(path.join(snapshotDir, 'division-metadata'));
    expect(sql).toContain("SET VARIABLE source_country_codes = ['CN', 'HK', 'MO', 'TW']");
    expect(sql).toMatch(/true\s+AS\s+isLand/i);
    expect(sql).toMatch(/ORDER BY\s+(?:area\.)?divisionId/i);
    expect(await readFile(result.outputPath, 'utf8')).toBe('{"type":"Feature"}\n');
    expect(result.duckdbVersion).toBe('DuckDB v1.4.0');
    expect((await readdir(outputDir)).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it.each([
    { release: '2026-08-01.0;rm', country: 'CN', message: 'invalid Overture release' },
    { release: '2026-02-31.0', country: 'CN', message: 'invalid Overture release' },
    { release: '2026-06-17.0', country: 'CN;rm', message: 'invalid country code' },
    { release: '2026-06-17.0', country: 'CN', sourceCountryCodes: ['CN', "TW');DROP"], message: 'invalid source country code' },
  ])('rejects untrusted CLI values before invoking DuckDB', async (input) => {
    let invoked = false;
    await expect(extractCountry({
      ...input,
      outputDir: await temporaryDirectory(),
      runner: async () => { invoked = true; return { exitCode: 0, stdout: '', stderr: '' }; },
    })).rejects.toThrow(input.message);
    expect(invoked).toBe(false);
  });

  it('does not consume output after a nonzero DuckDB exit and deletes partial files', async () => {
    const directory = await temporaryDirectory();
    const outputDir = path.join(directory, 'output');
    const snapshotDir = await localSnapshot(directory, { US: 1 });
    let call = 0;
    const runner = async (_command, args, options) => {
      call += 1;
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.4.0', stderr: '' };
      await writeFile(options.expectedOutputPath, 'partial', 'utf8');
      return { exitCode: 9, stdout: '', stderr: 'remote parquet unavailable' };
    };

    await expect(extractCountry({ release: '2026-06-17.0', country: 'US', snapshotDir, outputDir, runner }))
      .rejects.toThrow(/DuckDB extraction failed.*remote parquet unavailable/);
    expect(call).toBe(2);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it('rejects missing DuckDB with an actionable preflight error', async () => {
    const directory = await temporaryDirectory();
    const snapshotDir = await localSnapshot(directory, { US: 1 });
    const runner = async () => { throw Object.assign(new Error('spawn duckdb ENOENT'), { code: 'ENOENT' }); };
    await expect(extractCountry({ release: '2026-06-17.0', country: 'US', snapshotDir, outputDir: path.join(directory, 'output'), runner }))
      .rejects.toThrow(/DuckDB CLI is required/);
  });
});

describe('source-object snapshot', () => {
  it('records every object deterministically with bytes, ETag, and streamed SHA-256', async () => {
    const outputPath = path.join(await temporaryDirectory(), 'snapshot.json');
    const objects = new Map([
      ['theme=divisions/type=division/part-1.parquet', new TextEncoder().encode('division')],
      ['theme=divisions/type=division_area/part-2.parquet', new TextEncoder().encode('area')],
    ]);
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('list-type') === '2') {
        const prefix = parsed.searchParams.get('prefix');
        const relativeKey = [...objects.keys()].find((candidate) => `release/2026-06-17.0/${candidate}`.startsWith(prefix));
        const key = `release/2026-06-17.0/${relativeKey}`;
        return response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><Size>${objects.get(relativeKey).byteLength}</Size><ETag>&quot;etag-${key.length}&quot;</ETag></Contents></ListBucketResult>`);
      }
      const key = decodeURIComponent(parsed.pathname.replace(/^\/release\/2026-06-17\.0\//, ''));
      return response(objects.get(key));
    };

    const snapshot = await snapshotSourceManifest({ release: '2026-06-17.0', outputPath, fetchImpl, retrievedAt: '2026-08-16' });
    expect(snapshot.objects.map(({ key }) => key)).toEqual([...objects.keys()].sort());
    expect(snapshot.objects.every(({ url }) => url.startsWith('https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/'))).toBe(true);
    expect(snapshot.objects.every(({ byteSize, etag, sha256 }) => byteSize > 0 && etag && /^[a-f0-9]{64}$/.test(sha256))).toBe(true);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(snapshot);
    expect((await readdir(path.dirname(outputPath))).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('leaves no snapshot or partial file when an object download fails', async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, 'snapshot.json');
    const fetchImpl = async (url) => {
      if (new URL(url).searchParams.get('list-type') === '2') {
        const type = new URL(url).searchParams.get('prefix').includes('division_area') ? 'division_area' : 'division';
        return response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>release/2026-06-17.0/theme=divisions/type=${type}/part.parquet</Key><Size>3</Size><ETag>&quot;x&quot;</ETag></Contents></ListBucketResult>`);
      }
      return response('denied', 403);
    };
    await expect(snapshotSourceManifest({ release: '2026-06-17.0', outputPath, fetchImpl, retrievedAt: '2026-08-16' }))
      .rejects.toThrow(/HTTP 403/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('aborts a stalled source request without writing evidence', async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, 'snapshot.json');
    const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    });

    await expect(snapshotSourceManifest({
      release: '2026-06-17.0',
      outputPath,
      fetchImpl,
      retrievedAt: '2026-08-16',
      requestTimeoutMs: 5,
    })).rejects.toThrow(/source request timed out/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps the deadline active while consuming a response body', async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, 'snapshot.json');
    const fetchImpl = async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: (async function* stalledBody() {
        yield new TextEncoder().encode('<ListBucketResult>');
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true }));
      })(),
      async text() {
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true }));
      },
    });

    await expect(snapshotSourceManifest({
      release: '2026-06-17.0', outputPath, fetchImpl, retrievedAt: '2026-08-16', requestTimeoutMs: 5,
    })).rejects.toThrow(/source request timed out/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects an oversized listing before XML parsing', async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, 'snapshot.json');
    const oversized = new Uint8Array((1024 * 1024) + 1).fill(65);
    let textCalled = false;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      body: (async function* oversizedBody() { yield oversized; })(),
      async text() { textCalled = true; return new TextDecoder().decode(oversized); },
    });

    await expect(snapshotSourceManifest({
      release: '2026-06-17.0', outputPath, fetchImpl, retrievedAt: '2026-08-16', requestTimeoutMs: 100,
    })).rejects.toThrow(/source listing exceeds 1048576 bytes/);
    expect(textCalled).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
});
