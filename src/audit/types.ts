import type { CountryCode } from '../areas/types';

export type AuditStatus = 'draft' | 'failed' | 'verified';
export type PoliticalPerspective = 'china-official' | 'overture-default';

export interface LocalTypeRule {
  readonly field: 'local_type';
  readonly values: readonly string[];
}

export interface OvertureSelector {
  readonly subtypes: readonly string[];
  readonly adminLevels: readonly number[];
  readonly localTypeRules: readonly LocalTypeRule[];
}

export interface CountExpectation {
  readonly minimum: number;
  readonly maximum: number;
  readonly referenceDate: string;
}

export interface AuditReference {
  readonly title: string;
  readonly url: string;
  readonly retrievedOn: string;
  readonly license: string;
}

export interface CountryAuditConfig {
  readonly sovereignCode: CountryCode;
  readonly sourceCountryCodes: readonly CountryCode[];
  readonly productLevel: string;
  readonly selectorVersion: number;
  readonly overtureSelector: OvertureSelector;
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  readonly expectedCount: CountExpectation;
  readonly officialReferences: readonly AuditReference[];
  readonly perspective: PoliticalPerspective;
  readonly auditedAt: string;
  readonly status: AuditStatus;
}

export type SovereignRegistryEntry = CountryAuditConfig;

export interface AuditRegistry {
  readonly release: string;
  readonly schemaVersion: string;
  readonly worldEntries: readonly SovereignRegistryEntry[];
  readonly bySovereignCode: ReadonlyMap<string, SovereignRegistryEntry>;
  readonly bySourceCode: ReadonlyMap<string, SovereignRegistryEntry>;
}

export type CountryAuditErrorCode =
  | 'CONTROL_CHARACTER'
  | 'COUNTRY_NOT_VERIFIED'
  | 'COUNTRY_UNCONFIGURED'
  | 'DUPLICATE_EXCEPTION_ID'
  | 'DUPLICATE_SOURCE_CODE'
  | 'DUPLICATE_SOVEREIGN_CODE'
  | 'EMPTY_SELECTOR'
  | 'INVALID_CONFIG'
  | 'INVALID_PERSPECTIVE'
  | 'PROTOTYPE_KEY'
  | 'REFERENCE_URL_INVALID'
  | 'RELEASE_MISMATCH'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'TOO_MANY_EXCEPTION_IDS'
  | 'TOO_MANY_REFERENCES'
  | 'UNKNOWN_KEY';

export class CountryAuditError extends Error {
  readonly code: CountryAuditErrorCode;

  constructor(code: CountryAuditErrorCode) {
    super(code);
    this.name = 'CountryAuditError';
    this.code = code;
  }
}
