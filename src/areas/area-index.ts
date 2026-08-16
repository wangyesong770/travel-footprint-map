import type { AreaId, CountryCode } from './types';

interface BaseIndexRecord {
  readonly countryCode: CountryCode;
  readonly boundaryVersion: string;
  readonly nameZh?: string;
  readonly nameLocal: string;
  readonly aliases: readonly string[];
}

export interface CountryIndexRecord extends BaseIndexRecord {
  readonly kind: 'country';
}

export interface AreaIndexAreaRecord extends BaseIndexRecord {
  readonly kind: 'area';
  readonly areaId: AreaId;
  readonly adminLevel: string;
}

export type AreaIndexRecord = CountryIndexRecord | AreaIndexAreaRecord;

interface SearchResultBase {
  readonly countryCode: CountryCode;
  readonly boundaryVersion: string;
  readonly displayName: string;
  readonly secondaryLabel: string;
  readonly matchedName: string;
}

export interface CountrySearchResult extends SearchResultBase {
  readonly kind: 'country';
}

export interface AreaSearchResult extends SearchResultBase {
  readonly kind: 'area';
  readonly areaId: AreaId;
  readonly adminLevel: string;
}

export type AreaIndexSearchResult = CountrySearchResult | AreaSearchResult;

export interface AreaIndex {
  search(query: string, limit: number): readonly AreaIndexSearchResult[];
  hasCountryVersion(countryCode: string, boundaryVersion: string): boolean;
}

interface PreparedRecord {
  readonly record: AreaIndexRecord;
  readonly names: readonly { readonly original: string; readonly normalized: string; readonly priority: number }[];
}

const MAX_QUERY_CODE_POINTS = 160;

export const createAreaIndex = (records: readonly AreaIndexRecord[]): AreaIndex => {
  const stableRecords: readonly AreaIndexRecord[] = records.map((record) => Object.freeze({
    ...record,
    aliases: Object.freeze([...record.aliases]),
  }));
  const countries = new Map<string, CountryIndexRecord>();
  const identities = new Set<string>();

  for (const record of stableRecords) {
    validateRecord(record);
    const identity = record.kind === 'country' ? `country:${record.countryCode}` : `area:${record.areaId}`;
    if (identities.has(identity)) throw new Error(`duplicate index identity: ${identity}`);
    identities.add(identity);
    if (record.kind === 'country') countries.set(record.countryCode, record);
  }

  for (const record of stableRecords) {
    if (record.kind !== 'area') continue;
    const country = countries.get(record.countryCode);
    if (!country) throw new Error(`area country is not configured: ${record.countryCode}`);
    if (country.boundaryVersion !== record.boundaryVersion) {
      throw new Error(`area index boundary version mismatch: ${record.areaId}`);
    }
    if (!record.areaId.startsWith(`${record.countryCode}:`)) {
      throw new Error(`area ID country mismatch: ${record.areaId}`);
    }
  }

  const prepared: readonly PreparedRecord[] = stableRecords.map((record) => ({
    record,
    names: uniqueNames(record).map((original, priority) => ({ original, normalized: normalizeSearchText(original), priority })),
  }));

  return Object.freeze({
    search(query: string, limit: number): readonly AreaIndexSearchResult[] {
      const normalizedQuery = normalizeSearchText(query);
      if (
        normalizedQuery.length === 0 ||
        Array.from(query.trim()).length > MAX_QUERY_CODE_POINTS ||
        !Number.isFinite(limit) ||
        limit <= 0
      ) return [];

      const matches = prepared.flatMap(({ record, names }) => {
        let best: { matchRank: number; fieldRank: number; matchedName: string } | undefined;
        for (const name of names) {
          const matchRank = name.normalized === normalizedQuery ? 0
            : name.normalized.startsWith(normalizedQuery) ? 1
              : name.normalized.includes(normalizedQuery) ? 2 : undefined;
          if (matchRank === undefined) continue;
          const candidate = { matchRank, fieldRank: name.priority, matchedName: name.original };
          if (!best || compareTuple(candidate, best) < 0) best = candidate;
        }
        return best ? [{ record, ...best }] : [];
      });

      matches.sort((left, right) =>
        left.matchRank - right.matchRank ||
        (left.record.kind === right.record.kind ? 0 : left.record.kind === 'country' ? -1 : 1) ||
        left.fieldRank - right.fieldRank ||
        primaryName(left.record).localeCompare(primaryName(right.record), 'zh-Hans-CN') ||
        identityOf(left.record).localeCompare(identityOf(right.record), 'en'),
      );

      return matches.slice(0, Math.floor(limit)).map(({ record, matchedName }) => toResult(record, matchedName, countries));
    },
    hasCountryVersion(countryCode: string, boundaryVersion: string): boolean {
      const normalized = /^[A-Za-z]{2}$/.test(countryCode) ? countryCode.toUpperCase() : '';
      return countries.get(normalized)?.boundaryVersion === boundaryVersion;
    },
  });
};

const toResult = (
  record: AreaIndexRecord,
  matchedName: string,
  countries: ReadonlyMap<string, CountryIndexRecord>,
): AreaIndexSearchResult => {
  const displayName = primaryName(record);
  if (record.kind === 'country') {
    return Object.freeze({
      kind: 'country', countryCode: record.countryCode, boundaryVersion: record.boundaryVersion,
      displayName, secondaryLabel: record.nameLocal, matchedName,
    });
  }
  const country = countries.get(record.countryCode);
  if (!country) throw new Error(`missing country for area: ${record.areaId}`);
  return Object.freeze({
    kind: 'area', areaId: record.areaId, countryCode: record.countryCode,
    boundaryVersion: record.boundaryVersion, adminLevel: record.adminLevel,
    displayName, secondaryLabel: `${primaryName(country)} · ${record.adminLevel}`, matchedName,
  });
};

const compareTuple = (
  left: { matchRank: number; fieldRank: number },
  right: { matchRank: number; fieldRank: number },
): number => left.matchRank - right.matchRank || left.fieldRank - right.fieldRank;

const primaryName = (record: AreaIndexRecord): string => record.nameZh ?? record.nameLocal;

const uniqueNames = (record: AreaIndexRecord): readonly string[] =>
  [...new Set([...(record.nameZh ? [record.nameZh] : []), record.nameLocal, ...record.aliases])];

const normalizeSearchText = (value: string): string => value
  .normalize('NFKD')
  .replace(/\p{Mark}+/gu, '')
  .toLocaleLowerCase('und')
  .trim()
  .replace(/\s+/g, ' ');

const identityOf = (record: AreaIndexRecord): string =>
  record.kind === 'area' ? record.areaId : `country:${record.countryCode}`;

const validateRecord = (record: AreaIndexRecord): void => {
  if (!/^[A-Z]{2}$/.test(record.countryCode)) throw new Error('index country code must be uppercase ISO alpha-2');
  validateText(record.boundaryVersion, 'boundary version');
  validateText(record.nameLocal, 'local name');
  if (record.nameZh !== undefined) validateText(record.nameZh, 'Chinese name');
  if (!Array.isArray(record.aliases) || record.aliases.length > 20) throw new Error('aliases are invalid');
  record.aliases.forEach((alias) => validateText(alias, 'alias'));
  if (record.kind === 'area') {
    validateText(record.areaId, 'area ID');
    validateText(record.adminLevel, 'admin level');
  }
};

const validateText = (value: string, label: string): void => {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    Array.from(value).length > 160 || containsControlCharacter(value)
  ) throw new Error(`${label} is invalid`);
};

const containsControlCharacter = (value: string): boolean => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
});
