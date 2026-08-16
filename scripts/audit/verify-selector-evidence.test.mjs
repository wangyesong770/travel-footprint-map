import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

import { verifySelectorEvidence } from './verify-selector-evidence.mjs';

const reference = (overrides = {}) => ({
  id: 'official-register',
  publisher: 'Example National Statistics Office',
  title: 'Official municipality register',
  url: 'https://statistics.example.gov/register/municipalities.csv',
  capturedOn: '2026-08-16',
  effectiveOn: '2026-06-01',
  license: 'Open Government Licence 1.0',
  machineReadable: true,
  ...overrides,
});

const sample = (category, divisionId, expectedInclusion, overrides = {}) => ({
  category,
  institutionalCategory: category === 'capital' ? 'capital municipality' : 'ordinary municipality',
  divisionId,
  expectedInclusion,
  referenceIds: ['official-register'],
  ...overrides,
});

const completeFixture = () => ({
  selector: {
    schemaVersion: 1,
    release: '2026-06-17.0',
    sovereignCode: 'AA',
    status: 'draft',
    productLevel: 'municipality',
    overtureSelector: {
      subtypes: ['locality'],
      adminLevels: [7],
      localTypeRules: [{ field: 'local_type', values: ['city', 'town', 'village'] }],
    },
    expectedCount: { kind: 'exact', value: 5, referenceIds: ['official-register'] },
    officialReferences: [reference()],
    allowlist: ['division-allowed'],
    denylist: ['division-denied'],
    sampleApplicability: {
      border: { applicable: false, reason: 'No land border.' },
      coastal: { applicable: true, reason: 'The country has a coastline.' },
      specialCaseCategories: ['capital district'],
    },
    samples: [
      sample('capital', 'division-capital', true),
      sample('ordinary', 'division-ordinary', true),
      sample('small-rural', 'division-rural', true),
      sample('coastal', 'division-coastal', true),
      sample('special-case', 'division-capital', true, { institutionalCategory: 'capital district' }),
      sample('excluded-control', 'division-denied', false, { institutionalCategory: 'excluded historic unit' }),
    ],
  },
  exceptions: {
    schemaVersion: 1,
    release: '2026-06-17.0',
    sovereignCode: 'AA',
    status: 'draft',
    exceptions: [
      {
        divisionId: 'division-allowed', action: 'allow',
        institutionalCategory: 'capital district',
        reason: 'Officially municipality-equivalent despite divergent source fields.',
        referenceIds: ['official-register'],
      },
      {
        divisionId: 'division-denied', action: 'deny',
        institutionalCategory: 'historic unit',
        reason: 'The official register marks it dissolved before the effective date.',
        referenceIds: ['official-register'],
      },
    ],
    overlapExceptions: [],
  },
  finalDivisionIds: ['division-allowed', 'division-capital', 'division-coastal', 'division-ordinary', 'division-rural'],
});

const failureCodes = (fixture) => verifySelectorEvidence(fixture).failures.map(({ code }) => code);

test('fails when an official reference cited by evidence is absent', () => {
  const fixture = completeFixture();
  fixture.selector.officialReferences = [];

  assert.equal(verifySelectorEvidence(fixture).status, 'failed');
  assert.ok(failureCodes(fixture).includes('OFFICIAL_REFERENCE_REQUIRED'));
  assert.ok(failureCodes(fixture).includes('REFERENCE_ID_UNKNOWN'));
});

test('fails invalid and non-direct official reference metadata without fetching it', () => {
  const fixture = completeFixture();
  fixture.selector.officialReferences = [reference({
    publisher: '',
    url: 'https://search.example.gov/?q=municipalities#result',
    capturedOn: '16/08/2026',
    effectiveOn: '',
    license: '',
    machineReadable: 'yes',
  })];

  assert.ok(failureCodes(fixture).includes('REFERENCE_METADATA_INVALID'));
  assert.ok(failureCodes(fixture).includes('REFERENCE_URL_NOT_DIRECT'));
});

test('fails a selector with no positive raw Overture predicate', () => {
  const fixture = completeFixture();
  fixture.selector.overtureSelector = { subtypes: [], adminLevels: [], localTypeRules: [] };

  assert.ok(failureCodes(fixture).includes('POSITIVE_PREDICATE_REQUIRED'));
});

test('fails allowlist and denylist IDs without matching documented exceptions', () => {
  const fixture = completeFixture();
  fixture.exceptions.exceptions = [];

  assert.ok(failureCodes(fixture).includes('ALLOWLIST_UNDOCUMENTED'));
  assert.ok(failureCodes(fixture).includes('DENYLIST_UNDOCUMENTED'));
});

test('fails when an included sample is absent from the final selector result', () => {
  const fixture = completeFixture();
  fixture.finalDivisionIds = fixture.finalDivisionIds.filter((id) => id !== 'division-rural');

  assert.ok(failureCodes(fixture).includes('SAMPLE_RESULT_MISMATCH'));
});

test('fails when a sample omits its institutional category', () => {
  const fixture = completeFixture();
  delete fixture.selector.samples[0].institutionalCategory;

  assert.ok(failureCodes(fixture).includes('SAMPLE_INSTITUTIONAL_CATEGORY_REQUIRED'));
});

test('fails when required or applicable sample classes are absent', () => {
  const fixture = completeFixture();
  fixture.selector.samples = fixture.selector.samples.filter(({ category }) => category !== 'small-rural' && category !== 'coastal');

  const codes = failureCodes(fixture);
  assert.ok(codes.includes('REQUIRED_SAMPLE_MISSING'));
  assert.ok(codes.includes('APPLICABLE_SAMPLE_MISSING'));
});

test('fails an unexplained expected-count mismatch', () => {
  const fixture = completeFixture();
  fixture.selector.expectedCount.value = 6;

  assert.ok(failureCodes(fixture).includes('EXPECTED_COUNT_MISMATCH'));
});

test('fails exception records with unknown references or inconsistent list action', () => {
  const fixture = completeFixture();
  fixture.exceptions.exceptions[0].referenceIds = ['missing-reference'];
  fixture.exceptions.exceptions[1].action = 'allow';

  const codes = failureCodes(fixture);
  assert.ok(codes.includes('REFERENCE_ID_UNKNOWN'));
  assert.ok(codes.includes('EXCEPTION_LIST_MISMATCH'));
});

test('passes a complete draft fixture without promoting it to production verified', () => {
  const fixture = completeFixture();
  const result = verifySelectorEvidence(fixture);

  assert.deepEqual(result, {
    status: 'passed',
    sovereignCode: 'AA',
    release: '2026-06-17.0',
    metrics: { finalCount: 5, referenceCount: 1, sampleCount: 6, exceptionCount: 2, overlapExceptionCount: 0 },
    failures: [],
  });
  assert.equal(fixture.selector.status, 'draft');
  assert.equal(fixture.exceptions.status, 'draft');
});

test('revalidates the same evidence after explicit human status promotion', () => {
  const fixture = completeFixture();
  fixture.selector.status = 'verified';
  fixture.exceptions.status = 'verified';

  assert.equal(verifySelectorEvidence(fixture, { requiredStatus: 'verified' }).status, 'passed');
  assert.ok(failureCodes(fixture).includes('DOCUMENT_METADATA_INVALID'));
});

test('accepts a referenced overlap exception and rejects an unreferenced or duplicate pair', () => {
  const fixture = completeFixture();
  fixture.exceptions.overlapExceptions = [{
    id: 'capital-border-overlap',
    kind: 'overlap',
    divisionIds: ['division-capital', 'division-ordinary'],
    reason: 'The official register defines a shared administrative surface.',
    referenceIds: ['official-register'],
  }];

  const passed = verifySelectorEvidence(fixture);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.metrics.overlapExceptionCount, 1);

  fixture.exceptions.overlapExceptions.push({
    ...fixture.exceptions.overlapExceptions[0],
    id: 'duplicate-pair',
    referenceIds: ['missing-reference'],
  });
  const codes = failureCodes(fixture);
  assert.ok(codes.includes('OVERLAP_EXCEPTION_DUPLICATE'));
  assert.ok(codes.includes('REFERENCE_ID_UNKNOWN'));
});

test('accepts at least 35,000 unique final division IDs with an exact count', () => {
  const fixture = completeFixture();
  const requiredIds = [...fixture.finalDivisionIds];
  fixture.finalDivisionIds = [
    ...requiredIds,
    ...Array.from({ length: 35_000 - requiredIds.length }, (_, index) => `division-generated-${index}`),
  ];
  fixture.selector.expectedCount.value = 35_000;

  assert.equal(verifySelectorEvidence(fixture).status, 'passed');
  assert.equal(verifySelectorEvidence(fixture).metrics.finalCount, 35_000);
});

test('requires capital, ordinary, and small-rural samples to bind distinct division IDs', () => {
  const fixture = completeFixture();
  fixture.selector.samples.find(({ category }) => category === 'small-rural').divisionId = 'division-ordinary';

  assert.ok(failureCodes(fixture).includes('CORE_SAMPLE_IDS_NOT_DISTINCT'));
});

test.each([
  'https://user:password@statistics.example.gov/register/municipalities.csv',
  'https://statistics.example.gov/register/municipalities.csv?token=sensitive',
  'https://statistics.example.gov/register/municipalities.csv?apiKey=sensitive',
  'https://statistics.example.gov/register/municipalities.csv?credential=sensitive',
  'https://statistics.example.gov/register/municipalities.csv#secret',
])('rejects reference URLs containing credentials: %s', (url) => {
  const fixture = completeFixture();
  fixture.selector.officialReferences[0].url = url;

  assert.ok(failureCodes(fixture).includes('REFERENCE_URL_NOT_DIRECT'));
});

test('rejects unknown keys at every evidence object boundary with stable subjects', () => {
  const fixture = completeFixture();
  fixture.unexpected = true;
  fixture.selector.unexpected = true;
  fixture.selector.overtureSelector.unexpected = true;
  fixture.selector.overtureSelector.localTypeRules[0].unexpected = true;
  fixture.selector.expectedCount.unexpected = true;
  fixture.selector.officialReferences[0].unexpected = true;
  fixture.selector.sampleApplicability.unexpected = true;
  fixture.selector.sampleApplicability.border.unexpected = true;
  fixture.selector.samples[0].unexpected = true;
  fixture.exceptions.unexpected = true;
  fixture.exceptions.exceptions[0].unexpected = true;

  assert.deepEqual(
    verifySelectorEvidence(fixture).failures
      .filter(({ code }) => code === 'UNKNOWN_FIELD')
      .map(({ subject }) => subject),
    [
      'exceptions.exceptions[0].unexpected',
      'exceptions.unexpected',
      'input.unexpected',
      'selector.expectedCount.unexpected',
      'selector.officialReferences[0].unexpected',
      'selector.overtureSelector.localTypeRules[0].unexpected',
      'selector.overtureSelector.unexpected',
      'selector.sampleApplicability.border.unexpected',
      'selector.sampleApplicability.unexpected',
      'selector.samples[0].unexpected',
      'selector.unexpected',
    ],
  );
});

test('rejects duplicate exception division ID and action pairs', () => {
  const fixture = completeFixture();
  fixture.exceptions.exceptions.push({ ...fixture.exceptions.exceptions[0] });

  assert.ok(failureCodes(fixture).includes('EXCEPTION_DUPLICATE'));
});

const CLI_PATH = path.resolve('scripts/audit/verify-selector-evidence.mjs');

async function cliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'selector-evidence-cli-'));
  const fixture = completeFixture();
  const auditRoot = path.join(root, 'data-audit');
  const workDirectory = path.join(auditRoot, 'work', fixture.selector.release, fixture.selector.sovereignCode);
  await Promise.all([
    mkdir(path.join(auditRoot, 'selectors'), { recursive: true }),
    mkdir(path.join(auditRoot, 'exceptions'), { recursive: true }),
    mkdir(workDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(auditRoot, 'sovereign-registry.json'), JSON.stringify({
      release: fixture.selector.release,
      countries: [{ sovereignCode: fixture.selector.sovereignCode }],
    })),
    writeFile(path.join(auditRoot, 'selectors', 'AA.json'), JSON.stringify(fixture.selector)),
    writeFile(path.join(auditRoot, 'exceptions', 'AA.json'), JSON.stringify(fixture.exceptions)),
    writeFile(path.join(workDirectory, 'final-division-ids.json'), JSON.stringify({
      schemaVersion: 1,
      release: fixture.selector.release,
      sovereignCode: fixture.selector.sovereignCode,
      divisionIds: fixture.finalDivisionIds,
    })),
  ]);
  return { root, fixture, auditRoot, workDirectory };
}

function runCli(root, extraArgs = []) {
  return spawnSync(process.execPath, [
    CLI_PATH, '--country', 'AA', '--release', '2026-06-17.0', ...extraArgs,
  ], { cwd: root, encoding: 'utf8' });
}

test('CLI loads fixed evidence paths and emits stable JSON with exit zero', async () => {
  const fixture = await cliFixture();
  try {
    const result = runCli(fixture.root);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), verifySelectorEvidence(completeFixture()));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI emits failed evidence JSON and exit one', async () => {
  const fixture = await cliFixture();
  try {
    fixture.fixture.finalDivisionIds.pop();
    await writeFile(path.join(fixture.workDirectory, 'final-division-ids.json'), JSON.stringify({
      schemaVersion: 1,
      release: fixture.fixture.selector.release,
      sovereignCode: 'AA',
      divisionIds: fixture.fixture.finalDivisionIds,
    }));
    const result = runCli(fixture.root);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    assert.ok(JSON.parse(result.stdout).failures.some(({ code }) => code === 'EXPECTED_COUNT_MISMATCH'));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI rejects oversized JSON before parsing', async () => {
  const fixture = await cliFixture();
  try {
    await writeFile(path.join(fixture.auditRoot, 'selectors', 'AA.json'), ' '.repeat((1024 * 1024) + 1));
    const result = runCli(fixture.root);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'failed', failures: [{ code: 'INPUT_TOO_LARGE', subject: 'selector' }] });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI reports missing, BOM-prefixed, and malformed JSON without leaking absolute paths', async () => {
  const fixture = await cliFixture();
  try {
    await rm(path.join(fixture.auditRoot, 'exceptions', 'AA.json'));
    const missing = runCli(fixture.root);
    assert.deepEqual(JSON.parse(missing.stdout), { status: 'failed', failures: [{ code: 'INPUT_MISSING', subject: 'exceptions' }] });
    assert.equal(`${missing.stdout}${missing.stderr}`.includes(fixture.root), false);

    await writeFile(path.join(fixture.auditRoot, 'exceptions', 'AA.json'), `\ufeff${JSON.stringify(fixture.fixture.exceptions)}`);
    const bom = runCli(fixture.root);
    assert.deepEqual(JSON.parse(bom.stdout), { status: 'failed', failures: [{ code: 'JSON_BOM_FORBIDDEN', subject: 'exceptions' }] });
    assert.equal(`${bom.stdout}${bom.stderr}`.includes(fixture.root), false);

    await writeFile(path.join(fixture.auditRoot, 'exceptions', 'AA.json'), '{"invalid":');
    const malformed = runCli(fixture.root);
    assert.deepEqual(JSON.parse(malformed.stdout), { status: 'failed', failures: [{ code: 'JSON_INVALID', subject: 'exceptions' }] });
    assert.equal(`${malformed.stdout}${malformed.stderr}`.includes(fixture.root), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI rejects path traversal and unknown arguments before reading attacker paths', async () => {
  const fixture = await cliFixture();
  try {
    const traversal = runCli(fixture.root, ['--result-ids', '../../secret.json']);
    assert.equal(traversal.status, 1);
    assert.deepEqual(JSON.parse(traversal.stdout), { status: 'failed', failures: [{ code: 'ARGUMENT_UNSUPPORTED', subject: 'argument' }] });
    const unknown = runCli(fixture.root, ['--output', 'public/data/countries/release-ready.json']);
    assert.equal(unknown.status, 1);
    assert.deepEqual(JSON.parse(unknown.stdout), { status: 'failed', failures: [{ code: 'ARGUMENT_UNSUPPORTED', subject: 'argument' }] });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('package exposes the audited selector CLI command', async () => {
  const packageDocument = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));

  assert.equal(packageDocument.scripts?.['audit:selector'], 'node scripts/audit/verify-selector-evidence.mjs');
});

test('CLI always reads the canonical final division IDs path', async () => {
  const fixture = await cliFixture();
  try {
    const alternate = path.join(fixture.workDirectory, 'alternate.json');
    await writeFile(alternate, JSON.stringify({
      schemaVersion: 1,
      release: fixture.fixture.selector.release,
      sovereignCode: fixture.fixture.selector.sovereignCode,
      divisionIds: fixture.fixture.finalDivisionIds,
    }));

    const result = runCli(fixture.root, [
      '--result-ids',
      path.relative(fixture.root, alternate),
    ]);

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'failed',
      failures: [{ code: 'ARGUMENT_UNSUPPORTED', subject: 'argument' }],
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI does not echo unsupported arguments that may contain secrets', async () => {
  const fixture = await cliFixture();
  try {
    const result = runCli(fixture.root, ['--token=do-not-print', 'ignored']);

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'failed',
      failures: [{ code: 'ARGUMENT_UNSUPPORTED', subject: 'argument' }],
    });
    assert.equal(`${result.stdout}${result.stderr}`.includes('do-not-print'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI refuses a symlink in place of a canonical evidence input', async () => {
  const fixture = await cliFixture();
  try {
    const resultIdsPath = path.join(fixture.workDirectory, 'final-division-ids.json');
    const outsidePath = path.join(fixture.root, 'outside-result.json');
    await writeFile(outsidePath, JSON.stringify({
      schemaVersion: 1,
      release: fixture.fixture.selector.release,
      sovereignCode: fixture.fixture.selector.sovereignCode,
      divisionIds: fixture.fixture.finalDivisionIds,
    }));
    await rm(resultIdsPath);
    await symlink(outsidePath, resultIdsPath);

    const result = runCli(fixture.root);

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'failed',
      failures: [{ code: 'INPUT_UNREADABLE', subject: 'result-ids' }],
    });
    assert.equal(`${result.stdout}${result.stderr}`.includes(fixture.root), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI refuses a symlinked parent directory for canonical evidence', async () => {
  const fixture = await cliFixture();
  try {
    const outsideDirectory = path.join(fixture.root, 'outside-work');
    const resultIds = {
      schemaVersion: 1,
      release: fixture.fixture.selector.release,
      sovereignCode: fixture.fixture.selector.sovereignCode,
      divisionIds: fixture.fixture.finalDivisionIds,
    };
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, 'final-division-ids.json'), JSON.stringify(resultIds));
    await rm(fixture.workDirectory, { recursive: true });
    await symlink(outsideDirectory, fixture.workDirectory, 'dir');

    const result = runCli(fixture.root);

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'failed',
      failures: [{ code: 'INPUT_UNREADABLE', subject: 'result-ids' }],
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI rejects countries outside the registry and non-fixed releases', async () => {
  const fixture = await cliFixture();
  try {
    const country = spawnSync(process.execPath, [CLI_PATH, '--country', 'ZZ', '--release', '2026-06-17.0'], { cwd: fixture.root, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(country.stdout), { status: 'failed', failures: [{ code: 'COUNTRY_NOT_REGISTERED', subject: 'ZZ' }] });
    const release = spawnSync(process.execPath, [CLI_PATH, '--country', 'AA', '--release', '2026-06-18.0'], { cwd: fixture.root, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(release.stdout), { status: 'failed', failures: [{ code: 'RELEASE_MISMATCH', subject: '2026-06-18.0' }] });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
