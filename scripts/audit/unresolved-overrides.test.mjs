import { describe, expect, it } from 'vitest';

import { validateUnresolvedOverrides } from './unresolved-overrides.mjs';

const reference = () => ({
  title: 'Official source',
  url: 'https://example.gov/evidence',
  retrievedOn: '2026-08-19',
  license: 'Public government information',
});

const metadata = Object.freeze({ rowCount: 2, byteSize: 17459, sha256: 'a'.repeat(64) });
const document = () => ({
  schemaVersion: 1,
  release: '2026-06-17.0',
  unresolved: { ...metadata },
  overrides: [
    {
      divisionId: '6ef6ba55-8e2d-4096-ac67-537311eee277',
      divisionAreaId: '281a46b3-bdca-427e-9a5a-743985484b7e',
      sovereignCode: 'CN',
      rationale: 'Exact reviewed feature.',
      officialReferences: [reference()],
    },
    {
      divisionId: '77cfc724-3d8c-4c48-8697-38c4582d7383',
      divisionAreaId: '3bd22b8a-9f15-4a9d-9f56-e5fa85da3f09',
      sovereignCode: 'CN',
      rationale: 'Exact reviewed feature.',
      officialReferences: [reference()],
    },
  ],
});

describe('unresolved source overrides', () => {
  it('reconstructs an exact immutable override set bound to snapshot evidence', () => {
    const result = validateUnresolvedOverrides(document(), '2026-06-17.0', metadata);

    expect(result.overrides.map(({ divisionId }) => divisionId)).toEqual([
      '6ef6ba55-8e2d-4096-ac67-537311eee277',
      '77cfc724-3d8c-4c48-8697-38c4582d7383',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.overrides[0]?.officialReferences[0])).toBe(true);
  });

  it('rejects missing, stale, duplicate, unbounded, or credential-bearing evidence', () => {
    const cases = [];
    const stale = document(); stale.unresolved.sha256 = 'b'.repeat(64); cases.push(stale);
    const missing = document(); missing.overrides.pop(); cases.push(missing);
    const duplicate = document(); duplicate.overrides[1].divisionId = duplicate.overrides[0].divisionId; cases.push(duplicate);
    const unknown = document(); unknown.overrides[0].owner = 'CN'; cases.push(unknown);
    const secret = document(); secret.overrides[0].officialReferences[0].url = 'https://example.gov/?access_token=secret'; cases.push(secret);
    const control = document(); control.overrides[0].rationale = 'bad\u0000text'; cases.push(control);

    for (const value of cases) {
      expect(() => validateUnresolvedOverrides(value, '2026-06-17.0', metadata)).toThrow(/UNRESOLVED_OVERRIDE_INVALID/);
    }
  });
});
