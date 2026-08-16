#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';

const MAX_MERCATOR_LATITUDE = 85.05112878;
const WIDTH = 1000;
const HEIGHT = 500;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const ARCHIVE_STEM = 'ne_10m_admin_0_countries_chn';
export const NATURAL_EARTH_SOURCE = Object.freeze({
  dataset: 'Natural Earth Admin 0 Countries',
  scale: '10m',
  version: '5.1.1',
  perspective: 'China',
  url: 'https://naturalearth.s3.amazonaws.com/5.1.1/10m_cultural/ne_10m_admin_0_countries_chn.zip',
  sha256: '16e7589083527d01208b9f645fc8643c767170258e9d13b59d37bc5a1f6a8758',
  license: 'Natural Earth public domain',
  licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
});
const DEFAULT_LABEL_IDS = [
  'AR', 'AU', 'BR', 'CA', 'CN', 'DE', 'EG', 'FRA',
  'GB', 'ID', 'IN', 'JP', 'MX', 'RU', 'US', 'ZA',
];

function project(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error('坐标必须是有限数值');
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error('经纬度超出范围');
  }
  const lat = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
  const radians = lat * Math.PI / 180;
  return [
    (longitude + 180) / 360 * WIDTH,
    (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * HEIGHT,
  ];
}

function format(value, precision) {
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function perpendicularDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / Math.hypot(dx, dy);
}

function simplify(points, tolerance) {
  if (points.length <= 4 || tolerance <= 0) return points;
  const open = points.slice(0, -1);
  const keep = new Set([0, open.length - 1]);
  const visit = (first, last) => {
    let maximum = 0;
    let selected = -1;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularDistance(open[index], open[first], open[last]);
      if (distance > maximum) {
        maximum = distance;
        selected = index;
      }
    }
    if (selected >= 0 && maximum > tolerance) {
      keep.add(selected);
      visit(first, selected);
      visit(selected, last);
    }
  };
  visit(0, open.length - 1);
  const result = [...keep].sort((a, b) => a - b).map((index) => open[index]);
  if (result.length < 3) return points;
  return [...result, result[0]];
}

function clipPolygon(points, axis, bound, keepGreater) {
  const result = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const currentInside = keepGreater ? current[axis] >= bound : current[axis] <= bound;
    const previousInside = keepGreater ? previous[axis] >= bound : previous[axis] <= bound;
    if (currentInside !== previousInside) {
      const ratio = (bound - previous[axis]) / (current[axis] - previous[axis]);
      const intersection = [
        previous[0] + ratio * (current[0] - previous[0]),
        previous[1] + ratio * (current[1] - previous[1]),
      ];
      result.push(intersection);
    }
    if (currentInside) result.push(current);
  }
  return result;
}

function splitRingAtAntimeridian(value) {
  const ring = value.slice(0, -1);
  const unwrapped = [];
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) throw new Error('坐标格式无效');
    const longitude = position[0];
    const latitude = position[1];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new Error('坐标必须是有限数值');
    let adjusted = longitude;
    if (unwrapped.length > 0) {
      const previous = unwrapped[unwrapped.length - 1][0];
      while (adjusted - previous > 180) adjusted -= 360;
      while (adjusted - previous < -180) adjusted += 360;
    }
    unwrapped.push([adjusted, latitude]);
  }
  const minimum = Math.min(...unwrapped.map(([longitude]) => longitude));
  const maximum = Math.max(...unwrapped.map(([longitude]) => longitude));
  const firstWorld = Math.ceil((minimum - 180) / 360);
  const lastWorld = Math.floor((maximum + 180) / 360);
  const pieces = [];
  for (let world = firstWorld; world <= lastWorld; world += 1) {
    const left = -180 + world * 360;
    const right = 180 + world * 360;
    let clipped = clipPolygon(unwrapped, 0, left, true);
    clipped = clipPolygon(clipped, 0, right, false);
    if (clipped.length < 3) continue;
    const shifted = clipped.map(([longitude, latitude]) => [longitude - world * 360, latitude]);
    pieces.push([...shifted, shifted[0]]);
  }
  return pieces;
}

function ringToPath(value, precision, tolerance) {
  if (!Array.isArray(value) || value.length < 4) throw new Error('线环至少需要 4 个坐标');
  const first = value[0];
  const last = value[value.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('线环必须闭合');
  return splitRingAtAntimeridian(value).map((piece) => {
    const simplified = simplify(piece.map(([longitude, latitude]) => project(longitude, latitude)), tolerance);
    return `M${format(simplified[0][0], precision)} ${format(simplified[0][1], precision)}`
      + simplified.slice(1).map(([x, y]) => `L${format(x, precision)} ${format(y, precision)}`).join('')
      + 'Z';
  }).join('');
}

function geometryToPath(geometry, precision, tolerance) {
  if (!geometry || typeof geometry !== 'object') throw new Error('几何数据格式无效');
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else throw new Error('不支持的几何类型');
  if (!Array.isArray(polygons) || polygons.length === 0) throw new Error('边界为空');
  return polygons.flatMap((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0) throw new Error('多边形至少需要一个线环');
    return polygon.map((ring) => ringToPath(ring, precision, tolerance));
  }).join('');
}

export function convertWorldGeoJson(input, options = {}) {
  if (!input || input.type !== 'FeatureCollection' || !Array.isArray(input.features)) {
    throw new Error('需要 GeoJSON FeatureCollection');
  }
  const precision = options.precision ?? 2;
  const tolerance = options.tolerance ?? 0.2;
  const requestedLabelIds = options.labelIds ?? DEFAULT_LABEL_IDS;
  if (!Number.isInteger(precision) || precision < 0 || precision > 6 || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('转换参数无效');
  }
  if (!Array.isArray(requestedLabelIds) || requestedLabelIds.some((id) => typeof id !== 'string' || !/^[A-Z0-9-]{2,4}$/.test(id))) {
    throw new Error('国家标签白名单无效');
  }
  const labelIds = new Set(requestedLabelIds);

  const cleanString = (value) => typeof value === 'string' ? value.replaceAll('\0', '').trim() : value;
  const countries = input.features.map((feature) => {
    if (!feature || feature.type !== 'Feature' || !feature.properties || typeof feature.properties !== 'object') {
      throw new Error('国家要素格式无效');
    }
    const id = [feature.properties.ISO_A2, feature.properties.ADM0_A3_CN, feature.properties.ADM0_A3, feature.properties.ISO_A3]
      .map(cleanString)
      .find((candidate) => typeof candidate === 'string' && candidate !== '-99' && /^[A-Z0-9-]{2,4}$/.test(candidate));
    if (typeof id !== 'string' || !/^[A-Z0-9-]{2,4}$/.test(id)) throw new Error('国家代码无效');
    const country = { id, path: geometryToPath(feature.geometry, precision, tolerance) };
    const labelLongitude = feature.properties.LABEL_X;
    const labelLatitude = feature.properties.LABEL_Y;
    const labelName = cleanString(feature.properties.NAME_ZH) || cleanString(feature.properties.NAME);
    if (labelIds.has(id) && typeof labelName === 'string' && Number.isFinite(labelLongitude) && Number.isFinite(labelLatitude)) {
      const [x, y] = project(labelLongitude, labelLatitude);
      country.label = { name: labelName.slice(0, 80), x: Number(x.toFixed(precision)), y: Number(y.toFixed(precision)) };
    }
    return country;
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));

  const seen = new Set();
  for (const country of countries) {
    if (seen.has(country.id)) throw new Error(`国家代码重复：${country.id}`);
    seen.add(country.id);
  }
  return {
    attribution: 'Natural Earth（公共领域）',
    source: NATURAL_EARTH_SOURCE,
    countries,
  };
}

function archiveSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readNaturalEarthArchive(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error('Natural Earth 源必须是 ZIP 字节');
  if (value.byteLength === 0 || value.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Natural Earth ZIP 体积超出限制');
  const actualHash = archiveSha256(value);
  if (actualHash !== NATURAL_EARTH_SOURCE.sha256) throw new Error(`Natural Earth ZIP 校验和不匹配：${actualHash}`);
  const archive = new AdmZip(Buffer.from(value));
  const versionEntry = archive.getEntry(`${ARCHIVE_STEM}.VERSION.txt`);
  const shapeEntry = archive.getEntry(`${ARCHIVE_STEM}.shp`);
  const databaseEntry = archive.getEntry(`${ARCHIVE_STEM}.dbf`);
  if (!versionEntry || !shapeEntry || !databaseEntry) throw new Error('Natural Earth ZIP 缺少必需文件');
  if (shapeEntry.header.size > 12 * 1024 * 1024 || databaseEntry.header.size > 2 * 1024 * 1024) {
    throw new Error('Natural Earth ZIP 解压体积超出限制');
  }
  const version = versionEntry.getData().toString('utf8').trim();
  if (version !== NATURAL_EARTH_SOURCE.version) throw new Error(`Natural Earth 版本不匹配：${version}`);
  return shapefile.read(shapeEntry.getData(), databaseEntry.getData(), { encoding: 'utf-8' });
}

async function downloadNaturalEarthArchive(fetchFunction = globalThis.fetch) {
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetchFunction(NATURAL_EARTH_SOURCE.url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Natural Earth 下载失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) throw new Error('Natural Earth ZIP 体积超出限制');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error('Natural Earth ZIP 体积超出限制');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function serializeWorldMapModule(worldMap) {
  return `// Generated by scripts/build-world-map.mjs; do not edit.\nexport const WORLD_MAP = ${JSON.stringify(worldMap)} as const;\n`;
}

async function main() {
  const [, , inputPath, outputPath = 'src/generated/world-map.ts'] = process.argv;
  let parsed;
  if (inputPath) {
    if (!inputPath.endsWith('.zip')) throw new Error('生产构建仅接受固定 Natural Earth ZIP');
    const source = await readFile(inputPath);
    parsed = await readNaturalEarthArchive(source);
  } else {
    parsed = await readNaturalEarthArchive(await downloadNaturalEarthArchive());
  }
  const worldMap = convertWorldGeoJson(parsed);
  await writeFile(outputPath, serializeWorldMapModule(worldMap), 'utf8');
  process.stdout.write(`已生成 ${worldMap.countries.length} 个国家/地区：${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
