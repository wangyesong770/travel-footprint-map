import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { compareReleases } from './compare-releases.mjs';

const FROM = '2026-06-17.0';
const TO = '2026-09-16.0';
const HASH = 'a'.repeat(64);

async function fixture({
  fromIds = ['a'],
  toIds = fromIds,
  fromCount = fromIds.length,
  toCount = toIds.length,
  fromSelector = 'selector-1',
  toSelector = fromSelector,
  fromPerspective = 'reviewed',
  toPerspective = fromPerspective,
  migrations = [],
  mutateManifest,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'release-compare-'));
  const fromDir = path.join(root, 'from');
  const toDir = path.join(root, 'to');
  await Promise.all([mkdir(path.join(fromDir, 'countries'), { recursive: true }), mkdir(path.join(toDir, 'countries'), { recursive: true })]);
  const records = (ids, geometry = 'g1') => `${ids.map((divisionId) => JSON.stringify({ divisionId, geometryHash: `${geometry}-${divisionId}` })).join('\n')}\n`;
  await Promise.all([
    writeFile(path.join(fromDir, 'countries', 'AA.jsonl'), records(fromIds)),
    writeFile(path.join(toDir, 'countries', 'AA.jsonl'), records(toIds)),
    writeFile(path.join(fromDir, 'release.json'), JSON.stringify({
      release: FROM, schemaVersion: 'v1.17.0', countries: { AA: { selectedCount: fromCount, selectorSignature: fromSelector, perspective: fromPerspective } },
    })),
    writeFile(path.join(toDir, 'release.json'), JSON.stringify({
      release: TO, schemaVersion: 'v1.17.0', countries: { AA: { selectedCount: toCount, selectorSignature: toSelector, perspective: toPerspective } },
    })),
  ]);
  const manifest = (release) => ({ schemaVersion: 1, release, objects: [
    { key: 'theme=divisions/type=division/a.parquet', byteSize: 1, etag: 'e1', url: 'https://example.test/division', sha256: HASH },
    { key: 'theme=divisions/type=division_area/a.parquet', byteSize: 1, etag: 'e2', url: 'https://example.test/division_area', sha256: HASH },
  ] });
  const fromManifest = manifest(FROM);
  const toManifest = manifest(TO);
  mutateManifest?.({ fromManifest, toManifest });
  const fromManifestPath = path.join(root, 'from-manifest.json');
  const toManifestPath = path.join(root, 'to-manifest.json');
  const migrationsPath = path.join(root, 'migrations.json');
  const changeReportsDir = path.join(root, 'change-reports');
  await Promise.all([
    writeFile(fromManifestPath, JSON.stringify(fromManifest)),
    writeFile(toManifestPath, JSON.stringify(toManifest)),
    writeFile(migrationsPath, JSON.stringify({ schemaVersion: 1, migrations })),
  ]);
  return { root, fromDir, toDir, fromManifestPath, toManifestPath, migrationsPath, changeReportsDir };
}

async function compare(options) {
  return compareReleases({ fromRelease: FROM, toRelease: TO, ...(await fixture(options)) });
}

describe('quarterly release comparison', () => {
  test('keeps stable identity when only geometry changes', async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.toDir, 'countries', 'AA.jsonl'), `${JSON.stringify({ divisionId: 'a', geometryHash: 'new-shape' })}\n`);
    const result = await compareReleases({ fromRelease: FROM, toRelease: TO, ...paths });
    expect(result.state).toBe('no-review-required');
    expect(result.countries.AA.geometryChanged).toEqual(['a']);
    expect(result.countries.AA.deleted).toEqual([]);
  });

  test('allows a count increase of exactly two percent without manual review', async () => {
    const fromIds = Array.from({ length: 100 }, (_, index) => `id-${index}`);
    const result = await compare({ fromIds, toIds: [...fromIds, 'new-1', 'new-2'], fromCount: 100, toCount: 102 });
    expect(result.countries.AA.countDeltaPercent).toBe(2);
    expect(result.state).toBe('no-review-required');
  });

  test('requires manual review above the two percent threshold', async () => {
    const fromIds = Array.from({ length: 100 }, (_, index) => `id-${index}`);
    const result = await compare({ fromIds, toIds: [...fromIds, 'new-1', 'new-2', 'new-3'], fromCount: 100, toCount: 103 });
    expect(result.state).toBe('manual-review-required');
    expect(result.reasons).toContain('AA:COUNT_DELTA_ABOVE_THRESHOLD');
  });

  test('requires manual review for a deleted stable ID', async () => {
    const result = await compare({ fromIds: ['a', 'b'], toIds: ['b'], fromCount: 2, toCount: 1 });
    expect(result.state).toBe('manual-review-required');
    expect(result.reasons).toContain('AA:ID_DELETED');
  });

  test('validates a one-to-one replacement target in the candidate', async () => {
    const result = await compare({ fromIds: ['old'], toIds: ['new'], fromCount: 1, toCount: 1, migrations: [{
      fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-one', fromIds: ['old'], toIds: ['new'],
    }] });
    expect(result.state).toBe('manual-review-required');
    expect(result.migrations).toEqual({ manyToOne: 0, oneToMany: 0, oneToOne: 1 });
  });

  test('blocks a one-to-one replacement whose target is absent', async () => {
    const result = await compare({ fromIds: ['old'], toIds: ['different'], migrations: [{
      fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-one', fromIds: ['old'], toIds: ['missing'],
    }] });
    expect(result.state).toBe('blocked');
    expect(result.reasons).toContain('AA:MIGRATION_TARGET_MISSING');
  });

  test('accepts one-to-many only with confirmation and no automatic target', async () => {
    const valid = await compare({ fromIds: ['old'], toIds: ['left', 'right'], migrations: [{
      fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-many', fromIds: ['old'], toIds: ['left', 'right'], userConfirmationRequired: true,
    }] });
    expect(valid.state).toBe('manual-review-required');
    const invalid = await compare({ fromIds: ['old'], toIds: ['left', 'right'], migrations: [{
      fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-many', fromIds: ['old'], toIds: ['left', 'right'], userConfirmationRequired: true, automaticTarget: 'left',
    }] });
    expect(invalid.state).toBe('blocked');
    expect(invalid.reasons).toContain('AA:MIGRATION_SPLIT_AUTOMATIC_TARGET_FORBIDDEN');
    const missingConfirmation = await compare({ fromIds: ['old'], toIds: ['left', 'right'], migrations: [{
      fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-many', fromIds: ['old'], toIds: ['left', 'right'],
    }] });
    expect(missingConfirmation.state).toBe('blocked');
    expect(missingConfirmation.reasons).toContain('AA:MIGRATION_SPLIT_CONFIRMATION_REQUIRED');
  });

  test('validates a many-to-one merge target in the candidate', async () => {
    const result = await compare({ fromIds: ['old-a', 'old-b'], toIds: ['merged'], migrations: [{
      fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'many-to-one', fromIds: ['old-a', 'old-b'], toIds: ['merged'],
    }] });
    expect(result.state).toBe('manual-review-required');
    expect(result.migrations.manyToOne).toBe(1);
  });

  test('requires review when selector output definition changes', async () => {
    const result = await compare({ toSelector: 'selector-2' });
    expect(result.state).toBe('manual-review-required');
    expect(result.reasons).toContain('AA:SELECTOR_CHANGED');
  });

  test('requires review when political perspective changes', async () => {
    const result = await compare({ toPerspective: 'china-official' });
    expect(result.state).toBe('manual-review-required');
    expect(result.reasons).toContain('AA:PERSPECTIVE_CHANGED');
  });

  test('blocks mixed and incomplete source manifests', async () => {
    const mixed = await compare({ mutateManifest: ({ toManifest }) => { toManifest.release = FROM; } });
    expect(mixed.state).toBe('blocked');
    expect(mixed.reasons).toContain('GLOBAL:SOURCE_MANIFEST_RELEASE_MISMATCH');
    const incomplete = await compare({ mutateManifest: ({ toManifest }) => { toManifest.objects.pop(); } });
    expect(incomplete.state).toBe('blocked');
    expect(incomplete.reasons).toContain('GLOBAL:SOURCE_MANIFEST_INCOMPLETE');
  });

  test('blocks schema breaks and writes deterministic reports only', async () => {
    const paths = await fixture();
    const metadataPath = path.join(paths.toDir, 'release.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.schemaVersion = 'v2.0.0';
    await writeFile(metadataPath, JSON.stringify(metadata));
    const first = await compareReleases({ fromRelease: FROM, toRelease: TO, ...paths });
    const reportPath = path.join(paths.changeReportsDir, `${FROM}--${TO}.json`);
    const firstBytes = await readFile(reportPath, 'utf8');
    const second = await compareReleases({ fromRelease: FROM, toRelease: TO, ...paths });
    expect(second).toEqual(first);
    expect(await readFile(reportPath, 'utf8')).toBe(firstBytes);
    expect(first.state).toBe('blocked');
    expect(first.reasons).toContain('GLOBAL:SCHEMA_VERSION_CHANGED');
    expect((await readdir(paths.root)).sort()).not.toContain('release-ready.json');
    expect((await readdir(paths.toDir)).sort()).toEqual(['countries', 'release.json']);
  });

  test('blocks selected counts that do not match streamed identities', async () => {
    const result = await compare({ fromIds: ['a'], toIds: ['a', 'b'], fromCount: 1, toCount: 1 });
    expect(result.state).toBe('blocked');
    expect(result.reasons).toContain('AA:SELECTED_COUNT_MISMATCH');
  });

  test('derives the report name inside an explicit change report directory', async () => {
    const paths = await fixture();
    const changeReportsDir = path.join(paths.root, 'approved-change-reports');
    const result = await compareReleases({ fromRelease: FROM, toRelease: TO, ...paths, changeReportsDir });
    expect(result.state).toBe('no-review-required');
    expect(JSON.parse(await readFile(path.join(changeReportsDir, `${FROM}--${TO}.json`), 'utf8'))).toEqual(result);
  });

  test('rejects arbitrary output paths without changing existing target bytes', async () => {
    const paths = await fixture();
    const targets = [
      path.join(paths.root, 'public', 'data', 'countries', 'release-ready.json'),
      path.join(paths.root, 'public', 'data', 'countries', 'manifest.json'),
      path.join(paths.root, 'public', 'data', 'countries', 'report.json'),
      path.join(paths.root, 'outside-change-reports', 'report.json'),
    ];
    for (const target of targets) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'protected-production-bytes');
      await expect(compareReleases({ fromRelease: FROM, toRelease: TO, ...paths, outputPath: target })).rejects.toThrow(/outputPath is forbidden/);
      expect(await readFile(target, 'utf8')).toBe('protected-production-bytes');
    }
  });

  test('rejects the CLI --output escape hatch before touching its target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'release-compare-cli-'));
    const target = path.join(root, 'release-ready.json');
    await writeFile(target, 'protected-production-bytes');
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/audit/compare-releases.mjs'), '--from', FROM, '--to', TO, '--output', target,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported argument: --output');
    expect(await readFile(target, 'utf8')).toBe('protected-production-bytes');
  });

  test('rejects CLI change report directory overrides without writing into production packages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'release-compare-cli-root-'));
    const productionDir = path.join(root, 'public', 'data', 'countries');
    await mkdir(productionDir, { recursive: true });
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/audit/compare-releases.mjs'),
      '--from', FROM,
      '--to', TO,
      '--change-reports-dir', productionDir,
    ], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported argument: --change-reports-dir');
    expect(await readdir(productionDir)).toEqual([]);
  });

  test('blocks conflicting migrations that reuse one source ID', async () => {
    const result = await compare({ fromIds: ['old'], toIds: ['new-a', 'new-b'], migrations: [
      { fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-one', fromIds: ['old'], toIds: ['new-a'] },
      { fromRelease: FROM, toRelease: TO, sovereignCode: 'AA', type: 'one-to-one', fromIds: ['old'], toIds: ['new-b'] },
    ] });
    expect(result.state).toBe('blocked');
    expect(result.reasons).toContain('AA:MIGRATION_SOURCE_CONFLICT');
  });
});
