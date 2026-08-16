import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

import { validateRelease } from './extract-overture.mjs';

const S3_ORIGIN = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com';
const TYPES = ['division', 'division_area'];
const MAX_OBJECTS = 100_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_LISTING_BYTES = 1024 * 1024;

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeXml(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : undefined;
}

async function readBoundedText(response, byteLimit, label) {
  if (!response.body) throw new Error(`${label} has no response body`);
  const chunks = [];
  let byteSize = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    if (byteSize > byteLimit) throw new Error(`${label} exceeds ${byteLimit} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteSize).toString('utf8');
}

async function listObjects(release, type, request) {
  const prefix = `release/${release}/theme=divisions/type=${type}/`;
  const objects = [];
  let continuationToken;
  do {
    const url = new URL(S3_ORIGIN);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    const xml = await request(url, async (response) => {
      if (!response.ok) throw new Error(`source listing failed with HTTP ${response.status}`);
      return readBoundedText(response, MAX_LISTING_BYTES, 'source listing');
    });
    if (/<Error>/.test(xml)) throw new Error(`source listing returned an S3 error for ${type}`);
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(match[1], 'Key');
      const byteSize = Number(tag(match[1], 'Size'));
      const etag = tag(match[1], 'ETag')?.replace(/^"|"$/g, '');
      if (!key?.startsWith(prefix) || !Number.isSafeInteger(byteSize) || byteSize <= 0 || !etag) throw new Error(`invalid source listing entry for ${type}`);
      objects.push({ key: key.slice(`release/${release}/`.length), byteSize, etag });
      if (objects.length > MAX_OBJECTS) throw new Error('source object limit exceeded');
    }
    const truncated = tag(xml, 'IsTruncated') === 'true';
    continuationToken = truncated ? tag(xml, 'NextContinuationToken') : undefined;
    if (truncated && !continuationToken) throw new Error('truncated source listing omitted continuation token');
  } while (continuationToken);
  if (objects.length === 0) throw new Error(`source listing contained no ${type} objects`);
  return objects;
}

async function hashObject(release, object, request) {
  const encodedKey = object.key.split('/').map(encodeURIComponent).join('/');
  const url = `${S3_ORIGIN}/release/${release}/${encodedKey}`;
  return request(url, async (response) => {
    if (!response.ok) throw new Error(`source object ${object.key} failed with HTTP ${response.status}`);
    if (!response.body) throw new Error(`source object ${object.key} has no response body`);
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > object.byteSize) throw new Error(`source object size mismatch: ${object.key}`);
      hash.update(bytes);
    }
    if (byteSize !== object.byteSize) throw new Error(`source object size mismatch: ${object.key}`);
    return { ...object, url, sha256: hash.digest('hex') };
  });
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs, consume) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`source request timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    controller.abort();
  }
}

export async function snapshotSourceManifest({ release, outputPath, fetchImpl = globalThis.fetch, retrievedAt, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  validateRelease(release);
  if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.includes('\0')) throw new Error('invalid snapshot output path');
  if (typeof retrievedAt !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(retrievedAt)) throw new Error('retrievedAt must be an ISO date');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('requestTimeoutMs must be a positive integer');
  const temporaryPath = `${outputPath}.${randomUUID()}.partial`;
  try {
    const request = (url, consume) => fetchWithTimeout(fetchImpl, url, requestTimeoutMs, consume);
    const listed = (await Promise.all(TYPES.map((type) => listObjects(release, type, request)))).flat();
    const unique = new Map();
    for (const object of listed) {
      if (unique.has(object.key)) throw new Error(`duplicate source object: ${object.key}`);
      unique.set(object.key, object);
    }
    const objects = [];
    for (const object of [...unique.values()].sort((left, right) => compareCodeUnits(left.key, right.key))) {
      objects.push(await hashObject(release, object, request));
    }
    const snapshot = { schemaVersion: 1, release, retrievedAt, objects };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, outputPath);
    return snapshot;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseCliArguments(argv) {
  if (argv.length !== 6 || argv[0] !== '--release' || argv[2] !== '--output' || argv[4] !== '--retrieved-at') {
    throw new Error('usage: node scripts/audit/snapshot-source-manifest.mjs --release <release> --output <file> --retrieved-at <YYYY-MM-DD>');
  }
  return { release: argv[1], outputPath: path.resolve(argv[3]), retrievedAt: argv[5] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  snapshotSourceManifest(parseCliArguments(process.argv.slice(2))).then((snapshot) => {
    process.stdout.write(`${JSON.stringify({ release: snapshot.release, objectCount: snapshot.objects.length })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'source snapshot failed'}\n`);
    process.exitCode = 1;
  });
}
