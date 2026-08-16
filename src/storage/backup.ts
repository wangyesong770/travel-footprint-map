import { sanitizeNote, validateVisitDate } from '../domain/validation';
import type {
  BackupV1,
  CachedBoundary,
  CitySummary,
  ContinentCode,
  DatePrecision,
  MultiPolygonGeometry,
  VisitRecord,
} from '../domain/types';
import type { ImportMode, TripRepository } from './trip-store';

export const BACKUP_LIMITS = Object.freeze({
  maxBytes: 50_000_000,
  maxVisits: 10_000,
  maxBoundaries: 10_000,
  maxVerticesPerBoundary: 100_000,
  maxTotalVertices: 1_000_000,
  maxTitleCodePoints: 120,
});

export type GeometryValidator = (value: unknown) => MultiPolygonGeometry;

export interface ParseBackupOptions {
  validateGeometry?: GeometryValidator;
}

const continents = new Set<ContinentCode>(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']);
const precisions = new Set<DatePrecision>(['year', 'month', 'day']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxCodePoints: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  if ((!allowEmpty && value.length === 0) || [...value].length > maxCodePoints) throw new Error(`${label}格式无效`);
  return value;
}

function integer(value: unknown, label: string, min = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${label}格式无效`);
  return value as number;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label}格式无效`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const result = text(value, label, 40);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(result);
  if (!match || Number.isNaN(Date.parse(result))) {
    throw new Error(`${label}格式无效`);
  }
  const milliseconds = (match[2] ?? '').padEnd(3, '0');
  const canonical = `${match[1]}.${milliseconds}Z`;
  if (new Date(result).toISOString() !== canonical) throw new Error(`${label}格式无效`);
  return result;
}

function optionalText(source: Record<string, unknown>, key: string, label: string, max: number): string | undefined {
  return source[key] === undefined ? undefined : text(source[key], label, max, true);
}

function parseCity(value: unknown): CitySummary {
  const source = record(value, '城市');
  const aliasesRaw = source.aliases;
  if (!Array.isArray(aliasesRaw) || aliasesRaw.length > 100) throw new Error('城市别名格式无效');
  const continent = text(source.continentCode, '大洲代码', 2) as ContinentCode;
  if (!continents.has(continent)) throw new Error('大洲代码格式无效');
  const countryCode = text(source.countryCode, '国家代码', 2);
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('国家代码格式无效');
  const city: CitySummary = {
    id: integer(source.id, '城市 ID'),
    name: text(source.name, '城市名称', 200),
    asciiName: text(source.asciiName, '城市 ASCII 名称', 200, true),
    aliases: aliasesRaw.map((alias) => text(alias, '城市别名', 200, true)),
    countryCode,
    continentCode: continent,
    lat: finite(source.lat, '纬度', -90, 90),
    lon: finite(source.lon, '经度', -180, 180),
  };
  const zhName = optionalText(source, 'zhName', '中文城市名', 200);
  const admin1 = optionalText(source, 'admin1', '一级行政区', 200);
  if (zhName !== undefined) city.zhName = zhName;
  if (admin1 !== undefined) city.admin1 = admin1;
  if (source.population !== undefined) city.population = integer(source.population, '人口', 0);
  return city;
}

function parseVisit(value: unknown): VisitRecord {
  const source = record(value, '到访记录');
  const cityId = integer(source.cityId, '城市 ID');
  const citySnapshot = parseCity(source.citySnapshot);
  if (citySnapshot.id !== cityId) throw new Error('到访记录城市 ID 不一致');
  const createdAt = isoTimestamp(source.createdAt, '创建时间');
  const updatedAt = isoTimestamp(source.updatedAt, '更新时间');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('更新时间早于创建时间');
  const visit: VisitRecord = { cityId, citySnapshot, createdAt, updatedAt };
  if (source.note !== undefined) visit.note = sanitizeNote(text(source.note, '备注', 500, true));
  if (source.visitedOn !== undefined || source.datePrecision !== undefined) {
    if (typeof source.visitedOn !== 'string' || typeof source.datePrecision !== 'string' || !precisions.has(source.datePrecision as DatePrecision)) {
      throw new Error('到访日期格式无效');
    }
    let validated;
    try { validated = validateVisitDate(source.visitedOn); } catch { throw new Error('到访日期格式无效'); }
    if (validated.precision !== source.datePrecision) throw new Error('到访日期精度不一致');
    visit.visitedOn = validated.value;
    visit.datePrecision = validated.precision;
  }
  return visit;
}

function validatePosition(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('边界几何无效');
  return [finite(value[0], '边界经度', -180, 180), finite(value[1], '边界纬度', -90, 90)];
}

function defaultGeometryValidator(value: unknown): MultiPolygonGeometry {
  const source = record(value, '边界几何');
  if (source.type !== 'MultiPolygon' || !Array.isArray(source.coordinates) || source.coordinates.length === 0) throw new Error('边界几何无效');
  let vertices = 0;
  const coordinates = source.coordinates.map((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0 || polygon.length > 10_000) throw new Error('边界几何无效');
    return polygon.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3) throw new Error('边界几何无效');
      vertices += ring.length;
      if (vertices > BACKUP_LIMITS.maxVerticesPerBoundary) throw new Error('边界顶点过多');
      const parsedRing = ring.map(validatePosition);
      const first = parsedRing[0]!;
      const last = parsedRing.at(-1)!;
      if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('边界几何无效');
      return parsedRing;
    });
  });
  return { type: 'MultiPolygon', coordinates };
}

function vertexCount(geometry: MultiPolygonGeometry): number {
  let count = 0;
  for (const polygon of geometry.coordinates) for (const ring of polygon) count += ring.length;
  return count;
}

function parseBoundary(value: unknown, validateGeometry: GeometryValidator): CachedBoundary {
  const source = record(value, '边界');
  const boundary: CachedBoundary = {
    cityId: integer(source.cityId, '边界城市 ID'),
    // A shared validator may normalize geometry, but imported values are still
    // rebuilt here so callers can never persist an untrusted object graph.
    geometry: defaultGeometryValidator(validateGeometry(source.geometry)),
    source: text(source.source, '边界来源', 200),
    fetchedAt: isoTimestamp(source.fetchedAt, '边界获取时间'),
  };
  const sourceUrl = optionalText(source, 'sourceUrl', '边界来源地址', 2_048);
  if (sourceUrl !== undefined) {
    let url: URL;
    try { url = new URL(sourceUrl); } catch { throw new Error('边界来源地址格式无效'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('边界来源地址格式无效');
    boundary.sourceUrl = sourceUrl;
  }
  return boundary;
}

export function parseBackup(input: string, options: ParseBackupOptions = {}): BackupV1 {
  if (new TextEncoder().encode(input).byteLength > BACKUP_LIMITS.maxBytes) throw new Error('备份文件过大');
  let raw: unknown;
  try { raw = JSON.parse(input) as unknown; } catch { throw new Error('备份不是有效的 JSON'); }
  const source = record(raw, '备份');
  if (source.schemaVersion !== 1) throw new Error('不支持的备份版本');
  if (!Array.isArray(source.visits)) throw new Error('到访记录格式无效');
  if (!Array.isArray(source.boundaries)) throw new Error('边界记录格式无效');
  if (source.visits.length > BACKUP_LIMITS.maxVisits) throw new Error('到访记录过多');
  if (source.boundaries.length > BACKUP_LIMITS.maxBoundaries) throw new Error('边界记录过多');
  const visits = source.visits.map(parseVisit);
  const visitIds = new Set<number>();
  for (const visit of visits) {
    if (visitIds.has(visit.cityId)) throw new Error('备份包含重复城市记录');
    visitIds.add(visit.cityId);
  }
  const validator = options.validateGeometry ?? defaultGeometryValidator;
  const boundaries = source.boundaries.map((value) => parseBoundary(value, validator));
  const boundaryIds = new Set<number>();
  let totalVertices = 0;
  for (const boundary of boundaries) {
    if (boundaryIds.has(boundary.cityId)) throw new Error('备份包含重复边界记录');
    boundaryIds.add(boundary.cityId);
    totalVertices += vertexCount(boundary.geometry);
    if (totalVertices > BACKUP_LIMITS.maxTotalVertices) throw new Error('备份边界顶点总数过多');
  }
  return {
    schemaVersion: 1,
    exportedAt: isoTimestamp(source.exportedAt, '导出时间'),
    title: text(source.title, '地图标题', BACKUP_LIMITS.maxTitleCodePoints, true),
    visits,
    boundaries,
  };
}

export async function exportBackup(repository: TripRepository, now: () => string = () => new Date().toISOString()): Promise<BackupV1> {
  const [title, visits, boundaries] = await Promise.all([
    repository.getTitle(),
    repository.listVisits(),
    repository.listBoundaries(),
  ]);
  return { schemaVersion: 1, exportedAt: now(), title, visits, boundaries };
}

export async function mergeBackup(repository: TripRepository, backup: BackupV1, mode: ImportMode = 'merge'): Promise<void> {
  await repository.importBackup(backup, mode);
}
