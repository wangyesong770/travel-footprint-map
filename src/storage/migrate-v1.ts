import type { CityArea, CountryBoundaryPackage } from '../areas/types';
import type { AreaVisitSnapshot, DatePrecision, VisitRecord, VisitV2 } from '../domain/types';
import { findContainingAreas } from '../map/geometry';
import {
  createLegacyVisit,
  createMigrationResult,
  createVisitV2,
} from './migration-types';
import type { LegacyVisit, MigrationCandidate, MigrationResult } from './migration-types';

export interface MergedMigration {
  readonly visits: readonly VisitV2[];
  readonly legacyVisits: readonly LegacyVisit[];
}

function areaSnapshot(feature: CityArea): AreaVisitSnapshot {
  const properties = feature.properties;
  return {
    areaId: properties.areaId,
    countryCode: properties.countryCode,
    sourceId: properties.sourceId,
    adminLevel: properties.adminLevel,
    ...(properties.nameZh === undefined ? {} : { nameZh: properties.nameZh }),
    nameLocal: properties.nameLocal,
    aliases: [...properties.aliases],
    centroid: [properties.centroid[0], properties.centroid[1]],
  };
}

function candidate(feature: CityArea): MigrationCandidate {
  return {
    areaId: feature.properties.areaId,
    ...(feature.properties.nameZh === undefined ? {} : { nameZh: feature.properties.nameZh }),
    nameLocal: feature.properties.nameLocal,
  };
}

function resolvedVisit(source: VisitRecord, feature: CityArea): VisitV2 {
  return createVisitV2({
    areaId: feature.properties.areaId,
    areaSnapshot: areaSnapshot(feature),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(source.visitedOn === undefined ? {} : { visitedOn: source.visitedOn }),
    ...(source.datePrecision === undefined ? {} : { datePrecision: source.datePrecision }),
    ...(source.note === undefined ? {} : { note: source.note }),
  });
}

/** Maps legacy city centroids without discarding any non-unique source record. */
export function migrateCountryVisits(
  legacyVisits: readonly VisitRecord[],
  countryPackage: CountryBoundaryPackage | undefined,
): MigrationResult[] {
  return [...legacyVisits]
    .sort((left, right) => left.cityId - right.cityId)
    .map((source): MigrationResult => {
      if (countryPackage === undefined || source.citySnapshot.countryCode.toUpperCase() !== countryPackage.countryCode) {
        return createLegacyVisit({ status: 'country-unavailable', source });
      }
      const matches = findContainingAreas([source.citySnapshot.lon, source.citySnapshot.lat], countryPackage);
      if (matches.length === 0) return createLegacyVisit({ status: 'outside', source });
      if (matches.length > 1) {
        return createLegacyVisit({
          status: 'ambiguous',
          source,
          candidates: matches.map(candidate),
        });
      }
      return createMigrationResult({
        status: 'resolved',
        source,
        visit: resolvedVisit(source, matches[0]!),
      });
    });
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sourceLabel(source: VisitRecord): string {
  return source.citySnapshot.zhName?.trim() || source.citySnapshot.name.trim() || source.citySnapshot.asciiName.trim();
}

function compareSource(left: Extract<MigrationResult, { status: 'resolved' }>, right: Extract<MigrationResult, { status: 'resolved' }>): number {
  return left.source.cityId - right.source.cityId || left.source.updatedAt.localeCompare(right.source.updatedAt);
}

function overflowLegacy(result: Extract<MigrationResult, { status: 'resolved' }>): LegacyVisit {
  return createLegacyVisit({
    status: 'ambiguous',
    source: result.source,
    candidates: [{
      areaId: result.visit.areaId,
      ...(result.visit.areaSnapshot.nameZh === undefined ? {} : { nameZh: result.visit.areaSnapshot.nameZh }),
      nameLocal: result.visit.areaSnapshot.nameLocal,
    }],
  });
}

function mergeAreaGroup(group: readonly Extract<MigrationResult, { status: 'resolved' }>[]): {
  visit: VisitV2;
  overflow: LegacyVisit[];
} {
  if (group.length === 1) return { visit: createVisitV2(group[0]!.visit), overflow: [] };

  const ordered = [...group].sort(compareSource);
  const accepted: typeof ordered = [];
  const overflow: LegacyVisit[] = [];
  const noteParts: string[] = [];
  for (const result of ordered) {
    if (result.source.note === undefined || result.source.note.length === 0) {
      accepted.push(result);
      continue;
    }
    const part = `${sourceLabel(result.source)}：${result.source.note}`;
    const nextNote = [...noteParts, part].join('\n');
    if (codePointLength(nextNote) <= 500) {
      noteParts.push(part);
      accepted.push(result);
    } else {
      overflow.push(overflowLegacy(result));
    }
  }

  // A single maximum-length note may not fit once a label is added. Keep it
  // unchanged in the resolved visit and quarantine every other source.
  if (accepted.length === 0) {
    const first = ordered[0]!;
    return {
      visit: createVisitV2(first.visit),
      overflow: ordered.slice(1).map(overflowLegacy),
    };
  }

  const newest = [...accepted].sort((left, right) =>
    right.visit.updatedAt.localeCompare(left.visit.updatedAt) || right.source.cityId - left.source.cityId,
  )[0]!;
  const createdAt = accepted.map((result) => result.visit.createdAt).sort()[0]!;
  const updatedAt = accepted.map((result) => result.visit.updatedAt).sort().at(-1)!;
  const dated = accepted
    .filter((result): result is typeof result & { visit: VisitV2 & { visitedOn: string; datePrecision: DatePrecision } } =>
      result.visit.visitedOn !== undefined && result.visit.datePrecision !== undefined,
    )
    .sort((left, right) => left.visit.visitedOn.localeCompare(right.visit.visitedOn))[0];

  return {
    visit: createVisitV2({
      areaId: newest.visit.areaId,
      areaSnapshot: newest.visit.areaSnapshot,
      createdAt,
      updatedAt,
      ...(dated === undefined ? {} : { visitedOn: dated.visit.visitedOn, datePrecision: dated.visit.datePrecision }),
      ...(noteParts.length === 0 ? {} : { note: noteParts.join('\n') }),
    }),
    overflow,
  };
}

/** Consolidates unique mappings by area ID while retaining every unresolved source. */
export function mergeMappedVisits(mappedVisits: readonly MigrationResult[]): MergedMigration {
  const groups = new Map<string, Extract<MigrationResult, { status: 'resolved' }>[]>();
  const legacyVisits: LegacyVisit[] = [];
  for (const result of mappedVisits) {
    if (result.status !== 'resolved') {
      legacyVisits.push(createLegacyVisit(result));
      continue;
    }
    const group = groups.get(result.visit.areaId) ?? [];
    group.push(result);
    groups.set(result.visit.areaId, group);
  }

  const visits: VisitV2[] = [];
  for (const areaId of [...groups.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    const merged = mergeAreaGroup(groups.get(areaId)!);
    visits.push(merged.visit);
    legacyVisits.push(...merged.overflow);
  }
  legacyVisits.sort((left, right) => left.source.cityId - right.source.cityId || left.status.localeCompare(right.status));
  return { visits, legacyVisits };
}
