import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildAuditQueue,
  parseAuditQueueArguments,
  parseWorldMapIds,
  readSnapshotSourceCodes,
} from './list-audit-queue.mjs';

const country = (sovereignCode, sourceCountryCodes = [sovereignCode], overrides = {}) => ({
  sovereignCode,
  sourceCountryCodes,
  nameZh: sovereignCode,
  nameLocal: sovereignCode,
  auditRegion: 'east-asia-pacific',
  worldGeometryIds: [sovereignCode],
  perspective: sovereignCode === 'CN' ? 'china-official' : 'overture-default',
  status: 'draft',
  ...overrides,
});

const input = (overrides = {}) => ({
  registry: {
    release: '2026-06-17.0',
    nonSovereignExclusions: [{
      key: 'antarctica',
      sourceCountryCodes: ['AQ'],
      worldGeometryIds: ['AQ'],
      reason: 'Antarctica is not a sovereign country.',
      officialReferences: [{ url: 'https://www.ats.aq/e/antarctictreaty.html' }],
    }],
    countries: [
      country('CN', ['CN', 'HK', 'MO', 'TW']),
      country('US', ['US', 'PR'], { worldGeometryIds: ['PR', 'US'] }),
    ],
  },
  release: '2026-06-17.0',
  overtureSourceCodes: ['CN', 'HK', 'MO', 'PR', 'TW', 'US'],
  worldCountryIds: ['US', 'CN', 'PR'],
  selectorCodes: [],
  reportCodes: [],
  packageCodes: [],
  ...overrides,
});

describe('buildAuditQueue', () => {
  it('rejects an Overture source country code without one sovereign owner', () => {
    const result = buildAuditQueue(input({
      overtureSourceCodes: ['CN', 'HK', 'MO', 'PR', 'TW', 'US', 'ZZ'],
    }));

    expect(result.errors).toContainEqual({ code: 'SOURCE_OWNER_MISSING', id: 'ZZ' });
  });

  it('rejects a registered source mapping absent from the actual snapshot', () => {
    const result = buildAuditQueue(input({
      overtureSourceCodes: ['CN', 'HK', 'MO', 'PR', 'TW'],
    }));

    expect(result.errors).toContainEqual({ code: 'SOURCE_MAPPING_STALE', id: 'US' });
  });

  it('rejects one source country code assigned to two sovereign owners', () => {
    const value = input();
    value.registry.countries.push(country('CA', ['CA', 'PR']));

    expect(buildAuditQueue(value).errors).toContainEqual({
      code: 'SOURCE_OWNER_DUPLICATE',
      id: 'PR',
    });
  });

  it('rejects independent Hong Kong, Macau, or Taiwan sovereign entries', () => {
    const value = input();
    value.registry.countries.push(country('HK'));

    expect(buildAuditQueue(value).errors).toContainEqual({
      code: 'CHINA_SUBENTRY_FORBIDDEN',
      id: 'HK',
    });
  });

  it('rejects a sovereign country with no mapped world geometry', () => {
    const value = input();
    value.registry.countries.push(country('AD', ['AD'], { worldGeometryIds: [] }));

    expect(buildAuditQueue(value).errors).toContainEqual({
      code: 'WORLD_GEOMETRY_MISSING',
      id: 'AD',
    });
  });

  it('accepts the explicit Antarctica exclusion without treating it as a sovereign country', () => {
    const value = input({
      worldCountryIds: ['CN', 'PR', 'US', 'AQ'],
      overtureSourceCodes: ['AQ', 'CN', 'HK', 'MO', 'PR', 'TW', 'US'],
    });
    value.registry.countries[1].worldGeometryIds = ['PR', 'US'];
    const result = buildAuditQueue(value);

    expect(result.errors).toEqual([]);
    expect(result.rows.some((row) => row.sovereignCode === 'AQ')).toBe(false);
  });

  it('does not allow disputed EH or GS to hide behind non-sovereign exclusions', () => {
    const value = input({
      worldCountryIds: ['CN', 'PR', 'US', 'EH'],
      overtureSourceCodes: ['CN', 'GS', 'HK', 'MO', 'PR', 'TW', 'US'],
    });
    const result = buildAuditQueue(value);

    expect(result.errors).toContainEqual({ code: 'WORLD_OWNER_MISSING', id: 'EH' });
    expect(result.errors).toContainEqual({ code: 'SOURCE_OWNER_MISSING', id: 'GS' });
  });

  it('rejects an AQ exclusion without auditable evidence', () => {
    const value = input();
    value.registry.nonSovereignExclusions[0].officialReferences = [];

    expect(() => buildAuditQueue(value)).toThrow(/EXCLUSIONS_INVALID/);
  });

  it('returns stable sovereign-sorted rows and exact artifact status', () => {
    const value = input({
      selectorCodes: ['US'],
      reportCodes: ['CN'],
      packageCodes: ['US'],
    });
    value.registry.countries[1].worldGeometryIds = ['PR', 'US'];
    const result = buildAuditQueue(value);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        sovereignCode: 'CN',
        sourceCountryCodes: ['CN', 'HK', 'MO', 'TW'],
        perspective: 'china-official',
        configStatus: 'draft',
        selectorStatus: 'missing',
        reportStatus: 'present',
        packageStatus: 'missing',
      },
      {
        sovereignCode: 'US',
        sourceCountryCodes: ['PR', 'US'],
        perspective: 'overture-default',
        configStatus: 'draft',
        selectorStatus: 'present',
        reportStatus: 'missing',
        packageStatus: 'present',
      },
    ]);
  });

  it('reports extra selectors, reports, and packages with stable codes', () => {
    const result = buildAuditQueue(input({
      selectorCodes: ['ZZ'],
      reportCodes: ['ZZ'],
      packageCodes: ['ZZ'],
    }));

    expect(result.errors).toEqual([
      { code: 'PACKAGE_UNREGISTERED', id: 'ZZ' },
      { code: 'REPORT_UNREGISTERED', id: 'ZZ' },
      { code: 'SELECTOR_UNREGISTERED', id: 'ZZ' },
    ]);
  });

  it('rejects a world geometry id assigned to two sovereign owners', () => {
    const value = input();
    value.registry.countries[1].worldGeometryIds = ['CN', 'PR', 'US'];

    expect(buildAuditQueue(value).errors).toContainEqual({
      code: 'WORLD_OWNER_DUPLICATE',
      id: 'CN',
    });
  });

  it('rejects a configured geometry id absent from the checked-in world layer', () => {
    const value = input();
    value.registry.countries[1].worldGeometryIds = ['PR', 'US', 'ZZ'];

    expect(buildAuditQueue(value).errors).toContainEqual({
      code: 'WORLD_MAPPING_STALE',
      id: 'ZZ',
    });
  });

  it('parses every generated world-map id exactly once', () => {
    expect(parseWorldMapIds('export const WORLD_MAP = {"countries":[{"id":"CN"},{"id":"US"}]} as const;'))
      .toEqual(['CN', 'US']);
    expect(() => parseWorldMapIds('{"countries":[{"id":"CN"},{"id":"CN"}]}'))
      .toThrow(/WORLD_ID_DUPLICATE:CN/);
  });
});

describe('snapshot-backed CLI input', () => {
  it('exposes the audit queue as a stable package command', async () => {
    const packageDocument = JSON.parse(await readFile('package.json', 'utf8'));
    expect(packageDocument.scripts?.['audit:queue']).toBe('node scripts/audit/list-audit-queue.mjs');
  });

  it('requires both release and snapshot arguments', () => {
    expect(() => parseAuditQueueArguments(['--release', '2026-06-17.0'])).toThrow(/SNAPSHOT_REQUIRED/);
    expect(parseAuditQueueArguments([
      '--snapshot', 'cache/divisions', '--release', '2026-06-17.0',
    ])).toEqual({ release: '2026-06-17.0', snapshotDir: path.resolve('cache/divisions') });
  });

  it('reads actual source codes from bounded snapshot metadata', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'audit-queue-'));
    try {
      await mkdir(path.join(directory, 'snapshot'));
      await writeFile(path.join(directory, 'snapshot', 'metadata.json'), JSON.stringify({
        schemaVersion: 1,
        release: '2026-06-17.0',
        rowCounts: { US: 12, CN: 9, HK: 2 },
        unresolved: { rowCount: 0, byteSize: 128, sha256: 'a'.repeat(64) },
      }));
      await expect(readSnapshotSourceCodes(path.join(directory, 'snapshot'), '2026-06-17.0'))
        .resolves.toEqual(['CN', 'HK', 'US']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects legacy snapshot metadata without the unresolved-row contract', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'audit-queue-'));
    try {
      await writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
        schemaVersion: 1,
        release: '2026-06-17.0',
        rowCounts: { CN: 9 },
      }));
      await expect(readSnapshotSourceCodes(directory, '2026-06-17.0'))
        .rejects.toThrow(/^SNAPSHOT_METADATA_INVALID$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('blocks a snapshot that still contains unresolved source-country rows', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'audit-queue-'));
    try {
      await mkdir(path.join(directory, 'snapshot'));
      await writeFile(path.join(directory, 'snapshot', 'metadata.json'), JSON.stringify({
        schemaVersion: 1,
        release: '2026-06-17.0',
        rowCounts: { CN: 9 },
        unresolved: { rowCount: 2, byteSize: 128, sha256: 'a'.repeat(64) },
      }));
      await expect(readSnapshotSourceCodes(path.join(directory, 'snapshot'), '2026-06-17.0'))
        .rejects.toThrow(/^SNAPSHOT_UNRESOLVED_ROWS$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts only an exact reviewed override set bound to unresolved snapshot evidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'audit-queue-'));
    const evidence = { rowCount: 1, byteSize: 128, sha256: 'a'.repeat(64) };
    const overrides = {
      schemaVersion: 1,
      release: '2026-06-17.0',
      unresolved: evidence,
      overrides: [{
        divisionId: '6ef6ba55-8e2d-4096-ac67-537311eee277',
        divisionAreaId: '281a46b3-bdca-427e-9a5a-743985484b7e',
        sovereignCode: 'CN',
        rationale: 'Exact reviewed feature.',
        officialReferences: [{ title: 'Official', url: 'https://example.gov/evidence', retrievedOn: '2026-08-19', license: 'Public' }],
      }],
    };
    try {
      await writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
        schemaVersion: 1, release: '2026-06-17.0', rowCounts: { CN: 9 }, unresolved: evidence,
      }));
      await expect(readSnapshotSourceCodes(directory, '2026-06-17.0', overrides, new Set(['CN'])))
        .resolves.toEqual(['CN']);
      overrides.overrides[0].sovereignCode = 'ZZ';
      await expect(readSnapshotSourceCodes(directory, '2026-06-17.0', overrides, new Set(['CN'])))
        .rejects.toThrow(/^UNRESOLVED_OVERRIDE_INVALID$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses stable snapshot errors without leaking the supplied filesystem path', async () => {
    const secretPath = path.join(tmpdir(), 'private-user-name', 'missing-snapshot');
    await expect(readSnapshotSourceCodes(secretPath, '2026-06-17.0'))
      .rejects.toThrow(/^SNAPSHOT_METADATA_MISSING$/);

    const directory = await mkdtemp(path.join(tmpdir(), 'audit-queue-'));
    try {
      await writeFile(path.join(directory, 'metadata.json'), '{bad json');
      await expect(readSnapshotSourceCodes(directory, '2026-06-17.0'))
        .rejects.toThrow(/^SNAPSHOT_METADATA_INVALID$/);
      await writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
        schemaVersion: 1, release: '2026-07-01.0', rowCounts: { CN: 1 },
      }));
      await expect(readSnapshotSourceCodes(directory, '2026-06-17.0'))
        .rejects.toThrow(/^SNAPSHOT_RELEASE_MISMATCH$/);
      await writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
        schemaVersion: 1, release: '2026-06-17.0', rowCounts: { CN: 0 },
      }));
      await expect(readSnapshotSourceCodes(directory, '2026-06-17.0'))
        .rejects.toThrow(/^SNAPSHOT_METADATA_INVALID$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('checked-in sovereign baseline', () => {
  it('contains the exact 197-entry Chinese MFA baseline and only evidence-backed verified countries', async () => {
    const registry = JSON.parse(await readFile('data-audit/sovereign-registry.json', 'utf8'));
    const expected = 'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NU NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'.split(' ');

    expect(registry.countries.map((entry) => entry.sovereignCode)).toEqual(expected);
    expect(registry.countries.filter((entry) => entry.status === 'verified').map((entry) => entry.sovereignCode)).toEqual(['AD']);
    expect(registry.countries.filter((entry) => entry.sovereignCode !== 'AD').every((entry) => entry.status === 'draft')).toBe(true);
  });

  it('uses explicit one-owner territory rules without absorbing Cook Islands or Niue', async () => {
    const registry = JSON.parse(await readFile('data-audit/sovereign-registry.json', 'utf8'));
    const owner = new Map();
    for (const entry of registry.countries) {
      for (const sourceCode of entry.sourceCountryCodes) {
        expect(owner.has(sourceCode)).toBe(false);
        owner.set(sourceCode, entry.sovereignCode);
      }
    }

    expect(['CN', 'HK', 'MO', 'TW'].map((code) => owner.get(code))).toEqual(['CN', 'CN', 'CN', 'CN']);
    expect(['XC', 'XD', 'XP', 'XR', 'XX'].map((code) => owner.get(code))).toEqual(['CN', 'CN', 'CN', 'CN', 'CN']);
    expect(owner.get('IO')).toBe('GB');
    expect(owner.get('FK')).toBe('AR');
    expect(owner.has('GS')).toBe(false);
    expect(owner.get('PR')).toBe('US');
    expect(owner.get('NC')).toBe('FR');
    expect(owner.get('CP')).toBe('FR');
    expect(owner.get('GL')).toBe('DK');
    expect(owner.get('XE')).toBe('NL');
    expect(owner.get('XS')).toBe('NL');
    expect(owner.get('XJ')).toBe('NO');
    expect(owner.get('XG')).toBe('PS');
    expect(owner.get('XW')).toBe('PS');
    expect(owner.has('PS')).toBe(false);
    expect(owner.get('XH')).toBe('SY');
    expect(owner.get('XK')).toBe('RS');
    expect(owner.get('CK')).toBe('CK');
    expect(owner.get('NU')).toBe('NU');
    expect(registry.countries.some((entry) => ['HK', 'MO', 'TW'].includes(entry.sovereignCode))).toBe(false);
  });

  it('maps the real 10m world layer completely except the explicit EH and GS blockers', async () => {
    const registry = JSON.parse(await readFile('data-audit/sovereign-registry.json', 'utf8'));
    const worldCountryIds = parseWorldMapIds(await readFile('src/generated/world-map.ts', 'utf8'));
    const result = buildAuditQueue({
      registry,
      release: registry.release,
      overtureSourceCodes: registry.countries.flatMap((entry) => entry.sourceCountryCodes),
      worldCountryIds,
      selectorCodes: [],
      reportCodes: [],
      packageCodes: [],
    });

    expect(result.errors.filter((error) => error.code.startsWith('WORLD_'))).toEqual([
      { code: 'WORLD_OWNER_MISSING', id: 'EH' },
      { code: 'WORLD_OWNER_MISSING', id: 'GS' },
    ]);
  });
});
