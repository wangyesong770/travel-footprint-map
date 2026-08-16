import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { pathToFileURL } from 'node:url';

const CORE_SAMPLE_CATEGORIES = ['capital', 'ordinary', 'small-rural'];
const MAX_EVIDENCE_ITEMS = 10_000;
const MAX_FINAL_DIVISION_IDS = 250_000;
const FIXED_RELEASE = '2026-06-17.0';
const JSON_LIMITS = {
  registry: 4 * 1024 * 1024,
  selector: 1024 * 1024,
  exceptions: 1024 * 1024,
  resultIds: 128 * 1024 * 1024,
};

export function verifySelectorEvidence(input, options = {}) {
  const requiredStatus = options.requiredStatus ?? 'draft';
  if (requiredStatus !== 'draft' && requiredStatus !== 'verified') {
    throw new TypeError('requiredStatus must be draft or verified');
  }
  const failures = [];
  validateKnownFields(input, ['selector', 'exceptions', 'finalDivisionIds'], 'input', failures);
  const selector = object(input?.selector);
  const exceptionsDocument = object(input?.exceptions);
  validateEvidenceFields(selector, exceptionsDocument, failures);
  const finalDivisionIds = uniqueIds(
    input?.finalDivisionIds,
    'FINAL_DIVISION_IDS_INVALID',
    failures,
    MAX_FINAL_DIVISION_IDS,
  );
  const finalIds = new Set(finalDivisionIds);

  validateDocumentIdentity(selector, exceptionsDocument, requiredStatus, failures);
  validatePredicate(selector?.overtureSelector, failures);

  const references = validateReferences(selector?.officialReferences, failures);
  const referenceIds = new Set(references.map(({ id }) => id));
  const allowlist = uniqueIds(selector?.allowlist, 'ALLOWLIST_INVALID', failures);
  const denylist = uniqueIds(selector?.denylist, 'DENYLIST_INVALID', failures);
  if (allowlist.some((id) => denylist.includes(id))) addFailure(failures, 'ALLOW_DENY_CONFLICT');

  validateExpectedCount(selector?.expectedCount, finalDivisionIds.length, referenceIds, failures);
  const samples = validateSamples(selector?.samples, selector?.sampleApplicability, finalIds, referenceIds, failures);
  const exceptions = validateExceptions(exceptionsDocument?.exceptions, allowlist, denylist, referenceIds, failures);
  const overlapExceptions = validateOverlapExceptions(
    exceptionsDocument?.overlapExceptions,
    finalIds,
    referenceIds,
    failures,
  );

  failures.sort(compareFailures);
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    sovereignCode: validCountryCode(selector?.sovereignCode) ? selector.sovereignCode : undefined,
    release: validRelease(selector?.release) ? selector.release : undefined,
    metrics: {
      finalCount: finalDivisionIds.length,
      referenceCount: references.length,
      sampleCount: samples.length,
      exceptionCount: exceptions.length,
      overlapExceptionCount: overlapExceptions.length,
    },
    failures,
  };
}

function validateDocumentIdentity(selector, exceptions, requiredStatus, failures) {
  if (selector === undefined || exceptions === undefined) {
    addFailure(failures, 'DOCUMENT_INVALID');
    return;
  }
  if (selector.schemaVersion !== 1 || exceptions.schemaVersion !== 1
    || !validCountryCode(selector.sovereignCode)
    || selector.sovereignCode !== exceptions.sovereignCode
    || !validRelease(selector.release)
    || selector.release !== exceptions.release
    || selector.status !== requiredStatus || exceptions.status !== requiredStatus
    || !plainText(selector.productLevel)) addFailure(failures, 'DOCUMENT_METADATA_INVALID');
}

function validatePredicate(rawSelector, failures) {
  const selector = object(rawSelector);
  if (selector === undefined) {
    addFailure(failures, 'POSITIVE_PREDICATE_REQUIRED');
    return;
  }
  const subtypes = stringArray(selector.subtypes);
  const adminLevels = Array.isArray(selector.adminLevels)
    ? selector.adminLevels.filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= 100)
    : [];
  const localTypeRules = Array.isArray(selector.localTypeRules)
    ? selector.localTypeRules.filter((rule) => rule?.field === 'local_type' && stringArray(rule.values).length > 0)
    : [];
  if (subtypes.length === 0 && adminLevels.length === 0 && localTypeRules.length === 0) {
    addFailure(failures, 'POSITIVE_PREDICATE_REQUIRED');
  }
  if (!Array.isArray(selector.subtypes) || subtypes.length !== selector.subtypes.length
    || !Array.isArray(selector.adminLevels) || adminLevels.length !== selector.adminLevels.length
    || !Array.isArray(selector.localTypeRules) || localTypeRules.length !== selector.localTypeRules.length) {
    addFailure(failures, 'PREDICATE_INVALID');
  }
}

function validateReferences(rawReferences, failures) {
  if (!Array.isArray(rawReferences) || rawReferences.length === 0 || rawReferences.length > 32) {
    addFailure(failures, 'OFFICIAL_REFERENCE_REQUIRED');
    return [];
  }
  const references = [];
  const ids = new Set();
  for (const raw of rawReferences) {
    const reference = object(raw);
    if (!directHttpsUrl(reference?.url)) addFailure(failures, 'REFERENCE_URL_NOT_DIRECT', reference?.id);
    if (reference === undefined || !auditId(reference.id) || ids.has(reference.id)
      || !plainText(reference.publisher) || !plainText(reference.title)
      || !date(reference.capturedOn) || !date(reference.effectiveOn)
      || !plainText(reference.license) || typeof reference.machineReadable !== 'boolean') {
      addFailure(failures, 'REFERENCE_METADATA_INVALID', reference?.id);
      continue;
    }
    ids.add(reference.id);
    references.push(reference);
  }
  return references;
}

function validateExpectedCount(expectation, actual, referenceIds, failures) {
  const value = object(expectation);
  if (value === undefined) {
    addFailure(failures, 'EXPECTED_COUNT_INVALID');
    return;
  }
  validateReferenceIds(value.referenceIds, referenceIds, failures, 'expectedCount');
  if (value.kind === 'exact' && Number.isSafeInteger(value.value) && value.value >= 0) {
    if (actual !== value.value) addFailure(failures, 'EXPECTED_COUNT_MISMATCH');
    return;
  }
  if (value.kind === 'range' && Number.isSafeInteger(value.minimum) && Number.isSafeInteger(value.maximum)
    && value.minimum >= 0 && value.maximum >= value.minimum) {
    if (actual < value.minimum || actual > value.maximum) addFailure(failures, 'EXPECTED_COUNT_MISMATCH');
    return;
  }
  addFailure(failures, 'EXPECTED_COUNT_INVALID');
}

function validateSamples(rawSamples, rawApplicability, finalIds, referenceIds, failures) {
  if (!Array.isArray(rawSamples) || rawSamples.length === 0 || rawSamples.length > MAX_EVIDENCE_ITEMS) {
    addFailure(failures, 'REQUIRED_SAMPLE_MISSING');
    return [];
  }
  const samples = [];
  const sampleCategories = new Set();
  for (const raw of rawSamples) {
    const sample = object(raw);
    if (sample === undefined || !plainText(sample.category) || !auditId(sample.divisionId)
      || typeof sample.expectedInclusion !== 'boolean') {
      addFailure(failures, 'SAMPLE_INVALID');
      continue;
    }
    if (!plainText(sample.institutionalCategory)) {
      addFailure(failures, 'SAMPLE_INSTITUTIONAL_CATEGORY_REQUIRED', sample.divisionId);
    }
    validateReferenceIds(sample.referenceIds, referenceIds, failures, sample.divisionId);
    if (finalIds.has(sample.divisionId) !== sample.expectedInclusion) {
      addFailure(failures, 'SAMPLE_RESULT_MISMATCH', sample.divisionId);
    }
    sampleCategories.add(sample.category);
    samples.push(sample);
  }
  for (const category of CORE_SAMPLE_CATEGORIES) {
    if (!sampleCategories.has(category)) addFailure(failures, 'REQUIRED_SAMPLE_MISSING', category);
  }
  const coreOwners = new Map();
  for (const sample of samples.filter(({ category }) => CORE_SAMPLE_CATEGORIES.includes(category))) {
    const previousCategory = coreOwners.get(sample.divisionId);
    if (previousCategory !== undefined && previousCategory !== sample.category) {
      addFailure(failures, 'CORE_SAMPLE_IDS_NOT_DISTINCT', sample.divisionId);
    } else {
      coreOwners.set(sample.divisionId, sample.category);
    }
  }

  const applicability = object(rawApplicability);
  for (const category of ['border', 'coastal']) {
    const decision = object(applicability?.[category]);
    if (decision === undefined || typeof decision.applicable !== 'boolean' || !plainText(decision.reason)) {
      addFailure(failures, 'SAMPLE_APPLICABILITY_INVALID', category);
    } else if (decision.applicable && !sampleCategories.has(category)) {
      addFailure(failures, 'APPLICABLE_SAMPLE_MISSING', category);
    }
  }
  const specialCategories = stringArray(applicability?.specialCaseCategories);
  if (!Array.isArray(applicability?.specialCaseCategories)
    || specialCategories.length !== applicability.specialCaseCategories.length) {
    addFailure(failures, 'SAMPLE_APPLICABILITY_INVALID', 'special-case');
  }
  for (const category of specialCategories) {
    if (!samples.some((sample) => sample.category === 'special-case' && sample.institutionalCategory === category)) {
      addFailure(failures, 'APPLICABLE_SAMPLE_MISSING', category);
    }
  }
  return samples;
}

function validateExceptions(rawExceptions, allowlist, denylist, referenceIds, failures) {
  if (!Array.isArray(rawExceptions) || rawExceptions.length > MAX_EVIDENCE_ITEMS) {
    addFailure(failures, 'EXCEPTIONS_INVALID');
    return [];
  }
  const exceptions = [];
  const documented = { allow: new Set(), deny: new Set() };
  const seen = new Set();
  for (const raw of rawExceptions) {
    const exception = object(raw);
    if (exception === undefined || !auditId(exception.divisionId)
      || (exception.action !== 'allow' && exception.action !== 'deny')
      || !plainText(exception.reason) || !plainText(exception.institutionalCategory)) {
      addFailure(failures, 'EXCEPTION_INVALID', exception?.divisionId);
      continue;
    }
    const identity = `${exception.action}:${exception.divisionId}`;
    if (seen.has(identity)) addFailure(failures, 'EXCEPTION_DUPLICATE', exception.divisionId);
    seen.add(identity);
    validateReferenceIds(exception.referenceIds, referenceIds, failures, exception.divisionId);
    const expectedList = exception.action === 'allow' ? allowlist : denylist;
    if (!expectedList.includes(exception.divisionId)) addFailure(failures, 'EXCEPTION_LIST_MISMATCH', exception.divisionId);
    documented[exception.action].add(exception.divisionId);
    exceptions.push(exception);
  }
  for (const divisionId of allowlist) {
    if (!documented.allow.has(divisionId)) addFailure(failures, 'ALLOWLIST_UNDOCUMENTED', divisionId);
  }
  for (const divisionId of denylist) {
    if (!documented.deny.has(divisionId)) addFailure(failures, 'DENYLIST_UNDOCUMENTED', divisionId);
  }
  return exceptions;
}

function validateOverlapExceptions(rawExceptions, finalIds, referenceIds, failures) {
  if (!Array.isArray(rawExceptions) || rawExceptions.length > MAX_EVIDENCE_ITEMS) {
    addFailure(failures, 'OVERLAP_EXCEPTIONS_INVALID');
    return [];
  }
  const result = [];
  const ids = new Set();
  const pairs = new Set();
  for (const raw of rawExceptions) {
    const exception = object(raw);
    const divisionIds = exception?.divisionIds;
    if (exception === undefined || !auditId(exception.id) || ids.has(exception.id)
      || exception.kind !== 'overlap' || !Array.isArray(divisionIds) || divisionIds.length !== 2
      || divisionIds.some((divisionId) => !auditId(divisionId) || !finalIds.has(divisionId))
      || divisionIds[0] === divisionIds[1] || !plainText(exception.reason)) {
      addFailure(failures, 'OVERLAP_EXCEPTION_INVALID', exception?.id);
      continue;
    }
    ids.add(exception.id);
    const pair = [...divisionIds].sort().join('\u0000');
    if (pairs.has(pair)) addFailure(failures, 'OVERLAP_EXCEPTION_DUPLICATE', exception.id);
    pairs.add(pair);
    validateReferenceIds(exception.referenceIds, referenceIds, failures, exception.id);
    result.push(exception);
  }
  return result;
}

function validateReferenceIds(rawIds, knownIds, failures, owner) {
  const ids = stringArray(rawIds);
  if (!Array.isArray(rawIds) || ids.length === 0 || ids.length !== rawIds.length) {
    addFailure(failures, 'REFERENCE_ID_REQUIRED', owner);
    return;
  }
  for (const id of ids) if (!knownIds.has(id)) addFailure(failures, 'REFERENCE_ID_UNKNOWN', `${owner}:${id}`);
}

function uniqueIds(rawIds, failureCode, failures, maximum = MAX_EVIDENCE_ITEMS) {
  if (!Array.isArray(rawIds) || rawIds.length > maximum) {
    addFailure(failures, failureCode);
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const id of rawIds) {
    if (!auditId(id) || seen.has(id)) addFailure(failures, failureCode, typeof id === 'string' ? id : undefined);
    else {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function directHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hasSensitiveQueryKey = [...url.searchParams.keys()].some((key) => {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      return ['secret', 'token', 'apikey', 'credential'].some((sensitive) => normalized.includes(sensitive));
    });
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
      && !hasSensitiveQueryKey
      && url.pathname !== '/' && !/^search\./iu.test(url.hostname)
      && !/(^|\/)(search|results?)(\/|$)/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function validateEvidenceFields(selector, exceptions, failures) {
  validateKnownFields(selector, [
    'schemaVersion', 'release', 'sovereignCode', 'status', 'productLevel',
    'overtureSelector', 'expectedCount', 'officialReferences', 'allowlist',
    'denylist', 'sampleApplicability', 'samples',
  ], 'selector', failures);
  validateKnownFields(selector?.overtureSelector, ['subtypes', 'adminLevels', 'localTypeRules'], 'selector.overtureSelector', failures);
  for (const [index, rule] of arrayEntries(selector?.overtureSelector?.localTypeRules)) {
    validateKnownFields(rule, ['field', 'values'], `selector.overtureSelector.localTypeRules[${index}]`, failures);
  }
  validateKnownFields(
    selector?.expectedCount,
    ['kind', 'value', 'minimum', 'maximum', 'referenceIds'],
    'selector.expectedCount',
    failures,
  );
  for (const [index, reference] of arrayEntries(selector?.officialReferences)) {
    validateKnownFields(
      reference,
      ['id', 'publisher', 'title', 'url', 'capturedOn', 'effectiveOn', 'license', 'machineReadable'],
      `selector.officialReferences[${index}]`,
      failures,
    );
  }
  validateKnownFields(selector?.sampleApplicability, ['border', 'coastal', 'specialCaseCategories'], 'selector.sampleApplicability', failures);
  for (const category of ['border', 'coastal']) {
    validateKnownFields(
      selector?.sampleApplicability?.[category],
      ['applicable', 'reason'],
      `selector.sampleApplicability.${category}`,
      failures,
    );
  }
  for (const [index, sample] of arrayEntries(selector?.samples)) {
    validateKnownFields(
      sample,
      ['category', 'institutionalCategory', 'divisionId', 'expectedInclusion', 'referenceIds'],
      `selector.samples[${index}]`,
      failures,
    );
  }
  validateKnownFields(
    exceptions,
    ['schemaVersion', 'release', 'sovereignCode', 'status', 'exceptions', 'overlapExceptions'],
    'exceptions',
    failures,
  );
  for (const [index, exception] of arrayEntries(exceptions?.exceptions)) {
    validateKnownFields(
      exception,
      ['divisionId', 'action', 'institutionalCategory', 'reason', 'referenceIds'],
      `exceptions.exceptions[${index}]`,
      failures,
    );
  }
  for (const [index, exception] of arrayEntries(exceptions?.overlapExceptions)) {
    validateKnownFields(
      exception,
      ['id', 'kind', 'divisionIds', 'reason', 'referenceIds'],
      `exceptions.overlapExceptions[${index}]`,
      failures,
    );
  }
}

function validateKnownFields(value, allowedFields, path, failures) {
  const candidate = object(value);
  if (candidate === undefined) return;
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) addFailure(failures, 'UNKNOWN_FIELD', `${path}.${key}`);
  }
}

function arrayEntries(value) {
  return Array.isArray(value) ? value.entries() : [];
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => plainText(item)) : [];
}

function auditId(value) {
  return plainText(value, 400);
}

function validCountryCode(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/u.test(value);
}

function validRelease(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}\.\d+$/u.test(value) && date(value.slice(0, 10));
}

function plainText(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && [...value].length <= limit && ![...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
  });
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : undefined;
}

function addFailure(failures, code, subject) {
  const failure = subject === undefined ? { code } : { code, subject };
  if (!failures.some((entry) => entry.code === failure.code && entry.subject === failure.subject)) failures.push(failure);
}

function compareFailures(left, right) {
  return left.code.localeCompare(right.code, 'en') || (left.subject ?? '').localeCompare(right.subject ?? '', 'en');
}

export async function runSelectorEvidenceCli(args, options = {}) {
  let parsed;
  try {
    parsed = parseCliArguments(args);
  } catch (error) {
    return cliFailure(error);
  }
  if (parsed.release !== FIXED_RELEASE) return failedCli('RELEASE_MISMATCH', parsed.release);

  const root = path.resolve(options.cwd ?? process.cwd());
  const auditRoot = path.join(root, 'data-audit');
  const workRoot = path.join(auditRoot, 'work', parsed.release, parsed.country);
  const resultIdsPath = path.join(workRoot, 'final-division-ids.json');

  try {
    const registry = await readBoundedJson(path.join(auditRoot, 'sovereign-registry.json'), 'registry', JSON_LIMITS.registry);
    if (!registryHasCountry(registry, parsed.country)) return failedCli('COUNTRY_NOT_REGISTERED', parsed.country);
    if (registry.release !== parsed.release) return failedCli('RELEASE_MISMATCH', parsed.release);

    const [selector, exceptions, resultIds] = await Promise.all([
      readBoundedJson(path.join(auditRoot, 'selectors', `${parsed.country}.json`), 'selector', JSON_LIMITS.selector),
      readBoundedJson(path.join(auditRoot, 'exceptions', `${parsed.country}.json`), 'exceptions', JSON_LIMITS.exceptions),
      readBoundedJson(resultIdsPath, 'result-ids', JSON_LIMITS.resultIds),
    ]);
    validateResultIdsDocument(resultIds, parsed.country, parsed.release);
    const result = verifySelectorEvidence({ selector, exceptions, finalDivisionIds: resultIds.divisionIds });
    return { exitCode: result.status === 'passed' ? 0 : 1, result };
  } catch (error) {
    return cliFailure(error);
  }
}

function parseCliArguments(args) {
  if (!Array.isArray(args)) throw new CliError('ARGUMENT_INVALID', 'arguments');
  const values = {};
  const names = { '--country': 'country', '--release': 'release' };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = names[flag];
    if (name === undefined) throw new CliError('ARGUMENT_UNSUPPORTED', 'argument');
    if (values[name] !== undefined || typeof args[index + 1] !== 'string' || args[index + 1].length === 0) {
      throw new CliError('ARGUMENT_INVALID', flag.slice(2));
    }
    values[name] = args[index + 1];
  }
  if (!validCountryCode(values.country)) throw new CliError('ARGUMENT_INVALID', 'country');
  if (!validRelease(values.release)) throw new CliError('ARGUMENT_INVALID', 'release');
  return values;
}

async function readBoundedJson(filePath, subject, byteLimit) {
  let handle;
  try {
    const parent = path.dirname(filePath);
    if (await realpath(parent) !== parent) throw new CliError('INPUT_UNREADABLE', subject);
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code === 'ENOENT') throw new CliError('INPUT_MISSING', subject);
    throw new CliError('INPUT_UNREADABLE', subject);
  }
  try {
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, (byteLimit + 1) - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > byteLimit) throw new CliError('INPUT_TOO_LARGE', subject);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    if (text.startsWith('\ufeff')) throw new CliError('JSON_BOM_FORBIDDEN', subject);
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError('JSON_INVALID', subject);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('INPUT_UNREADABLE', subject);
  } finally {
    await handle.close();
  }
}

function registryHasCountry(registry, country) {
  return object(registry) !== undefined && Array.isArray(registry.countries)
    && registry.countries.some((entry) => object(entry) !== undefined && entry.sovereignCode === country);
}

function validateResultIdsDocument(document, country, release) {
  if (object(document) === undefined) throw new CliError('RESULT_IDS_STRUCTURE_INVALID', 'result-ids');
  const allowed = new Set(['schemaVersion', 'release', 'sovereignCode', 'divisionIds']);
  if (Object.keys(document).some((key) => !allowed.has(key)) || document.schemaVersion !== 1
    || document.release !== release || document.sovereignCode !== country || !Array.isArray(document.divisionIds)) {
    throw new CliError('RESULT_IDS_STRUCTURE_INVALID', 'result-ids');
  }
}

function failedCli(code, subject) {
  return { exitCode: 1, result: { status: 'failed', failures: [{ code, subject }] } };
}

function cliFailure(error) {
  return error instanceof CliError
    ? failedCli(error.code, error.subject)
    : failedCli('INTERNAL_ERROR', 'selector-evidence');
}

class CliError extends Error {
  constructor(code, subject) {
    super(code);
    this.code = code;
    this.subject = subject;
  }
}

async function main() {
  const { exitCode, result } = await runSelectorEvidenceCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
