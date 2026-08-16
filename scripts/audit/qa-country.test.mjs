import assert from 'node:assert/strict';
import { test } from 'vitest';

import { auditCountry } from './qa-country.mjs';

const MiB = 1024 * 1024;
const polygon = (west = 0, south = 0, size = 1) => ({
  type: 'Polygon',
  coordinates: [[
    [west, south], [west + size, south], [west + size, south + size],
    [west, south + size], [west, south],
  ]],
});
const feature = (divisionId, geometry = polygon(), overrides = {}) => ({
  type: 'Feature',
  properties: {
    areaId: `AA:overture:${divisionId}`,
    sourceId: divisionId,
    divisionId,
    countryCode: 'AA',
    sourceCountryCode: 'AA',
    adminLevel: 'municipality',
    nameLocal: `Local ${divisionId}`,
    aliases: [],
    ...overrides,
  },
  geometry,
});
const config = (overrides = {}) => ({
  sovereignCode: 'AA',
  sourceCountryCodes: ['AA'],
  productLevel: 'municipality',
  expectedCount: { minimum: 2, maximum: 2, referenceDate: '2026-08-16' },
  ...overrides,
});
const codes = (result) => result.failures?.map(({ code }) => code) ?? [];

test('returns an explicit verified result with deterministic metrics', () => {
  const features = [feature('a'), feature('b', polygon(2, 0))];
  const result = auditCountry(features, config(), {
    indexIds: ['AA:overture:a', 'AA:overture:b'],
    compressedBytes: 1024,
  });

  assert.equal(result.status, 'verified');
  assert.deepEqual(result.exceptions, []);
  assert.deepEqual(result.metrics, {
    featureCount: 2,
    vertexCount: 10,
    vertices: { p50: 5, p95: 5, max: 5 },
    compressedBytes: 1024,
    warnings: [],
  });
});

test('fails malformed rings and non-finite coordinates with machine-readable geometry codes', () => {
  const open = feature('open');
  open.geometry.coordinates[0].pop();
  const nan = feature('nan');
  nan.geometry.coordinates[0][1][0] = Number.NaN;
  const result = auditCountry([open, nan], config({ expectedCount: { kind: 'range', min: 0, max: 5 } }), {
    indexIds: ['AA:overture:open', 'AA:overture:nan'], compressedBytes: 0,
  });

  assert.ok(codes(result).includes('RING_NOT_CLOSED'));
  assert.ok(codes(result).includes('COORDINATE_INVALID'));
});

test('fails when stable feature identities and area index identities differ', () => {
  const result = auditCountry([feature('a')], config({ expectedCount: { kind: 'exact', value: 1 } }), {
    indexIds: ['AA:overture:different'], compressedBytes: 0,
  });
  assert.ok(codes(result).includes('INDEX_ID_MISMATCH'));
});

test('fails an internally inconsistent divisionId/sourceId/areaId chain even when index IDs match', () => {
  const inconsistent = feature('a');
  inconsistent.properties.sourceId = 'different';
  const result = auditCountry([inconsistent], config({ expectedCount: { minimum: 1, maximum: 1 } }), {
    indexIds: ['AA:overture:a'], compressedBytes: 0,
  });
  assert.ok(codes(result).includes('IDENTITY_MISMATCH'));
});

test('fails a closed but zero-area ring', () => {
  const degenerate = feature('line', {
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]],
  });
  const result = auditCountry([degenerate], config({ expectedCount: { minimum: 1, maximum: 1 } }), {
    indexIds: ['AA:overture:line'], compressedBytes: 0,
  });
  assert.ok(codes(result).includes('RING_ZERO_AREA'));
});

test('detects overlap across the antimeridian without treating separated shapes as overlapping', () => {
  const crossing = {
    type: 'Polygon',
    coordinates: [[[179, 0], [-179, 0], [-179, 2], [179, 2], [179, 0]]],
  };
  const nearDateline = {
    type: 'Polygon',
    coordinates: [[[-180, 1], [-178, 1], [-178, 3], [-180, 3], [-180, 1]]],
  };
  const farAway = polygon(10, 10);
  const result = auditCountry(
    [feature('crossing', crossing), feature('near', nearDateline), feature('far', farAway)],
    config({ expectedCount: { minimum: 3, maximum: 3 } }),
    { indexIds: ['AA:overture:crossing', 'AA:overture:near', 'AA:overture:far'], compressedBytes: 0 },
  );
  assert.deepEqual(result.failures.filter(({ code }) => code === 'OVERLAP_UNEXPLAINED'), [
    { code: 'OVERLAP_UNEXPLAINED', divisionIds: ['crossing', 'near'] },
  ]);
});

test('recognizes the same antimeridian geometry independent of ring starting side', () => {
  const eastStart = {
    type: 'Polygon',
    coordinates: [[[179, 0], [-179, 0], [-179, 2], [179, 2], [179, 0]]],
  };
  const westStart = {
    type: 'Polygon',
    coordinates: [[[-179, 2], [179, 2], [179, 0], [-179, 0], [-179, 2]]],
  };
  const result = auditCountry(
    [feature('east', eastStart), feature('west', westStart)], config(),
    { indexIds: ['AA:overture:east', 'AA:overture:west'], compressedBytes: 0 },
  );
  assert.ok(codes(result).includes('DUPLICATE_GEOMETRY'));
});

test('fails duplicate geometry and unexplained positive-area overlap', () => {
  const duplicate = auditCountry(
    [feature('a'), feature('b')], config(),
    { indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 0 },
  );
  assert.ok(codes(duplicate).includes('DUPLICATE_GEOMETRY'));

  const overlap = auditCountry(
    [feature('a', polygon(0, 0, 2)), feature('b', polygon(1, 1, 2))], config(),
    { indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 0 },
  );
  assert.ok(codes(overlap).includes('OVERLAP_UNEXPLAINED'));
});

test('allows only an exact, explicit overlap exception and reports its ID', () => {
  const features = [feature('a', polygon(0, 0, 2)), feature('b', polygon(1, 1, 2))];
  const result = auditCountry(features, config(), {
    indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 0,
    exceptions: [{ id: 'legal-flyway-a-b', kind: 'overlap', divisionIds: ['a', 'b'] }],
  });
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.exceptions, ['legal-flyway-a-b']);

  const overbroad = auditCountry(features, config(), {
    indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 0,
    exceptions: [{ id: 'wrong-pair', kind: 'overlap', divisionIds: ['a', 'c'] }],
  });
  assert.ok(codes(overbroad).includes('OVERLAP_UNEXPLAINED'));

  const unsafeId = auditCountry(features, config(), {
    indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 0,
    exceptions: [{ id: 'overlap\nall', kind: 'overlap', divisionIds: ['a', 'b'] }],
  });
  assert.ok(codes(unsafeId).includes('EXCEPTION_INVALID'));
});

test('fails missing local names and count mismatches', () => {
  const result = auditCountry([feature('a', polygon(), { nameLocal: '' })], config(), {
    indexIds: ['AA:overture:a'], compressedBytes: 0,
  });
  assert.ok(codes(result).includes('LOCAL_NAME_MISSING'));
  assert.ok(codes(result).includes('COUNT_MISMATCH'));
});

test('warns above 5 MiB and fails above the 20 MiB hard package limit', () => {
  const features = [feature('a'), feature('b', polygon(2, 0))];
  const warning = auditCountry(features, config(), {
    indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 5 * MiB + 1,
  });
  assert.equal(warning.status, 'verified');
  assert.deepEqual(warning.metrics.warnings, ['PACKAGE_SIZE_P95_EXCEEDED']);

  const failure = auditCountry(features, config(), {
    indexIds: ['AA:overture:a', 'AA:overture:b'], compressedBytes: 20 * MiB + 1,
  });
  assert.ok(codes(failure).includes('PACKAGE_TOO_LARGE'));
});

test('rejects duplicate division IDs and unsafe vertex totals instead of overflowing counters', () => {
  const duplicate = auditCountry([feature('a'), feature('a', polygon(2, 0))], config(), {
    indexIds: ['AA:overture:a'], compressedBytes: 0,
  });
  assert.ok(codes(duplicate).includes('DIVISION_ID_DUPLICATE'));

  const unsafe = feature('large');
  unsafe.geometry.coordinates = new Proxy([], {
    get(target, property) {
      if (property === Symbol.iterator) throw new RangeError('synthetic overflow');
      return Reflect.get(target, property);
    },
  });
  assert.doesNotThrow(() => auditCountry([unsafe], config({ expectedCount: { kind: 'range', min: 0, max: 2 } }), {
    indexIds: ['AA:overture:large'], compressedBytes: 0,
  }));
});
