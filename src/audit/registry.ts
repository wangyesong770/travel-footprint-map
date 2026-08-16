import releasePolicy from '../../data-audit/release.json';
import registryData from '../../data-audit/sovereign-registry.json';
import type { CountryCode } from '../areas/types';
import {
  CountryAuditError,
  type AuditRegion,
  type AuditReference,
  type AuditRegistry,
  type AuditStatus,
  type CountExpectation,
  type CountryAuditConfig,
  type LocalTypeRule,
  type NonSovereignExclusion,
  type OvertureSelector,
  type PoliticalPerspective,
} from './types';

const MAX_REFERENCES = 16;
const MAX_EXCEPTION_IDS = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_COUNTRY_CODE = /^[A-Z]{2}$/;
const WORLD_GEOMETRY_ID = /^[A-Z0-9-]{2,4}$/;
const AUDIT_REGIONS = new Set<AuditRegion>([
  'east-asia-pacific',
  'south-central-asia',
  'europe',
  'middle-east-north-africa',
  'sub-saharan-africa',
  'north-america-caribbean',
  'latin-america',
]);
const NON_SOVEREIGN_POLICIES = Object.freeze({
  antarctica: Object.freeze({ sourceCountryCodes: Object.freeze(['AQ']), worldGeometryIds: Object.freeze(['AQ']) }),
  'bir-tawil': Object.freeze({ sourceCountryCodes: Object.freeze([]), worldGeometryIds: Object.freeze(['BRT']) }),
  'brazilian-island': Object.freeze({ sourceCountryCodes: Object.freeze([]), worldGeometryIds: Object.freeze(['BRI']) }),
});
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class FrozenLookup<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

const fail = (code: ConstructorParameters<typeof CountryAuditError>[0]): never => {
  throw new CountryAuditError(code);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const assertRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return fail('INVALID_CONFIG');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || PROTOTYPE_KEYS.has(key)) return fail('PROTOTYPE_KEY');
  }
  return value;
};

const assertKnownKeys = (record: Record<string, unknown>, allowed: readonly string[]): void => {
  const whitelist = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!whitelist.has(key)) fail('UNKNOWN_KEY');
  }
};

const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });

const readText = (value: unknown, maximum = 256): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    return fail('INVALID_CONFIG');
  }
  if (containsControlCharacter(value)) return fail('CONTROL_CHARACTER');
  return value;
};

const readDate = (value: unknown): string => {
  const date = readText(value, 10);
  if (!ISO_DATE.test(date)) return fail('INVALID_CONFIG');
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    return fail('INVALID_CONFIG');
  }
  return date;
};

const readCountryCode = (value: unknown): CountryCode => {
  const code = readText(value, 2);
  if (!ISO_COUNTRY_CODE.test(code)) return fail('INVALID_CONFIG');
  return code as CountryCode;
};

const readWorldGeometryIds = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 64) return fail('INVALID_CONFIG');
  const ids = value.map((item) => readText(item, 4));
  if (ids.some((id) => !WORLD_GEOMETRY_ID.test(id)) || new Set(ids).size !== ids.length) {
    return fail('INVALID_CONFIG');
  }
  return Object.freeze(ids);
};

const readAuditRegion = (value: unknown): AuditRegion => {
  if (typeof value !== 'string' || !AUDIT_REGIONS.has(value as AuditRegion)) {
    return fail('INVALID_CONFIG');
  }
  return value as AuditRegion;
};

const readUniqueStrings = (
  value: unknown,
  options: {
    readonly maximum: number;
    readonly countryCodes?: boolean;
    readonly duplicateSourceCode?: boolean;
  },
): readonly string[] => {
  if (!Array.isArray(value) || value.length > options.maximum) return fail('INVALID_CONFIG');
  const values = value.map((item) =>
    options.countryCodes ? readCountryCode(item) : readText(item, 256),
  );
  if (new Set(values).size !== values.length) {
    return fail(options.duplicateSourceCode ? 'DUPLICATE_SOURCE_CODE' : 'DUPLICATE_EXCEPTION_ID');
  }
  return Object.freeze(values);
};

const readInteger = (value: unknown, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail('INVALID_CONFIG');
  }
  return value as number;
};

const readLocalTypeRule = (value: unknown): LocalTypeRule => {
  const record = assertRecord(value);
  assertKnownKeys(record, ['field', 'values']);
  if (record['field'] !== 'local_type') return fail('INVALID_CONFIG');
  const values = readUniqueStrings(record['values'], { maximum: 128 });
  if (values.length === 0) return fail('INVALID_CONFIG');
  return Object.freeze({ field: 'local_type' as const, values });
};

const readSelector = (value: unknown): OvertureSelector => {
  const record = assertRecord(value);
  assertKnownKeys(record, ['subtypes', 'adminLevels', 'localTypeRules']);
  const subtypes = readUniqueStrings(record['subtypes'], { maximum: 128 });
  if (!Array.isArray(record['adminLevels']) || record['adminLevels'].length > 32) {
    return fail('INVALID_CONFIG');
  }
  const adminLevels = record['adminLevels'].map((level) => readInteger(level, 0, 100));
  if (new Set(adminLevels).size !== adminLevels.length) return fail('INVALID_CONFIG');
  if (!Array.isArray(record['localTypeRules']) || record['localTypeRules'].length > 32) {
    return fail('INVALID_CONFIG');
  }
  const localTypeRules = record['localTypeRules'].map(readLocalTypeRule);
  if (subtypes.length === 0 && adminLevels.length === 0 && localTypeRules.length === 0) {
    return fail('EMPTY_SELECTOR');
  }
  return Object.freeze({
    subtypes,
    adminLevels: Object.freeze(adminLevels),
    localTypeRules: Object.freeze(localTypeRules),
  });
};

const readCountExpectation = (value: unknown): CountExpectation => {
  const record = assertRecord(value);
  assertKnownKeys(record, ['minimum', 'maximum', 'referenceDate']);
  const minimum = readInteger(record['minimum'], 0, Number.MAX_SAFE_INTEGER);
  const maximum = readInteger(record['maximum'], 0, Number.MAX_SAFE_INTEGER);
  if (minimum > maximum) return fail('INVALID_CONFIG');
  return Object.freeze({ minimum, maximum, referenceDate: readDate(record['referenceDate']) });
};

const readReference = (value: unknown): AuditReference => {
  const record = assertRecord(value);
  assertKnownKeys(record, ['title', 'url', 'retrievedOn', 'license']);
  const rawUrl = readText(record['url'], 2048);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail('REFERENCE_URL_INVALID');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return fail('REFERENCE_URL_INVALID');
  }
  return Object.freeze({
    title: readText(record['title']),
    url: rawUrl,
    retrievedOn: readDate(record['retrievedOn']),
    license: readText(record['license']),
  });
};

const readNonSovereignExclusion = (value: unknown): NonSovereignExclusion => {
  const record = assertRecord(value);
  assertKnownKeys(record, [
    'key',
    'sourceCountryCodes',
    'worldGeometryIds',
    'reason',
    'officialReferences',
  ]);
  if (typeof record['key'] !== 'string' || !(record['key'] in NON_SOVEREIGN_POLICIES)) {
    return fail('INVALID_CONFIG');
  }
  const key = record['key'] as keyof typeof NON_SOVEREIGN_POLICIES;
  const policy = NON_SOVEREIGN_POLICIES[key];
  const sourceCountryCodes = readUniqueStrings(record['sourceCountryCodes'], {
    maximum: 4,
    countryCodes: true,
  });
  const worldGeometryIds = readWorldGeometryIds(record['worldGeometryIds']);
  if (
    JSON.stringify(sourceCountryCodes) !== JSON.stringify(policy.sourceCountryCodes)
    || JSON.stringify(worldGeometryIds) !== JSON.stringify(policy.worldGeometryIds)
  ) {
    return fail('INVALID_CONFIG');
  }
  if (!Array.isArray(record['officialReferences']) || record['officialReferences'].length === 0) {
    return fail('INVALID_CONFIG');
  }
  if (record['officialReferences'].length > MAX_REFERENCES) return fail('TOO_MANY_REFERENCES');
  return Object.freeze({
    key,
    sourceCountryCodes: Object.freeze(sourceCountryCodes as CountryCode[]),
    worldGeometryIds: Object.freeze(worldGeometryIds),
    reason: readText(record['reason']),
    officialReferences: Object.freeze(record['officialReferences'].map(readReference)),
  });
};

const readCountry = (value: unknown): CountryAuditConfig => {
  const record = assertRecord(value);
  assertKnownKeys(record, [
    'sovereignCode',
    'sourceCountryCodes',
    'nameZh',
    'nameLocal',
    'auditRegion',
    'worldGeometryIds',
    'productLevel',
    'selectorVersion',
    'overtureSelector',
    'allowlist',
    'denylist',
    'expectedCount',
    'officialReferences',
    'perspective',
    'auditedAt',
    'status',
  ]);
  const sovereignCode = readCountryCode(record['sovereignCode']);
  const sourceCountryCodes = readUniqueStrings(record['sourceCountryCodes'], {
    maximum: 64,
    countryCodes: true,
    duplicateSourceCode: true,
  }) as readonly CountryCode[];
  if (sourceCountryCodes.length === 0 || !sourceCountryCodes.includes(sovereignCode)) {
    return fail('INVALID_CONFIG');
  }
  if (
    !Array.isArray(record['allowlist']) ||
    !Array.isArray(record['denylist']) ||
    record['allowlist'].length + record['denylist'].length > MAX_EXCEPTION_IDS
  ) {
    return fail('TOO_MANY_EXCEPTION_IDS');
  }
  const allowlist = readUniqueStrings(record['allowlist'], { maximum: MAX_EXCEPTION_IDS });
  const denylist = readUniqueStrings(record['denylist'], { maximum: MAX_EXCEPTION_IDS });
  const overlap = allowlist.some((id) => denylist.includes(id));
  if (overlap) return fail('DUPLICATE_EXCEPTION_ID');
  if (!Array.isArray(record['officialReferences'])) return fail('INVALID_CONFIG');
  if (record['officialReferences'].length > MAX_REFERENCES) return fail('TOO_MANY_REFERENCES');
  if (record['officialReferences'].length === 0) return fail('INVALID_CONFIG');
  const officialReferences = Object.freeze(record['officialReferences'].map(readReference));
  const perspective = record['perspective'];
  if (perspective !== 'china-official' && perspective !== 'overture-default') {
    return fail('INVALID_PERSPECTIVE');
  }
  if (
    (sovereignCode === 'CN' && perspective !== 'china-official') ||
    (sovereignCode !== 'CN' && perspective === 'china-official')
  ) {
    return fail('INVALID_PERSPECTIVE');
  }
  const status = record['status'];
  if (status !== 'draft' && status !== 'failed' && status !== 'verified') {
    return fail('INVALID_CONFIG');
  }
  return Object.freeze({
    sovereignCode,
    sourceCountryCodes,
    nameZh: readText(record['nameZh']),
    nameLocal: readText(record['nameLocal']),
    auditRegion: readAuditRegion(record['auditRegion']),
    worldGeometryIds: readWorldGeometryIds(record['worldGeometryIds']),
    productLevel: readText(record['productLevel'], 64),
    selectorVersion: readInteger(record['selectorVersion'], 1, Number.MAX_SAFE_INTEGER),
    overtureSelector: readSelector(record['overtureSelector']),
    allowlist,
    denylist,
    expectedCount: readCountExpectation(record['expectedCount']),
    officialReferences,
    perspective: perspective as PoliticalPerspective,
    auditedAt: readDate(record['auditedAt']),
    status: status as AuditStatus,
  });
};

export const loadAuditRegistry = (input: unknown): AuditRegistry => {
  const record = assertRecord(input);
  assertKnownKeys(record, ['release', 'schemaVersion', 'nonSovereignExclusions', 'countries']);
  if (record['release'] !== releasePolicy.release) return fail('RELEASE_MISMATCH');
  if (record['schemaVersion'] !== releasePolicy.schemaVersion) {
    return fail('SCHEMA_VERSION_MISMATCH');
  }
  if (!Array.isArray(record['countries'])) return fail('INVALID_CONFIG');
  if (!Array.isArray(record['nonSovereignExclusions'])) return fail('INVALID_CONFIG');

  const nonSovereignExclusions = record['nonSovereignExclusions'].map(readNonSovereignExclusion);
  if (nonSovereignExclusions.length < 1 || nonSovereignExclusions.length > 3) {
    return fail('INVALID_CONFIG');
  }
  if (new Set(nonSovereignExclusions.map((entry) => entry.key)).size !== nonSovereignExclusions.length) {
    return fail('INVALID_CONFIG');
  }

  const worldEntries = record['countries'].map(readCountry);
  const sovereignEntries: Array<readonly [string, CountryAuditConfig]> = [];
  const sourceEntries: Array<readonly [string, CountryAuditConfig]> = [];
  const sovereignCodes = new Set<string>();
  const sourceCodes = new Set<string>();
  for (const config of worldEntries) {
    if (sovereignCodes.has(config.sovereignCode)) return fail('DUPLICATE_SOVEREIGN_CODE');
    sovereignCodes.add(config.sovereignCode);
    sovereignEntries.push([config.sovereignCode, config]);
    for (const sourceCode of config.sourceCountryCodes) {
      if (sourceCodes.has(sourceCode)) return fail('DUPLICATE_SOURCE_CODE');
      sourceCodes.add(sourceCode);
      sourceEntries.push([sourceCode, config]);
    }
  }

  return Object.freeze({
    release: releasePolicy.release,
    schemaVersion: releasePolicy.schemaVersion,
    worldEntries: Object.freeze(worldEntries),
    nonSovereignExclusions: Object.freeze(nonSovereignExclusions),
    bySovereignCode: new FrozenLookup(sovereignEntries),
    bySourceCode: new FrozenLookup(sourceEntries),
  });
};

export const auditRegistry = loadAuditRegistry(registryData);

const normalizeLookupCode = (countryCode: string): string => {
  if (!/^[A-Za-z]{2}$/.test(countryCode)) return fail('COUNTRY_UNCONFIGURED');
  return countryCode.toUpperCase();
};

export const requireVerifiedCountryConfig = (countryCode: string): CountryAuditConfig => {
  const normalized = normalizeLookupCode(countryCode);
  const config = auditRegistry.bySovereignCode.get(normalized);
  if (!config) return fail('COUNTRY_UNCONFIGURED');
  if (config.status !== 'verified') return fail('COUNTRY_NOT_VERIFIED');
  return config;
};
