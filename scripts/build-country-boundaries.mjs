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
  CN: Object.freeze({ administrativeScheme: '地级行政区', acceptedLevels: ['prefecture'], simplificationTolerance: 1e-10, nameZh: '中国', nameLocal: 'China', aliases: ['中华人民共和国', 'PRC'] }),
  US: Object.freeze({ administrativeScheme: '县及独立市等同行政区', acceptedLevels: ['county', 'independent-city'], simplificationTolerance: 1e-10, nameZh: '美国', nameLocal: 'United States', aliases: ['USA', 'US'] }),
});

export async function buildCountryBoundaries({ inputDir, outputDir, indexModulePath }) {
  if (typeof inputDir !== 'string' || typeof outputDir !== 'string') throw new Error('inputDir and outputDir are required');
  const entries = (await readdir(inputDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (entries.length === 0) throw new Error('input directory contains no country files');
  const manifest = {};
  const outputs = [];
  const indexRecords = [];
  const indexIds = new Set();

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
    indexRecords.push({
      kind: 'country', countryCode, boundaryVersion: metadata.boundaryVersion,
      nameZh: config.nameZh, nameLocal: config.nameLocal, aliases: config.aliases,
    });
    for (const { properties } of normalized.features) {
      if (indexIds.has(properties.areaId)) throw new Error(`duplicate area index ID: ${properties.areaId}`);
      indexIds.add(properties.areaId);
      indexRecords.push({
        kind: 'area', areaId: properties.areaId, countryCode, boundaryVersion: metadata.boundaryVersion,
        adminLevel: properties.adminLevel, ...(properties.nameZh === undefined ? {} : { nameZh: properties.nameZh }),
        nameLocal: properties.nameLocal, aliases: properties.aliases,
      });
    }
    outputs.push([`${countryCode}.topojson`, packageBytes]);
  }

  indexRecords.sort((left, right) => indexIdentity(left).localeCompare(indexIdentity(right), 'en'));
  assertIndexParity(indexRecords, outputs);

  await mkdir(outputDir, { recursive: true });
  for (const [fileName, bytes] of outputs) await writeFile(path.join(outputDir, fileName), bytes);
  await writeFile(path.join(outputDir, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'area-index.json'), `${canonicalJson(indexRecords)}\n`, 'utf8');
  if (indexModulePath !== undefined) {
    await mkdir(path.dirname(indexModulePath), { recursive: true });
    const source = `import type { AreaIndexRecord } from '../areas/area-index';\n\nexport const AREA_INDEX_RECORDS = ${escapeInlineScript(canonicalJson(indexRecords))} as const satisfies readonly AreaIndexRecord[];\n`;
    await writeFile(indexModulePath, source, 'utf8');
  }
  return manifest;
}

function indexIdentity(record) {
  return record.kind === 'country' ? `0:${record.countryCode}` : `1:${record.areaId}`;
}

function assertIndexParity(records, outputs) {
  const packageIds = new Set();
  for (const [fileName, bytes] of outputs) {
    const packageObject = JSON.parse(bytes.toString('utf8'));
    for (const geometry of packageObject.objects.areas.geometries) {
      const areaId = geometry.properties?.areaId;
      if (typeof areaId !== 'string' || packageIds.has(areaId)) throw new Error(`duplicate or missing package area ID in ${fileName}`);
      packageIds.add(areaId);
    }
  }
  const indexAreaIds = records.filter(({ kind }) => kind === 'area').map(({ areaId }) => areaId);
  if (indexAreaIds.length !== packageIds.size || indexAreaIds.some((areaId) => !packageIds.has(areaId))) {
    throw new Error('area index IDs do not match country packages');
  }
}

function escapeInlineScript(value) {
  return value.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
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
  if ((argv.length !== 4 && argv.length !== 6) || argv[0] !== '--input' || argv[2] !== '--output' || (argv.length === 6 && argv[4] !== '--index-module')) {
    throw new Error('usage: node scripts/build-country-boundaries.mjs --input <dir> --output <dir> [--index-module <file>]');
  }
  return { inputDir: path.resolve(argv[1]), outputDir: path.resolve(argv[3]), ...(argv[5] === undefined ? {} : { indexModulePath: path.resolve(argv[5]) }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCountryBoundaries(parseCliArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'boundary build failed'}\n`);
    process.exitCode = 1;
  });
}
