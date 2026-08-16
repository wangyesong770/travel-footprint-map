import { describe, expect, it } from 'vitest';

import {
  auditRegistry,
  loadAuditRegistry,
  requireVerifiedCountryConfig,
} from './registry';

const reference = {
  title: 'Official administrative divisions',
  url: 'https://example.gov/divisions',
  retrievedOn: '2026-08-16',
  license: 'Open Government Licence',
};

const country = {
  sovereignCode: 'AA',
  sourceCountryCodes: ['AA'],
  productLevel: 'municipality',
  selectorVersion: 1,
  overtureSelector: {
    subtypes: ['locality'],
    adminLevels: [8],
    localTypeRules: [{ field: 'local_type', values: ['municipality'] }],
  },
  allowlist: [],
  denylist: [],
  expectedCount: { minimum: 1, maximum: 100, referenceDate: '2026-01-01' },
  officialReferences: [reference],
  perspective: 'overture-default',
  auditedAt: '2026-08-16',
  status: 'verified',
};

const validInput = () => ({
  release: '2026-06-17.0',
  schemaVersion: 'v1.17.0',
  countries: [structuredClone(country)],
});

describe('loadAuditRegistry', () => {
  it('rejects duplicate sovereign countries', () => {
    const input = validInput();
    input.countries.push(structuredClone(country));

    expect(() => loadAuditRegistry(input)).toThrowError(/DUPLICATE_SOVEREIGN_CODE/);
  });

  it('rejects source country codes owned by two sovereign countries', () => {
    const input = validInput();
    input.countries.push({
      ...structuredClone(country),
      sovereignCode: 'BB',
      sourceCountryCodes: ['AA', 'BB'],
    });

    expect(() => loadAuditRegistry(input)).toThrowError(/DUPLICATE_SOURCE_CODE/);
  });

  it('classifies duplicate source codes inside one sovereign country', () => {
    const input = validInput();
    input.countries[0]!.sourceCountryCodes = ['AA', 'AA'];

    expect(() => loadAuditRegistry(input)).toThrowError(/DUPLICATE_SOURCE_CODE/);
  });

  it('rejects selectors without an effective predicate', () => {
    const input = validInput();
    input.countries[0]!.overtureSelector = {
      subtypes: [],
      adminLevels: [],
      localTypeRules: [],
    };

    expect(() => loadAuditRegistry(input)).toThrowError(/EMPTY_SELECTOR/);
  });

  it('rejects unknown keys instead of silently accepting misspelled policy', () => {
    const input: Record<string, unknown> = validInput();
    input['releasee'] = '2026-06-17.0';

    expect(() => loadAuditRegistry(input)).toThrowError(/UNKNOWN_KEY/);
  });

  it('rejects invalid political perspectives', () => {
    const input = validInput();
    input.countries[0]!.perspective = 'automatic' as 'overture-default';

    expect(() => loadAuditRegistry(input)).toThrowError(/INVALID_PERSPECTIVE/);
  });

  it('reserves the China official perspective for China', () => {
    const nonChina = validInput();
    nonChina.countries[0]!.perspective = 'china-official';
    expect(() => loadAuditRegistry(nonChina)).toThrowError(/INVALID_PERSPECTIVE/);

    const china = validInput();
    china.countries[0]!.sovereignCode = 'CN';
    china.countries[0]!.sourceCountryCodes = ['CN'];
    china.countries[0]!.perspective = 'overture-default';
    expect(() => loadAuditRegistry(china)).toThrowError(/INVALID_PERSPECTIVE/);
  });

  it('rejects impossible calendar dates', () => {
    const input = validInput();
    input.countries[0]!.auditedAt = '2026-02-31';

    expect(() => loadAuditRegistry(input)).toThrowError(/INVALID_CONFIG/);
  });

  it('rejects data from a different Overture release', () => {
    const input = validInput();
    input.release = '2026-07-15.0';

    expect(() => loadAuditRegistry(input)).toThrowError(/RELEASE_MISMATCH/);
  });

  it('rejects prototype keys, control characters, and non-HTTPS references', () => {
    const prototypeInput = validInput() as Record<string, unknown>;
    Object.defineProperty(prototypeInput, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    expect(() => loadAuditRegistry(prototypeInput)).toThrowError(/PROTOTYPE_KEY/);

    const controlInput = validInput();
    controlInput.countries[0]!.productLevel = 'city\u0000';
    expect(() => loadAuditRegistry(controlInput)).toThrowError(/CONTROL_CHARACTER/);

    const referenceInput = validInput();
    referenceInput.countries[0]!.officialReferences[0]!.url = 'http://example.gov';
    expect(() => loadAuditRegistry(referenceInput)).toThrowError(/REFERENCE_URL_INVALID/);
  });

  it('caps exception IDs and official references', () => {
    const allowlistInput = validInput();
    (allowlistInput.countries[0] as { allowlist: string[] }).allowlist = Array.from(
      { length: 1001 },
      (_, index) => String(index),
    );
    expect(() => loadAuditRegistry(allowlistInput)).toThrowError(/TOO_MANY_EXCEPTION_IDS/);

    const referenceInput = validInput();
    referenceInput.countries[0]!.officialReferences = Array.from(
      { length: 17 },
      () => structuredClone(reference),
    );
    expect(() => loadAuditRegistry(referenceInput)).toThrowError(/TOO_MANY_REFERENCES/);
  });

  it('reconstructs and deeply freezes whitelisted values', () => {
    const registry = loadAuditRegistry(validInput());
    const config = registry.bySovereignCode.get('AA')!;

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.worldEntries)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.sourceCountryCodes)).toBe(true);
    expect(Object.isFrozen(config.overtureSelector)).toBe(true);
    expect(Object.isFrozen(config.overtureSelector.localTypeRules)).toBe(true);
    expect(Object.isFrozen(config.officialReferences[0])).toBe(true);
    expect(() => (config.allowlist as string[]).push('unexpected')).toThrow();
  });
});

describe('production audit registry', () => {
  it('contains no verified seed country before package evidence is integrated', () => {
    expect(auditRegistry.worldEntries.filter((entry) => entry.status === 'verified')).toEqual([]);
  });

  it('assigns CN, HK, MO and TW to China without independent world entries', () => {
    for (const sourceCode of ['CN', 'HK', 'MO', 'TW']) {
      expect(auditRegistry.bySourceCode.get(sourceCode)?.sovereignCode).toBe('CN');
    }

    expect(auditRegistry.worldEntries.some((entry) => entry.sovereignCode === 'HK')).toBe(false);
    expect(auditRegistry.worldEntries.some((entry) => entry.sovereignCode === 'MO')).toBe(false);
    expect(auditRegistry.worldEntries.some((entry) => entry.sovereignCode === 'TW')).toBe(false);
  });

  it('rejects unknown and non-verified country lookup without fallback', () => {
    expect(() => requireVerifiedCountryConfig('ZZ')).toThrowError(/COUNTRY_UNCONFIGURED/);
    expect(() => requireVerifiedCountryConfig('FR')).toThrowError(/COUNTRY_NOT_VERIFIED/);
  });

  it('does not expose China as production-ready before its evidence is integrated', () => {
    expect(() => requireVerifiedCountryConfig('cn')).toThrowError(/COUNTRY_NOT_VERIFIED/);
  });
});
