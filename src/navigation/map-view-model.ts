import type {
  AreaId,
  CityAreaProperties,
  CountryCode,
  CountryManifestEntry,
} from '../areas/types';

export type MapLevel =
  | Readonly<{ kind: 'world' }>
  | Readonly<{ kind: 'country'; countryCode: CountryCode; focusedAreaId?: AreaId }>;

type FocusableArea = Readonly<{
  properties: Pick<CityAreaProperties, 'areaId' | 'countryCode'>;
}>;

export const WORLD_MAP_LEVEL: MapLevel = Object.freeze({ kind: 'world' });

export function enterCountry(
  countryCode: string,
  manifest: readonly CountryManifestEntry[],
): MapLevel {
  const normalized = normalizeCountryCode(countryCode);
  if (normalized === undefined || !manifest.some((entry) => entry.countryCode === normalized)) {
    throw new RangeError(`Country is not available in the manifest: ${countryCode}`);
  }

  return countryLevel(normalized);
}

export function focusArea(level: MapLevel, area: FocusableArea): MapLevel {
  if (level.kind !== 'country') {
    throw new RangeError('An area can only be focused from a country map');
  }

  if (!areaBelongsToCountry(area, level.countryCode)) {
    throw new RangeError(`Area does not belong to active country: ${area.properties.areaId}`);
  }

  return countryLevel(level.countryCode, area.properties.areaId);
}

export function returnToWorld(): MapLevel {
  return WORLD_MAP_LEVEL;
}

export function restoreView(
  stored: unknown,
  manifest: readonly CountryManifestEntry[],
  areas: readonly FocusableArea[],
): MapLevel {
  if (!isRecord(stored)) {
    return WORLD_MAP_LEVEL;
  }

  if (stored.kind === 'world') {
    return WORLD_MAP_LEVEL;
  }

  if (stored.kind !== 'country' || typeof stored.countryCode !== 'string') {
    return WORLD_MAP_LEVEL;
  }

  const normalized = normalizeCountryCode(stored.countryCode);
  if (normalized === undefined || !manifest.some((entry) => entry.countryCode === normalized)) {
    return WORLD_MAP_LEVEL;
  }

  if (typeof stored.focusedAreaId !== 'string') {
    return countryLevel(normalized);
  }

  const focused = areas.find((area) => area.properties.areaId === stored.focusedAreaId);
  if (focused === undefined || !areaBelongsToCountry(focused, normalized)) {
    return countryLevel(normalized);
  }

  return countryLevel(normalized, focused.properties.areaId);
}

function countryLevel(countryCode: CountryCode, focusedAreaId?: AreaId): MapLevel {
  return focusedAreaId === undefined
    ? Object.freeze({ kind: 'country', countryCode })
    : Object.freeze({ kind: 'country', countryCode, focusedAreaId });
}

function areaBelongsToCountry(area: FocusableArea, countryCode: CountryCode): boolean {
  const areaCountry = normalizeCountryCode(area.properties.countryCode);
  const idCountry = normalizeCountryCode(area.properties.areaId.split(':', 1)[0] ?? '');
  return areaCountry === countryCode && idCountry === countryCode;
}

function normalizeCountryCode(value: string): CountryCode | undefined {
  const trimmed = value.trim();
  if (!/^[A-Za-z]{2}$/.test(trimmed)) {
    return undefined;
  }

  return trimmed.toUpperCase() as CountryCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
