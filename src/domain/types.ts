import type { AreaId, CountryCode } from '../areas/types';

export type ContinentCode = 'AF' | 'AN' | 'AS' | 'EU' | 'NA' | 'OC' | 'SA';
export type DatePrecision = 'year' | 'month' | 'day';

export interface CitySummary {
  id: number;
  name: string;
  asciiName: string;
  aliases: string[];
  countryCode: string;
  continentCode: ContinentCode;
  lat: number;
  lon: number;
  zhName?: string;
  admin1?: string;
  population?: number;
}

export type Position = [longitude: number, latitude: number];
export type LinearRing = Position[];
export type PolygonCoordinates = LinearRing[];

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: PolygonCoordinates[];
}

export interface VisitRecord {
  cityId: number;
  citySnapshot: CitySummary;
  createdAt: string;
  updatedAt: string;
  visitedOn?: string;
  datePrecision?: DatePrecision;
  note?: string;
}

export interface AreaVisitSnapshot {
  readonly areaId: AreaId;
  readonly countryCode: CountryCode;
  readonly sourceId: string;
  readonly adminLevel: string;
  readonly nameZh?: string;
  readonly nameLocal: string;
  readonly aliases: readonly string[];
  readonly centroid: Readonly<Position>;
}

/** V2 visit identity is an administrative area; numeric city IDs are legacy-only. */
export interface VisitV2 {
  readonly areaId: AreaId;
  readonly areaSnapshot: AreaVisitSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly visitedOn?: string;
  readonly datePrecision?: DatePrecision;
  readonly note?: string;
}

export interface CachedBoundary {
  cityId: number;
  geometry: MultiPolygonGeometry;
  source: string;
  fetchedAt: string;
  sourceUrl?: string;
}

export interface BackupV1 {
  schemaVersion: 1;
  exportedAt: string;
  title: string;
  visits: VisitRecord[];
  boundaries: CachedBoundary[];
}

export interface TravelStats {
  cityCount: number;
  countryCount: number;
  continentCounts: Partial<Record<ContinentCode, number>>;
}
