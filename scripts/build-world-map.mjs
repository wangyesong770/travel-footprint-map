#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_MERCATOR_LATITUDE = 85.05112878;
const WIDTH = 1000;
const HEIGHT = 500;
const DEFAULT_LABEL_IDS = [
  'AR', 'AU', 'BR', 'CA', 'CN', 'DE', 'EG', 'FR',
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

function ringToPath(value, precision, tolerance) {
  if (!Array.isArray(value) || value.length < 4) throw new Error('线环至少需要 4 个坐标');
  const points = value.map((position) => {
    if (!Array.isArray(position) || position.length < 2) throw new Error('坐标格式无效');
    return project(position[0], position[1]);
  });
  const first = value[0];
  const last = value[value.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('线环必须闭合');
  const simplified = simplify(points, tolerance);
  return `M${format(simplified[0][0], precision)} ${format(simplified[0][1], precision)}`
    + simplified.slice(1).map(([x, y]) => `L${format(x, precision)} ${format(y, precision)}`).join('')
    + 'Z';
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

  const countries = input.features.map((feature) => {
    if (!feature || feature.type !== 'Feature' || !feature.properties || typeof feature.properties !== 'object') {
      throw new Error('国家要素格式无效');
    }
    const id = [feature.properties.ISO_A2, feature.properties.ADM0_A3, feature.properties.ISO_A3]
      .find((candidate) => typeof candidate === 'string' && candidate !== '-99' && /^[A-Z0-9-]{2,4}$/.test(candidate));
    if (typeof id !== 'string' || !/^[A-Z0-9-]{2,4}$/.test(id)) throw new Error('国家代码无效');
    const country = { id, path: geometryToPath(feature.geometry, precision, tolerance) };
    const labelLongitude = feature.properties.LABEL_X;
    const labelLatitude = feature.properties.LABEL_Y;
    const labelName = feature.properties.NAME_ZH ?? feature.properties.NAME;
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
    countries,
  };
}

export function serializeWorldMapModule(worldMap) {
  return `// Generated by scripts/build-world-map.mjs; do not edit.\nexport const WORLD_MAP = ${JSON.stringify(worldMap)} as const;\n`;
}

async function main() {
  const [, , inputPath, outputPath = 'src/generated/world-map.ts'] = process.argv;
  if (!inputPath) throw new Error('用法：node scripts/build-world-map.mjs <input.geojson> [output.ts]');
  const source = await readFile(inputPath, 'utf8');
  const parsed = JSON.parse(source);
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
