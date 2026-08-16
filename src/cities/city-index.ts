import type { CitySummary } from '../domain/types';

const GRID_SIZE_DEGREES = 5;
const LATITUDE_ROWS = 180 / GRID_SIZE_DEGREES;
const LONGITUDE_COLUMNS = 360 / GRID_SIZE_DEGREES;
const EARTH_RADIUS_KM = 6371.0088;

export interface CityIndex {
  search(query: string, limit: number): CitySummary[];
  nearest(lon: number, lat: number, limit: number): CitySummary[];
}

interface SearchEntry {
  city: CitySummary;
  terms: string[];
}

interface RankedCity {
  city: CitySummary;
  rank: number;
}

export function createCityIndex(cities: readonly CitySummary[]): CityIndex {
  const seenIds = new Set<number>();
  const searchEntries: SearchEntry[] = [];
  const grid = new Map<number, CitySummary[]>();

  for (const city of cities) {
    if (seenIds.has(city.id)) {
      throw new Error(`Duplicate city ID: ${city.id}`);
    }
    if (!Number.isFinite(city.lat) || city.lat < -90 || city.lat > 90 || !Number.isFinite(city.lon)) {
      throw new Error(`Invalid coordinates for city ID: ${city.id}`);
    }
    seenIds.add(city.id);

    const terms = new Set(
      [city.zhName, city.name, city.asciiName, ...city.aliases]
        .filter((term): term is string => typeof term === 'string')
        .map(normalizeSearchTerm)
        .filter(Boolean),
    );
    searchEntries.push({ city, terms: [...terms] });

    const row = latitudeRow(city.lat);
    const column = longitudeColumn(city.lon);
    const key = row * LONGITUDE_COLUMNS + column;
    const bucket = grid.get(key);
    if (bucket) bucket.push(city);
    else grid.set(key, [city]);
  }

  return {
    search(query, limit) {
      const normalizedQuery = normalizeSearchTerm(query);
      const safeLimit = normalizeLimit(limit);
      if (!normalizedQuery || safeLimit === 0) return [];

      const ranked: RankedCity[] = [];
      for (const entry of searchEntries) {
        let bestRank = Number.POSITIVE_INFINITY;
        for (const term of entry.terms) {
          if (term === normalizedQuery) bestRank = Math.min(bestRank, 0);
          else if (term.startsWith(normalizedQuery)) bestRank = Math.min(bestRank, 1);
          else if (term.includes(normalizedQuery)) bestRank = Math.min(bestRank, 2);
        }
        if (Number.isFinite(bestRank)) ranked.push({ city: entry.city, rank: bestRank });
      }

      ranked.sort(
        (left, right) =>
          left.rank - right.rank ||
          (right.city.population ?? 0) - (left.city.population ?? 0) ||
          left.city.name.localeCompare(right.city.name) ||
          left.city.id - right.city.id,
      );
      return ranked.slice(0, safeLimit).map(({ city }) => city);
    },

    nearest(lon, lat, limit) {
      const safeLimit = normalizeLimit(limit);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || safeLimit === 0) return [];

      const normalizedLon = wrapLongitude(lon);
      const rows = Array.from({ length: LATITUDE_ROWS }, (_, row) => ({
        row,
        lowerBound: latitudeRowLowerBoundKm(row, lat),
      })).sort((left, right) => left.lowerBound - right.lowerBound);
      const ranked: Array<{ city: CitySummary; distance: number }> = [];

      for (const { row, lowerBound } of rows) {
        if (ranked.length >= safeLimit && lowerBound > ranked[safeLimit - 1]!.distance) break;

        for (let column = 0; column < LONGITUDE_COLUMNS; column += 1) {
          const bucket = grid.get(row * LONGITUDE_COLUMNS + column);
          if (!bucket) continue;
          for (const city of bucket) {
            ranked.push({ city, distance: haversineKm(normalizedLon, lat, city.lon, city.lat) });
          }
        }
        ranked.sort(
          (left, right) =>
            left.distance - right.distance ||
            (right.city.population ?? 0) - (left.city.population ?? 0) ||
            left.city.id - right.city.id,
        );
        if (ranked.length > safeLimit) ranked.length = safeLimit;
      }

      return ranked.map(({ city }) => city);
    },
  };
}

function normalizeSearchTerm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('und')
    .replace(/[\p{Punctuation}\p{Separator}]+/gu, ' ')
    .trim();
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

function latitudeRow(lat: number): number {
  return Math.min(LATITUDE_ROWS - 1, Math.max(0, Math.floor((lat + 90) / GRID_SIZE_DEGREES)));
}

function longitudeColumn(lon: number): number {
  return Math.min(
    LONGITUDE_COLUMNS - 1,
    Math.max(0, Math.floor((wrapLongitude(lon) + 180) / GRID_SIZE_DEGREES)),
  );
}

function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function latitudeRowLowerBoundKm(row: number, queryLat: number): number {
  const minimum = -90 + row * GRID_SIZE_DEGREES;
  const maximum = minimum + GRID_SIZE_DEGREES;
  const difference = queryLat < minimum ? minimum - queryLat : queryLat > maximum ? queryLat - maximum : 0;
  return (difference * Math.PI * EARTH_RADIUS_KM) / 180;
}

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRadians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * toRadians;
  const deltaLon = wrapLongitude(lon2 - lon1) * toRadians;
  const startLat = lat1 * toRadians;
  const endLat = lat2 * toRadians;
  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
