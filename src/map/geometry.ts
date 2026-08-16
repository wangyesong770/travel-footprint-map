import type {
  LinearRing,
  MultiPolygonGeometry,
  PolygonCoordinates,
  Position,
} from '../domain/types';
import type { CityArea, CountryBoundaryPackage } from '../areas/types';

export interface GeometryValidationOptions {
  maxVertices?: number;
  maxPolygons?: number;
}

const DEFAULT_MAX_VERTICES = 50_000;
const DEFAULT_MAX_POLYGONS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPosition(value: unknown): Position {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('坐标格式无效');
  }
  const longitude = value[0];
  const latitude = value[1];
  if (typeof longitude !== 'number' || typeof latitude !== 'number') {
    throw new Error('坐标格式无效');
  }
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error('坐标必须是有限数值');
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error('经纬度超出范围');
  }
  return [longitude, latitude];
}

function readRing(value: unknown, consumeVertex: () => void): LinearRing {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error('线环至少需要 4 个坐标');
  }
  const ring = value.map((position) => {
    consumeVertex();
    return readPosition(position);
  });
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error('线环必须闭合');
  }
  const unwrappedLongitudes = unwrapRing(ring).map(([longitude]) => longitude);
  let minimumLongitude = Number.POSITIVE_INFINITY;
  let maximumLongitude = Number.NEGATIVE_INFINITY;
  for (const longitude of unwrappedLongitudes) {
    minimumLongitude = Math.min(minimumLongitude, longitude);
    maximumLongitude = Math.max(maximumLongitude, longitude);
  }
  if (maximumLongitude - minimumLongitude > 720) {
    throw new Error('边界跨越反经线次数过多');
  }
  return ring;
}

function readPolygon(value: unknown, consumeVertex: () => void): PolygonCoordinates {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('多边形至少需要一个线环');
  }
  return value.map((ring) => readRing(ring, consumeVertex));
}

export function validateGeometry(
  input: unknown,
  options: GeometryValidationOptions = {},
): MultiPolygonGeometry {
  if (!isRecord(input) || typeof input.type !== 'string') {
    throw new Error('几何数据格式无效');
  }
  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES;
  const maxPolygons = options.maxPolygons ?? DEFAULT_MAX_POLYGONS;
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 1 || !Number.isSafeInteger(maxPolygons) || maxPolygons < 1) {
    throw new Error('几何校验限制无效');
  }

  let vertexCount = 0;
  const consumeVertex = (): void => {
    vertexCount += 1;
    if (vertexCount > maxVertices) {
      throw new Error('边界坐标数量过多');
    }
  };

  let polygons: PolygonCoordinates[];
  if (input.type === 'Polygon') {
    polygons = [readPolygon(input.coordinates, consumeVertex)];
  } else if (input.type === 'MultiPolygon') {
    if (!Array.isArray(input.coordinates) || input.coordinates.length === 0) {
      throw new Error('多多边形至少需要一个多边形');
    }
    if (input.coordinates.length > maxPolygons) {
      throw new Error('边界多边形数量过多');
    }
    polygons = input.coordinates.map((polygon) => readPolygon(polygon, consumeVertex));
  } else {
    throw new Error('不支持的几何类型');
  }

  return { type: 'MultiPolygon', coordinates: polygons };
}

function unwrapRing(ring: LinearRing): LinearRing {
  const first = ring[0]!;
  const result: LinearRing = [[first[0], first[1]]];
  let previous = first[0];
  for (let index = 1; index < ring.length; index += 1) {
    const position = ring[index]!;
    let longitude = position[0];
    while (longitude - previous > 180) longitude -= 360;
    while (longitude - previous < -180) longitude += 360;
    result.push([longitude, position[1]]);
    previous = longitude;
  }
  return result;
}

function clipAgainstLongitude(ring: LinearRing, boundary: number, keepGreater: boolean): LinearRing {
  if (ring.length === 0) return [];
  const output: LinearRing = [];
  const inside = (position: Position): boolean => keepGreater ? position[0] >= boundary : position[0] <= boundary;
  const intersection = (start: Position, end: Position): Position => {
    const ratio = (boundary - start[0]) / (end[0] - start[0]);
    return [boundary, start[1] + (end[1] - start[1]) * ratio];
  };

  let start = ring[ring.length - 1]!;
  for (const end of ring) {
    const startInside = inside(start);
    const endInside = inside(end);
    if (endInside) {
      if (!startInside) output.push(intersection(start, end));
      output.push([end[0], end[1]]);
    } else if (startInside) {
      output.push(intersection(start, end));
    }
    start = end;
  }
  return output;
}

function closeValidRing(ring: LinearRing): LinearRing | undefined {
  if (ring.length === 0) return undefined;
  const result = ring.map(([lon, lat]): Position => [lon, lat]);
  const first = result[0]!;
  const last = result[result.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) result.push([first[0], first[1]]);
  return result.length >= 4 ? result : undefined;
}

function clipRingToWorld(ring: LinearRing): LinearRing | undefined {
  return closeValidRing(clipAgainstLongitude(clipAgainstLongitude(ring, -180, true), 180, false));
}

function sameGeometry(left: MultiPolygonGeometry, right: MultiPolygonGeometry): boolean {
  return JSON.stringify(left.coordinates) === JSON.stringify(right.coordinates);
}

/**
 * Splits dateline-crossing polygons at ±180°. Rings are unwrapped first, then
 * shifted copies are clipped to the visible world. This keeps every emitted
 * coordinate bounded and prevents a narrow dateline polygon filling the map.
 */
export function normalizeAntimeridian(geometry: MultiPolygonGeometry): MultiPolygonGeometry {
  const normalized: PolygonCoordinates[] = [];
  for (const polygon of geometry.coordinates) {
    const unwrapped = polygon.map(unwrapRing);
    const outer = unwrapped[0]!;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const [longitude] of outer) {
      minimum = Math.min(minimum, longitude);
      maximum = Math.max(maximum, longitude);
    }
    const firstShift = Math.ceil((-180 - maximum) / 360);
    const lastShift = Math.floor((180 - minimum) / 360);

    for (let shift = firstShift; shift <= lastShift; shift += 1) {
      const offset = shift * 360;
      const shifted = unwrapped.map((ring) => ring.map(([lon, lat]): Position => [lon + offset, lat]));
      const clippedOuter = clipRingToWorld(shifted[0]!);
      if (!clippedOuter) continue;
      const clippedHoles = shifted.slice(1)
        .map(clipRingToWorld)
        .filter((ring): ring is LinearRing => ring !== undefined);
      normalized.push([clippedOuter, ...clippedHoles]);
    }
  }

  const result: MultiPolygonGeometry = { type: 'MultiPolygon', coordinates: normalized };
  return sameGeometry(result, geometry) ? geometry : result;
}

interface RingLookup {
  readonly coordinates: LinearRing;
  readonly minLongitude: number;
  readonly maxLongitude: number;
  readonly minLatitude: number;
  readonly maxLatitude: number;
}

interface PolygonLookup {
  readonly rings: readonly RingLookup[];
  readonly outer: RingLookup;
}

interface AreaLookup {
  readonly feature: CityArea;
  readonly polygons: readonly PolygonLookup[];
}

const packageLookupCache = new WeakMap<CountryBoundaryPackage, readonly AreaLookup[]>();

function prepareLookupRing(input: readonly (readonly number[])[]): RingLookup {
  if (input.length < 4) throw new Error('线环至少需要 4 个坐标');
  const cloned = input.map((position) => readPosition(position));
  const first = cloned[0]!;
  const last = cloned[cloned.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('线环必须闭合');
  const coordinates = unwrapRing(cloned);
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  for (const [longitude, latitude] of coordinates) {
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude);
    maxLatitude = Math.max(maxLatitude, latitude);
  }
  if (maxLongitude - minLongitude > 720) throw new Error('边界跨越反经线次数过多');
  return { coordinates, minLongitude, maxLongitude, minLatitude, maxLatitude };
}

function preparePolygon(input: readonly (readonly (readonly number[])[])[]): PolygonLookup {
  if (input.length === 0) throw new Error('多边形至少需要一个线环');
  const rings = input.map(prepareLookupRing);
  return { rings, outer: rings[0]! };
}

function preparePackage(countryPackage: CountryBoundaryPackage): readonly AreaLookup[] {
  const cached = packageLookupCache.get(countryPackage);
  if (cached !== undefined) return cached;
  const prepared = countryPackage.features.map((feature): AreaLookup => {
    const polygons = feature.geometry.type === 'Polygon'
      ? [preparePolygon(feature.geometry.coordinates)]
      : feature.geometry.coordinates.map(preparePolygon);
    return { feature, polygons };
  });
  packageLookupCache.set(countryPackage, prepared);
  return prepared;
}

function longitudeNearRing(longitude: number, ring: RingLookup): number {
  const center = (ring.minLongitude + ring.maxLongitude) / 2;
  let adjusted = longitude;
  while (adjusted - center > 180) adjusted -= 360;
  while (adjusted - center < -180) adjusted += 360;
  return adjusted;
}

type RingContainment = 'outside' | 'inside' | 'boundary';

function pointInRing(point: Position, ring: RingLookup): RingContainment {
  const longitude = longitudeNearRing(point[0], ring);
  const latitude = point[1];
  if (
    longitude < ring.minLongitude || longitude > ring.maxLongitude
    || latitude < ring.minLatitude || latitude > ring.maxLatitude
  ) return 'outside';

  let inside = false;
  for (let index = 1; index < ring.coordinates.length; index += 1) {
    const start = ring.coordinates[index - 1]!;
    const end = ring.coordinates[index]!;
    const deltaLongitude = end[0] - start[0];
    const deltaLatitude = end[1] - start[1];
    const cross = (longitude - start[0]) * deltaLatitude - (latitude - start[1]) * deltaLongitude;
    const scale = Math.max(1, Math.abs(deltaLongitude), Math.abs(deltaLatitude));
    if (
      Math.abs(cross) <= Number.EPSILON * 32 * scale
      && longitude >= Math.min(start[0], end[0]) && longitude <= Math.max(start[0], end[0])
      && latitude >= Math.min(start[1], end[1]) && latitude <= Math.max(start[1], end[1])
    ) return 'boundary';

    const crossesLatitude = (start[1] > latitude) !== (end[1] > latitude);
    if (crossesLatitude) {
      const intersection = start[0] + ((latitude - start[1]) * deltaLongitude) / deltaLatitude;
      if (longitude < intersection) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

function pointInPolygon(point: Position, polygon: PolygonLookup): boolean {
  const outer = pointInRing(point, polygon.outer);
  if (outer === 'outside') return false;
  if (outer === 'boundary') return true;
  for (let index = 1; index < polygon.rings.length; index += 1) {
    const hole = pointInRing(point, polygon.rings[index]!);
    if (hole === 'boundary') return true;
    if (hole === 'inside') return false;
  }
  return true;
}

/**
 * Finds every administrative area covering a longitude/latitude point.
 * Package geometry is indexed once; later visits use polygon bounding boxes
 * before ray casting. Shared edges intentionally return every touching area.
 */
export function findContainingAreas(point: Position, countryPackage: CountryBoundaryPackage): CityArea[] {
  const checkedPoint = readPosition(point);
  const matches: CityArea[] = [];
  for (const area of preparePackage(countryPackage)) {
    if (area.polygons.some((polygon) => pointInPolygon(checkedPoint, polygon))) matches.push(area.feature);
  }
  return matches.sort((left, right) => left.properties.areaId.localeCompare(right.properties.areaId, 'en'));
}
