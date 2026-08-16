import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

describe('world map build CLI', () => {
  it('rejects unverified GeoJSON instead of attaching pinned Natural Earth provenance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'world-map-build-'));
    const inputPath = join(directory, 'unverified.geojson');
    const outputPath = join(directory, 'world-map.ts');
    writeFileSync(inputPath, JSON.stringify({ type: 'FeatureCollection', features: [] }));

    const result = spawnSync(process.execPath, ['scripts/build-world-map.mjs', inputPath, outputPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('生产构建仅接受固定 Natural Earth ZIP');
    expect(() => readFileSync(outputPath)).toThrow();
  });
});
