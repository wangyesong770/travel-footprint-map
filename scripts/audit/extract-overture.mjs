import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { runProcess } from './lib/process-runner.mjs';

const RELEASE_PATTERN = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.\d+$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const SQL_PATH = path.resolve(process.cwd(), 'scripts/audit/sql/extract-country.sql');

export function validateRelease(release) {
  const match = typeof release === 'string' ? release.match(RELEASE_PATTERN) : undefined;
  if (!match) throw new Error('invalid Overture release');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) throw new Error('invalid Overture release');
  return release;
}

function validateCountry(country, label = 'country code') {
  if (typeof country !== 'string' || !COUNTRY_PATTERN.test(country)) throw new Error(`invalid ${label}`);
  return country;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function renderSql({ release, sourceCountryCodes, outputPath }) {
  const template = await readFile(SQL_PATH, 'utf8');
  const baseUrl = `s3://overturemaps-us-west-2/release/${release}/theme=divisions`;
  return template
    .replace('__SOURCE_COUNTRY_CODES__', `[${sourceCountryCodes.map(sqlString).join(', ')}]`)
    .replace('__DIVISION_URL__', `${baseUrl}/type=division/*`)
    .replace('__DIVISION_AREA_URL__', `${baseUrl}/type=division_area/*`)
    .replace('__OUTPUT_PATH__', outputPath.replaceAll("'", "''"));
}

export async function extractCountry({ release, country, sourceCountryCodes = [country], outputDir, runner = runProcess, duckdbPath = 'duckdb' }) {
  validateRelease(release);
  validateCountry(country);
  if (!Array.isArray(sourceCountryCodes) || sourceCountryCodes.length === 0 || sourceCountryCodes.length > 32) {
    throw new Error('source country codes must be a non-empty bounded array');
  }
  const uniqueSourceCodes = [...new Set(sourceCountryCodes.map((code) => validateCountry(code, 'source country code')))];
  if (typeof outputDir !== 'string' || outputDir.length === 0 || outputDir.includes('\0')) throw new Error('invalid output directory');
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');

  let versionResult;
  try {
    versionResult = await runner(duckdbPath, ['-version'], { shell: false, maxOutputBytes: 16 * 1024 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('DuckDB CLI is required; install duckdb and ensure it is on PATH', { cause: error });
    throw error;
  }
  if (versionResult.exitCode !== 0 || typeof versionResult.stdout !== 'string' || versionResult.stdout.trim() === '') {
    throw new Error(`DuckDB preflight failed${versionResult.stderr ? `: ${versionResult.stderr.trim()}` : ''}`);
  }

  await mkdir(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, 'areas.geojsonseq');
  const temporaryPath = path.join(outputDir, `.areas.${randomUUID()}.partial`);
  try {
    const sql = await renderSql({ release, sourceCountryCodes: uniqueSourceCodes, outputPath: temporaryPath });
    const result = await runner(duckdbPath, [':memory:', '-no-stdin'], {
      shell: false,
      input: sql,
      maxOutputBytes: 64 * 1024,
      expectedOutputPath: temporaryPath,
    });
    if (result.exitCode !== 0) {
      const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new Error(`DuckDB extraction failed${detail ? `: ${detail}` : ''}`);
    }
    const outputStat = await stat(temporaryPath);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('DuckDB extraction produced an empty output');
    await rename(temporaryPath, finalPath);
    return {
      country,
      release,
      sourceCountryCodes: uniqueSourceCodes,
      outputPath: finalPath,
      byteSize: outputStat.size,
      duckdbVersion: versionResult.stdout.trim(),
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--release', '--country', '--output', '--source-codes'].includes(argv[index]) || argv[index + 1] === undefined) {
      throw new Error('usage: node scripts/audit/extract-overture.mjs --release <release> --country <ISO2> --output <dir> [--source-codes CN,HK]');
    }
    if (values.has(argv[index])) throw new Error(`duplicate argument: ${argv[index]}`);
    values.set(argv[index], argv[index + 1]);
  }
  if (!values.has('--release') || !values.has('--country') || !values.has('--output')) throw new Error('release, country, and output are required');
  return {
    release: values.get('--release'),
    country: values.get('--country'),
    outputDir: path.resolve(values.get('--output')),
    ...(values.has('--source-codes') ? { sourceCountryCodes: values.get('--source-codes').split(',') } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  extractCountry(parseCliArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Overture extraction failed'}\n`);
    process.exitCode = 1;
  });
}
