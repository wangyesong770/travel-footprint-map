import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { URL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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

function response(body, status = 200) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* streamBody() { yield bytes; })(),
    async text() { return new TextDecoder().decode(bytes); },
  };
}

describe('fixed-release Overture extractor', () => {
  it('uses fixed release URLs, bound source codes, a land join, and stable ID ordering', async () => {
    const outputDir = await temporaryDirectory();
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
      outputDir,
      runner,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: 'duckdb', args: ['-version'], options: { shell: false } });
    expect(calls[1].command).toBe('duckdb');
    expect(calls[1].options.shell).toBe(false);
    const sql = calls[1].options.input;
    expect(sql).toContain('s3://overturemaps-us-west-2/release/2026-06-17.0/theme=divisions/type=division/*');
    expect(sql).toContain('s3://overturemaps-us-west-2/release/2026-06-17.0/theme=divisions/type=division_area/*');
    expect(sql).toContain("SET VARIABLE source_country_codes = ['CN', 'HK', 'MO', 'TW']");
    expect(sql).toMatch(/division\.id\s*=\s*division_area\.division_id/);
    expect(sql).toMatch(/division_area\.is_land\s*=\s*true/);
    expect(sql).toContain('division.admin_level AS adminLevel');
    expect(sql).toContain('division.local_type AS localType');
    expect(sql).toMatch(/ORDER BY\s+division\.id/i);
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
    const outputDir = await temporaryDirectory();
    let call = 0;
    const runner = async (_command, args, options) => {
      call += 1;
      if (args[0] === '-version') return { exitCode: 0, stdout: 'DuckDB v1.4.0', stderr: '' };
      await writeFile(options.expectedOutputPath, 'partial', 'utf8');
      return { exitCode: 9, stdout: '', stderr: 'remote parquet unavailable' };
    };

    await expect(extractCountry({ release: '2026-06-17.0', country: 'US', outputDir, runner }))
      .rejects.toThrow(/DuckDB extraction failed.*remote parquet unavailable/);
    expect(call).toBe(2);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it('rejects missing DuckDB with an actionable preflight error', async () => {
    const runner = async () => { throw Object.assign(new Error('spawn duckdb ENOENT'), { code: 'ENOENT' }); };
    await expect(extractCountry({ release: '2026-06-17.0', country: 'US', outputDir: await temporaryDirectory(), runner }))
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
