import type { Position } from '../domain/types';
import { validateGeometry } from '../map/geometry';
import type {
  AreaId,
  CityArea,
  CityAreaProperties,
  CountryBoundaryPackage,
  CountryCode,
  CountryManifestEntry,
} from './types';

const MAX_NAME_CODE_POINTS = 160;
const MAX_ALIASES = 20;
const MAX_FEATURES = 1_000_000;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_FEATURE_VERTICES = 100_000;
const MAX_PACKAGE_VERTICES = 1_000_000;
const MAX_OBJECT_GRAPH_DEPTH = 64;
const MAX_OBJECT_GRAPH_NODES = 2_000_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const COUNTRY_CODE = /^[A-Z]{2}$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;
type WireInput = string | Uint8Array | ArrayBuffer;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeObjectGraph(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Array.isArray(current.value)) {
      nodes += 1;
      if (nodes > MAX_OBJECT_GRAPH_NODES || current.depth > MAX_OBJECT_GRAPH_DEPTH) {
        throw new Error('数据结构嵌套或规模过大');
      }
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      nodes += 1;
      if (nodes > MAX_OBJECT_GRAPH_NODES || current.depth > MAX_OBJECT_GRAPH_DEPTH) {
        throw new Error('数据结构嵌套或规模过大');
      }
      for (const key of Object.keys(current.value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new Error('数据包含禁止的属性');
        stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    }
  }
}

function readString(value: unknown, label: string, maxCodePoints = MAX_NAME_CODE_POINTS): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maxCodePoints) {
    throw new Error(`${label}格式无效`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new Error(`${label}不能包含控制字符`);
    }
  }
  return value;
}

function readCountryCode(value: unknown, label = '国家代码'): CountryCode {
  const code = readString(value, label, 2).toUpperCase();
  if (!COUNTRY_CODE.test(code)) throw new Error(`${label}格式无效`);
  return code as CountryCode;
}

function readSafeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label}格式无效`);
  }
  return value as number;
}

function readPosition(value: unknown, label: string): Position {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}格式无效`);
  const longitude = value[0];
  const latitude = value[1];
  if (typeof longitude !== 'number' || typeof latitude !== 'number'
    || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error(`${label}必须是有限坐标`);
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error(`${label}坐标超出范围`);
  }
  return [longitude, latitude];
}

function readManifestEntry(value: unknown): CountryManifestEntry {
  if (!isRecord(value)) throw new Error('国家清单条目格式无效');
  if (value.schemaVersion !== 1) throw new Error('不支持的清单版本');
  const countryCode = readCountryCode(value.countryCode);
  const featureCount = readSafeInteger(value.featureCount, '区域数量', 0, MAX_FEATURES);
  const byteSize = readSafeInteger(value.byteSize, '文件大小', 2, MAX_PACKAGE_BYTES);
  const checksum = readString(value.checksum, '校验和', 64);
  if (!CHECKSUM.test(checksum)) throw new Error('校验和格式无效');
  const updatedAt = readString(value.updatedAt, '更新时间', 64);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('更新时间格式无效');
  return {
    schemaVersion: 1,
    countryCode,
    boundaryVersion: readString(value.boundaryVersion, '边界版本'),
    administrativeScheme: readString(value.administrativeScheme, '行政层级'),
    featureCount,
    byteSize,
    checksum,
    updatedAt,
    source: readString(value.source, '数据来源'),
    attribution: readString(value.attribution, '数据署名', 2_000),
  };
}

/** Strictly reconstructs the ISO-keyed manifest; input objects are never reused. */
export function parseCountryManifest(input: unknown): Readonly<Record<string, CountryManifestEntry>> {
  assertSafeObjectGraph(input);
  if (!isRecord(input)) throw new Error('国家清单格式无效');
  const result: Record<string, CountryManifestEntry> = Object.create(null) as Record<string, CountryManifestEntry>;
  for (const key of Object.keys(input)) {
    const normalizedKey = readCountryCode(key);
    const entry = readManifestEntry(input[key]);
    if (entry.countryCode !== normalizedKey) throw new Error('清单键与国家代码不匹配');
    if (Object.hasOwn(result, normalizedKey)) throw new Error('国家清单条目重复');
    result[normalizedKey] = entry;
  }
  return result;
}

function rawBytes(input: WireInput, expectedSize: number): Uint8Array {
  let bytes: Uint8Array;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else if (Object.prototype.toString.call(input) === '[object Uint8Array]') {
    bytes = Uint8Array.from(input as Uint8Array);
  } else if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') {
    bytes = new Uint8Array((input as ArrayBuffer).slice(0));
  } else throw new Error('国家边界文件必须是原始字节或文本');

  const framingLimit = Math.ceil(expectedSize * 1.01);
  if (bytes.byteLength > framingLimit) throw new Error('国家边界文件大小超过清单预算');
  if (bytes.byteLength !== expectedSize) throw new Error('国家边界文件大小与清单不匹配');
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('国家边界文件不是有效 UTF-8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('国家边界文件不是有效 JSON');
  }
}

interface Transform {
  readonly scale: Position;
  readonly translate: Position;
}

function readTransform(value: unknown): Transform | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('拓扑变换格式无效');
  const scale = readPair(value.scale, '拓扑缩放');
  const translate = readPair(value.translate, '拓扑平移');
  if (scale[0] === 0 || scale[1] === 0) throw new Error('拓扑缩放不能为零');
  return { scale, translate };
}

function readPair(value: unknown, label: string): Position {
  if (!Array.isArray(value) || value.length !== 2
    || typeof value[0] !== 'number' || typeof value[1] !== 'number'
    || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
    throw new Error(`${label}格式无效`);
  }
  return [value[0], value[1]];
}

function readArcs(value: unknown, transform: Transform | undefined): readonly Position[][] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('拓扑弧格式无效');
  let rawVertexCount = 0;
  return value.map((rawArc) => {
    if (!Array.isArray(rawArc) || rawArc.length === 0) throw new Error('拓扑弧格式无效');
    rawVertexCount += rawArc.length;
    if (rawVertexCount > MAX_PACKAGE_VERTICES) throw new Error('拓扑弧坐标总量过多');
    let x = 0;
    let y = 0;
    return rawArc.map((rawPoint) => {
      const pair = readPair(rawPoint, '拓扑弧坐标');
      if (transform) {
        if (!Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1])) {
          throw new Error('量化拓扑弧坐标必须是整数');
        }
        x += pair[0];
        y += pair[1];
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
          throw new Error('量化拓扑弧坐标累计值溢出');
        }
        return readPosition([
          x * transform.scale[0] + transform.translate[0],
          y * transform.scale[1] + transform.translate[1],
        ], '拓扑弧坐标');
      }
      return readPosition(pair, '拓扑弧坐标');
    });
  });
}

function readArcReference(value: unknown, arcs: readonly Position[][]): number {
  if (!Number.isSafeInteger(value)) throw new Error('拓扑弧引用格式无效');
  const reference = value as number;
  const index = getArcIndex(reference);
  if (index < 0 || index >= arcs.length) throw new Error('拓扑弧引用超出范围');
  return reference;
}

function getArcIndex(reference: number): number {
  return reference < 0 ? -reference - 1 : reference;
}

function readRingReferences(value: unknown, arcs: readonly Position[][]): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('拓扑线环格式无效');
  return value.map((reference) => readArcReference(reference, arcs));
}

function readPolygonReferences(value: unknown, arcs: readonly Position[][]): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('拓扑多边形格式无效');
  return value.map((ring) => readRingReferences(ring, arcs));
}

type GeometryReferences =
  | { readonly type: 'Polygon'; readonly polygons: readonly [readonly (readonly number[])[]] }
  | { readonly type: 'MultiPolygon'; readonly polygons: readonly (readonly (readonly number[])[])[] };

function readGeometryReferences(value: JsonRecord, arcs: readonly Position[][]): GeometryReferences {
  if (value.type === 'Polygon') {
    return { type: 'Polygon', polygons: [readPolygonReferences(value.arcs, arcs)] };
  }
  if (value.type === 'MultiPolygon') {
    if (!Array.isArray(value.arcs) || value.arcs.length === 0) throw new Error('拓扑多多边形格式无效');
    return { type: 'MultiPolygon', polygons: value.arcs.map((polygon) => readPolygonReferences(polygon, arcs)) };
  }
  throw new Error('不支持的区域几何类型');
}

function countReferences(references: GeometryReferences, arcs: readonly Position[][]): number {
  let count = 0;
  for (const polygon of references.polygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const reference = ring[index]!;
        const arcIndex = getArcIndex(reference);
        count += arcs[arcIndex]!.length - (index === 0 ? 0 : 1);
        if (!Number.isSafeInteger(count)) throw new Error('区域坐标计数溢出');
      }
    }
  }
  return count;
}

function decodeRing(references: readonly number[], arcs: readonly Position[][]): Position[] {
  const ring: Position[] = [];
  for (const reference of references) {
    const arc = arcs[getArcIndex(reference)]!;
    const coordinates = reference < 0 ? [...arc].reverse() : arc;
    const start = ring.length === 0 ? 0 : 1;
    for (let index = start; index < coordinates.length; index += 1) {
      const point = coordinates[index]!;
      ring.push([point[0], point[1]]);
    }
  }
  return ring;
}

function decodeGeometry(references: GeometryReferences, arcs: readonly Position[][]) {
  return {
    type: 'MultiPolygon' as const,
    coordinates: references.polygons.map((polygon) => polygon.map((ring) => decodeRing(ring, arcs))),
  };
}

function readAliases(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ALIASES) throw new Error('城市别名格式无效');
  return value.map((alias) => readString(alias, '城市别名'));
}

function readProperties(value: unknown, expectedCountry: CountryCode, expectedSource: string): CityAreaProperties {
  if (!isRecord(value)) throw new Error('区域属性格式无效');
  const countryCode = readCountryCode(value.countryCode, '区域国家代码');
  if (countryCode !== expectedCountry) throw new Error('区域国家代码与数据包不匹配');
  const sourceId = readString(value.sourceId, '来源标识');
  const areaIdValue = readString(value.areaId, '区域标识', 400);
  const areaId = areaIdValue as AreaId;
  const parts = areaIdValue.split(':');
  if (parts.length !== 3 || parts[0] !== countryCode || parts[1] !== expectedSource || parts[2] !== sourceId) {
    throw new Error('区域标识与属性不一致');
  }
  const result: {
    areaId: AreaId;
    countryCode: CountryCode;
    sourceId: string;
    adminLevel: string;
    nameZh?: string;
    nameLocal: string;
    aliases: readonly string[];
    centroid: Readonly<Position>;
  } = {
    areaId,
    countryCode,
    sourceId,
    adminLevel: readString(value.adminLevel, '行政层级'),
    nameLocal: readString(value.nameLocal, '城市原名'),
    aliases: readAliases(value.aliases),
    centroid: readPosition(value.centroid, '城市中心点'),
  };
  if (value.nameZh !== undefined) result.nameZh = readString(value.nameZh, '城市中文名');
  return result;
}

interface PendingFeature {
  readonly properties: CityAreaProperties;
  readonly references: GeometryReferences;
  readonly vertexCount: number;
}

function readPendingFeatures(
  value: unknown,
  arcs: readonly Position[][],
  countryCode: CountryCode,
  source: string,
  expectedCount: number,
): readonly PendingFeature[] {
  if (!isRecord(value) || value.type !== 'GeometryCollection' || !Array.isArray(value.geometries)) {
    throw new Error('区域拓扑集合格式无效');
  }
  if (value.geometries.length !== expectedCount) throw new Error('区域数量与清单不匹配');
  const seen = new Set<string>();
  let totalVertices = 0;
  return value.geometries.map((geometry) => {
    if (!isRecord(geometry)) throw new Error('区域拓扑格式无效');
    const properties = readProperties(geometry.properties, countryCode, source);
    if (seen.has(properties.areaId)) throw new Error('区域标识重复');
    seen.add(properties.areaId);
    const references = readGeometryReferences(geometry, arcs);
    const vertexCount = countReferences(references, arcs);
    if (vertexCount > MAX_FEATURE_VERTICES) throw new Error('单个区域坐标数量过多');
    totalVertices += vertexCount;
    if (!Number.isSafeInteger(totalVertices) || totalVertices > MAX_PACKAGE_VERTICES) {
      throw new Error('数据包坐标总量过多');
    }
    return { properties, references, vertexCount };
  });
}

function sameMetadata(input: JsonRecord, expected: CountryManifestEntry): {
  readonly countryCode: CountryCode;
  readonly boundaryVersion: string;
  readonly administrativeScheme: string;
  readonly source: string;
  readonly attribution: string;
} {
  if (input.schemaVersion !== 1) throw new Error('不支持的数据包版本');
  const countryCode = readCountryCode(input.countryCode);
  if (countryCode !== expected.countryCode) throw new Error('数据包国家代码与清单不匹配');
  const boundaryVersion = readString(input.boundaryVersion, '边界版本');
  if (boundaryVersion !== expected.boundaryVersion) throw new Error('数据包边界版本与清单不匹配');
  const administrativeScheme = readString(input.administrativeScheme, '行政层级');
  if (administrativeScheme !== expected.administrativeScheme) throw new Error('数据包行政层级与清单不匹配');
  const source = readString(input.source, '数据来源');
  if (source !== expected.source) throw new Error('数据包数据来源与清单不匹配');
  const attribution = readString(input.attribution, '数据署名', 2_000);
  if (attribution !== expected.attribution) throw new Error('数据包署名与清单不匹配');
  return { countryCode, boundaryVersion, administrativeScheme, source, attribution };
}

/**
 * Validates raw untrusted TopoJSON bytes and reconstructs a geometry-only,
 * property-whitelisted runtime package. Checksum verification intentionally
 * belongs before this call in the loader because it must cover the exact bytes.
 */
export function parseCountryPackage(input: WireInput, expectedEntry: CountryManifestEntry): CountryBoundaryPackage {
  assertSafeObjectGraph(expectedEntry);
  const expected = readManifestEntry(expectedEntry);
  const bytes = rawBytes(input, expected.byteSize);
  const wireValue = parseJson(bytes);
  assertSafeObjectGraph(wireValue);
  if (!isRecord(wireValue) || wireValue.type !== 'Topology') throw new Error('国家边界拓扑格式无效');
  const metadata = sameMetadata(wireValue, expected);
  const transform = readTransform(wireValue.transform);
  const arcs = readArcs(wireValue.arcs, transform);
  if (!isRecord(wireValue.objects)) throw new Error('国家边界对象格式无效');
  const pending = readPendingFeatures(
    wireValue.objects.areas,
    arcs,
    metadata.countryCode,
    metadata.source,
    expected.featureCount,
  );
  const features: CityArea[] = pending.map(({ properties, references }) => ({
    type: 'Feature',
    properties,
    geometry: validateGeometry(decodeGeometry(references, arcs), { maxVertices: MAX_FEATURE_VERTICES }),
  }));
  return {
    schemaVersion: 1,
    countryCode: metadata.countryCode,
    boundaryVersion: metadata.boundaryVersion,
    administrativeScheme: metadata.administrativeScheme,
    source: metadata.source,
    attribution: metadata.attribution,
    features,
  };
}
