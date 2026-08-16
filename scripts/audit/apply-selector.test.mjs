import assert from 'node:assert/strict';
import { test } from 'vitest';

import { selectCountryFeatures } from './apply-selector.mjs';

const square = (west = 0, south = 0, size = 1) => ({
  type: 'Polygon',
  coordinates: [[
    [west, south], [west + size, south], [west + size, south + size],
    [west, south + size], [west, south],
  ]],
});

const row = (divisionId, overrides = {}) => ({
  divisionId,
  divisionAreaId: `area-${divisionId}`,
  sourceCountryCode: 'AA',
  subtype: 'locality',
  adminLevel: 6,
  localType: 'city',
  isLand: true,
  names: { primary: `Local ${divisionId}`, common: { zh: `城市${divisionId}` } },
  aliases: [],
  geometry: square(),
  ...overrides,
});

const config = (overrides = {}) => ({
  sovereignCode: 'AA',
  sourceCountryCodes: ['AA', 'AB'],
  productLevel: 'municipality',
  overtureSelector: {
    subtypes: ['locality'],
    adminLevels: [6],
    localTypeRules: [{ field: 'local_type', values: ['city'] }],
  },
  allowlist: [],
  denylist: [],
  ...overrides,
});

test('requires subtype, admin level, and every local-type rule as one conjunction', () => {
  const selected = selectCountryFeatures([
    row('included'),
    row('wrong-subtype', { subtype: 'region' }),
    row('wrong-level', { adminLevel: 7 }),
    row('wrong-local-type', { localType: 'town' }),
    row('missing-local-key', { localType: undefined }),
  ], config());

  assert.deepEqual(selected.map(({ divisionId }) => divisionId), ['included']);
  assert.equal(selected[0].productLevel, 'municipality');
});

test('merges registered source country codes without rewriting stable division identity', () => {
  const selected = selectCountryFeatures([
    row('from-aa'),
    row('from-ab', { sourceCountryCode: 'AB' }),
    row('foreign', { sourceCountryCode: 'ZZ' }),
  ], config());

  assert.deepEqual(selected.map(({ divisionId }) => divisionId), ['from-aa', 'from-ab']);
  assert.equal(selected[1].sourceCountryCode, 'AB');
});

test('applies allowlist after selector and denylist last', () => {
  const selected = selectCountryFeatures([
    row('allow-me', { subtype: 'region' }),
    row('deny-me'),
    row('both', { subtype: 'region' }),
  ], config({ allowlist: ['allow-me', 'both'], denylist: ['deny-me', 'both'] }));

  assert.deepEqual(selected.map(({ divisionId }) => divisionId), ['allow-me']);
});

test('never lets allowlist bypass source ownership or land-only constraints', () => {
  const selected = selectCountryFeatures([
    row('foreign', { sourceCountryCode: 'ZZ', subtype: 'region' }),
    row('water', { isLand: false, subtype: 'region' }),
  ], config({ allowlist: ['foreign', 'water'] }));

  assert.deepEqual(selected, []);
});

test('rejects duplicate division IDs before filtering and returns deterministic stable order', () => {
  assert.throws(
    () => selectCountryFeatures([row('same'), row('same', { subtype: 'region' })], config()),
    /duplicate divisionId: same/,
  );

  const selected = selectCountryFeatures([row('z'), row('a'), row('m')], config());
  assert.deepEqual(selected.map(({ divisionId }) => divisionId), ['a', 'm', 'z']);
});
