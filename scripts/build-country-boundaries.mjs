import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { topology } from 'topojson-server';
import { presimplify, simplify } from 'topojson-simplify';

import { normalizeFeatureCollection, normalizeMetadata } from './lib/boundary-normalize.mjs';

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const QUANTIZATION = 100_000;
const COUNTRY_CONFIG = Object.freeze({
  CN: Object.freeze({ administrativeScheme: '地级行政区', acceptedLevels: ['prefecture'], simplificationTolerance: 1e-10 }),
  US: Object.freeze({ administrativeScheme: '县及独立市等同行政区', acceptedLevels: ['county', 'independent-city'], simplificationTolerance: 1e-10 }),
});

export async function buildCountryBoundaries({ inputDir, outputDir }) {
  if (typeof inputDir !== 'string' || typeof outputDir !== 'string') throw new Error('inputDir and outputDir are required');
  const entries = (await readdir(inputDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (entries.length === 0) throw new Error('input directory contains no country files');
  const manifest = {};
  const outputs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Z]{2}\.geojson$/.test(entry.name)) {
      throw new Error(`invalid country file name: ${entry.name}`);
    }
    const countryCode = entry.name.slice(0, 2);
    const config = COUNTRY_CONFIG[countryCode];
    if (!config) throw new Error(`country scheme is not configured: ${countryCode}`);
    const inputPath = path.join(inputDir, entry.name);
    const fileStat = await stat(inputPath);
    if (fileStat.size === 0 || fileStat.size > MAX_INPUT_BYTES) throw new Error(`input size limit exceeded: ${entry.name}`);
    const raw = await readFile(inputPath, 'utf8');
    const parsed = parseJson(raw, entry.name);
    const normalized = normalizeFeatureCollection(parsed, countryCode, config);
    const metadata = normalizeMetadata(parsed.metadata);
    const packageObject = createTopologyPackage(countryCode, config, metadata, normalized);
    const packageBytes = Buffer.from(`${canonicalJson(packageObject)}\n`, 'utf8');
    const checksum = createHash('sha256').update(packageBytes).digest('hex');

    manifest[countryCode] = {
      schemaVersion: 1,
      countryCode,
      boundaryVersion: metadata.boundaryVersion,
      administrativeScheme: config.administrativeScheme,
      featureCount: normalized.features.length,
      byteSize: packageBytes.byteLength,
      checksum,
      updatedAt: metadata.retrievedAt,
      source: metadata.source,
      attribution: metadata.attribution,
    };
    outputs.push([`${countryCode}.topojson`, packageBytes]);
  }

  await mkdir(outputDir, { recursive: true });
  for (const [fileName, bytes] of outputs) await writeFile(path.join(outputDir, fileName), bytes);
  await writeFile(path.join(outputDir, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8');
  return manifest;
}

function createTopologyPackage(countryCode, config, metadata, collection) {
  let result = topology({ areas: collection }, QUANTIZATION);
  result = presimplify(result);
  result = simplify(result, config.simplificationTolerance);
  return {
    type: 'Topology',
    schemaVersion: 1,
    countryCode,
    boundaryVersion: metadata.boundaryVersion,
    administrativeScheme: config.administrativeScheme,
    source: metadata.source,
    attribution: metadata.attribution,
    objects: result.objects,
    arcs: result.arcs,
    ...(result.transform === undefined ? {} : { transform: result.transform }),
    ...(result.bbox === undefined ? {} : { bbox: result.bbox }),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('cannot serialize undefined');
  return serialized;
}

function parseJson(raw, fileName) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${fileName}`);
  }
}

function parseCliArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output') {
    throw new Error('usage: node scripts/build-country-boundaries.mjs --input <dir> --output <dir>');
  }
  return { inputDir: path.resolve(argv[1]), outputDir: path.resolve(argv[3]) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCountryBoundaries(parseCliArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'boundary build failed'}\n`);
    process.exitCode = 1;
  });
}
