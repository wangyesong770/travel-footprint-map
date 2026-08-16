import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const GENERATED_PATH = join(process.cwd(), 'src/generated/cities.data.ts');
const ROWS_PREFIX = 'export const CITY_ROWS: CityRow[] = ';
const ROWS_SUFFIX = ';\n\nexport const CITIES:';

describe('full generated city data', () => {
  let source: string;
  let rows: unknown[][];

  beforeAll(async () => {
    source = await readFile(GENERATED_PATH, 'utf8');
    const start = source.indexOf(ROWS_PREFIX);
    const end = source.indexOf(ROWS_SUFFIX, start);
    if (start < 0 || end < 0) throw new Error('Generated CITY_ROWS payload was not found');
    rows = JSON.parse(source.slice(start + ROWS_PREFIX.length, end)) as unknown[][];
  });

  it('contains the declared complete city count with unique IDs', () => {
    expect(rows.length).toBeGreaterThan(200_000);
    expect(readNumberConstant(source, 'CITY_DATA_CITY_COUNT')).toBe(rows.length);
    expect(new Set(rows.map((row) => row[0])).size).toBe(rows.length);
  });

  it('covers all seven continent codes', () => {
    expect(new Set(rows.map((row) => row[5]))).toEqual(new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']));
  });

  it('has a checksum matching the deterministic compact payload', () => {
    const expected = readStringConstant(source, 'CITY_DATA_CHECKSUM');
    const actual = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    expect(actual).toBe(expected);
  });

  it('is safe to inline and stays below the decimal 25 MB gate', async () => {
    expect(source.toLowerCase()).not.toContain('</script>');
    expect((await stat(GENERATED_PATH)).size).toBeLessThan(25_000_000);
  });
});

function readNumberConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
  if (!match?.[1]) throw new Error(`Missing generated constant: ${name}`);
  return Number(match[1]);
}

function readStringConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`export const ${name} = ("(?:[^"\\\\]|\\\\.)*");`));
  if (!match?.[1]) throw new Error(`Missing generated constant: ${name}`);
  return JSON.parse(match[1]) as string;
}
