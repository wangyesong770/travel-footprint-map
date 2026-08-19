import type { MultiPolygonGeometry, PolygonCoordinates, Position } from '../domain/types';

export type CountryCode = Uppercase<string>;
export type AreaId = `${CountryCode}:${string}:${string}`;

export interface PolygonGeometry {
  readonly type: 'Polygon';
  readonly coordinates: PolygonCoordinates;
}

export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface CityAreaProperties {
  readonly areaId: AreaId;
  readonly countryCode: CountryCode;
  readonly sourceId: string;
  readonly adminLevel: string;
  readonly nameZh?: string;
  readonly nameLocal: string;
  readonly aliases: readonly string[];
  readonly centroid: Readonly<Position>;
}

export interface CityArea {
  readonly type: 'Feature';
  readonly properties: CityAreaProperties;
  readonly geometry: AreaGeometry;
}

export interface CountryManifestEntry {
  readonly schemaVersion: 1;
  readonly countryCode: CountryCode;
  readonly boundaryVersion: string;
  readonly administrativeScheme: string;
  readonly featureCount: number;
  readonly byteSize: number;
  readonly checksum: string;
  readonly updatedAt: string;
  readonly source: string;
  readonly attribution: string;
}

/** Validated, runtime representation reconstructed from a country wire package. */
export interface CountryBoundaryPackage {
  readonly schemaVersion: 1;
  readonly countryCode: CountryCode;
  readonly boundaryVersion: string;
  readonly administrativeScheme: string;
  readonly source: string;
  readonly attribution: string;
  readonly features: readonly CityArea[];
}

export interface CountryScheme {
  readonly countryCode: CountryCode;
  readonly source: string;
  readonly acceptedLevels: readonly string[];
  readonly labelZh: string;
  readonly status: 'verified' | 'fallback';
}
