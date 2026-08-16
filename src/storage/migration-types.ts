import type { AreaId, CountryBoundaryPackage, CountryCode } from '../areas/types';
import { validateVisitDate } from '../domain/validation';
import type { DatePrecision, VisitRecord, VisitV2 } from '../domain/types';

export interface MigrationCandidate {
  readonly areaId: AreaId;
  readonly nameZh?: string;
  readonly nameLocal: string;
}

interface LegacyVisitBase {
  readonly source: VisitRecord;
}

export interface AmbiguousLegacyVisit extends LegacyVisitBase {
  readonly status: 'ambiguous';
  readonly candidates: readonly MigrationCandidate[];
}

export interface UnmatchedLegacyVisit extends LegacyVisitBase {
  readonly status: 'outside' | 'country-unavailable';
  readonly candidates?: never;
}

export type LegacyVisit = AmbiguousLegacyVisit | UnmatchedLegacyVisit;

export interface ResolvedMigrationResult {
  readonly status: 'resolved';
  readonly source: VisitRecord;
  readonly visit: VisitV2;
}

export type MigrationResult = ResolvedMigrationResult | LegacyVisit;

export type ImmutablePosition = readonly [longitude: number, latitude: number];
export type ImmutableLinearRing = readonly ImmutablePosition[];
export type ImmutablePolygonCoordinates = readonly ImmutableLinearRing[];

export type ImmutableAreaGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: ImmutablePolygonCoordinates }
  | { readonly type: 'MultiPolygon'; readonly coordinates: readonly ImmutablePolygonCoordinates[] };

export interface VisitedAreaBoundary {
  readonly areaId: AreaId;
  readonly countryCode: CountryCode;
  readonly boundaryVersion: string;
  readonly source: string;
  readonly attribution: string;
  readonly geometry: ImmutableAreaGeometry;
}

export interface BackupV2 {
  readonly schemaVersion: 2;
  readonly exportedAt: string;
  readonly title: string;
  readonly visits: readonly VisitV2[];
  readonly legacyVisits: readonly LegacyVisit[];
  /** Complete boundaries for every visited area, independent of country-package inclusion. */
  readonly visitedAreaBoundaries: readonly VisitedAreaBoundary[];
  /** Optional complete validated packages make an explicitly requested backup fully offline. */
  readonly countryPackages?: readonly CountryBoundaryPackage[];
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function optionalNameZh(nameZh: string | undefined): { readonly nameZh?: string } {
  return nameZh === undefined ? {} : { nameZh };
}

function cloneLegacySource(source: VisitRecord): VisitRecord {
  return cloneAndFreeze(source);
}

function assertDatePrecision(visitedOn: string | undefined, datePrecision: DatePrecision | undefined): void {
  if (visitedOn === undefined && datePrecision === undefined) return;
  if (visitedOn === undefined || datePrecision === undefined) throw new Error('日期与日期精度必须同时提供');
  const validated = validateVisitDate(visitedOn);
  if (validated.precision !== datePrecision) throw new Error('日期精度与日期不匹配');
}

/** Reconstructs the exact V2 wire shape and detaches it from caller-owned objects. */
export function createVisitV2(input: VisitV2): VisitV2 {
  assertDatePrecision(input.visitedOn, input.datePrecision);
  if (input.areaId !== input.areaSnapshot.areaId) throw new Error('到访记录区域标识不一致');

  const visit: VisitV2 = {
    areaId: input.areaId,
    areaSnapshot: {
      areaId: input.areaSnapshot.areaId,
      countryCode: input.areaSnapshot.countryCode,
      sourceId: input.areaSnapshot.sourceId,
      adminLevel: input.areaSnapshot.adminLevel,
      ...optionalNameZh(input.areaSnapshot.nameZh),
      nameLocal: input.areaSnapshot.nameLocal,
      aliases: [...input.areaSnapshot.aliases],
      centroid: [input.areaSnapshot.centroid[0], input.areaSnapshot.centroid[1]],
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.visitedOn === undefined ? {} : { visitedOn: input.visitedOn }),
    ...(input.datePrecision === undefined ? {} : { datePrecision: input.datePrecision }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  return cloneAndFreeze(visit);
}

export function createLegacyVisit(input: AmbiguousLegacyVisit): AmbiguousLegacyVisit;
export function createLegacyVisit(input: UnmatchedLegacyVisit): UnmatchedLegacyVisit;
export function createLegacyVisit(input: LegacyVisit): LegacyVisit;
export function createLegacyVisit(input: LegacyVisit): LegacyVisit {
  const source = cloneLegacySource(input.source);
  if (input.status === 'ambiguous') {
    if (input.candidates.length === 0) throw new Error('候选区域不能为空');
    const candidates = input.candidates.map((candidate): MigrationCandidate => ({
      areaId: candidate.areaId,
      ...optionalNameZh(candidate.nameZh),
      nameLocal: candidate.nameLocal,
    }));
    return cloneAndFreeze({ status: 'ambiguous', source, candidates });
  }
  return cloneAndFreeze({ status: input.status, source });
}

export function createMigrationResult(input: MigrationResult): MigrationResult {
  switch (input.status) {
    case 'resolved':
      return cloneAndFreeze({
        status: 'resolved',
        source: cloneLegacySource(input.source),
        visit: createVisitV2(input.visit),
      });
    case 'ambiguous':
    case 'outside':
    case 'country-unavailable':
      return createLegacyVisit(input);
    default:
      throw new Error('不支持的迁移状态');
  }
}
