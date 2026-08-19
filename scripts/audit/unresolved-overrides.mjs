import { URL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.\d+$/;
const ISO_DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COUNTRY = /^[A-Z]{2}$/;
const SECRET_KEY = /(secret|token|apikey|credential)/i;

const fail = () => { throw new Error('UNRESOLVED_OVERRIDE_INVALID'); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => plain(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hasControl = (value) => [...value].some((character) => {
  const code = character.codePointAt(0);
  return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
});
const boundedText = (value, maximum) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !hasControl(value);

function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function readReference(value) {
  if (!exactKeys(value, ['title', 'url', 'retrievedOn', 'license'])
    || !boundedText(value.title, 500) || !boundedText(value.license, 1000)
    || !validDate(value.retrievedOn) || !boundedText(value.url, 2000)) fail();
  let url;
  try { url = new URL(value.url); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail();
  for (const key of url.searchParams.keys()) {
    if (SECRET_KEY.test(key.replaceAll(/[^a-z]/gi, ''))) fail();
  }
  return Object.freeze({ title: value.title, url: url.href, retrievedOn: value.retrievedOn, license: value.license });
}

export function validateUnresolvedOverrides(input, release, snapshotEvidence) {
  if (!exactKeys(input, ['schemaVersion', 'release', 'unresolved', 'overrides'])
    || input.schemaVersion !== 1 || typeof release !== 'string' || !RELEASE.test(release)
    || input.release !== release
    || !exactKeys(snapshotEvidence, ['rowCount', 'byteSize', 'sha256'])
    || !exactKeys(input.unresolved, ['rowCount', 'byteSize', 'sha256'])
    || !Number.isSafeInteger(snapshotEvidence.rowCount) || snapshotEvidence.rowCount < 0
    || !Number.isSafeInteger(snapshotEvidence.byteSize) || snapshotEvidence.byteSize < 1
    || typeof snapshotEvidence.sha256 !== 'string' || !SHA256.test(snapshotEvidence.sha256)
    || input.unresolved.rowCount !== snapshotEvidence.rowCount
    || input.unresolved.byteSize !== snapshotEvidence.byteSize
    || input.unresolved.sha256 !== snapshotEvidence.sha256
    || !Array.isArray(input.overrides) || input.overrides.length !== snapshotEvidence.rowCount
    || input.overrides.length > 10_000) fail();

  const divisionIds = new Set();
  const divisionAreaIds = new Set();
  const overrides = input.overrides.map((value) => {
    if (!exactKeys(value, ['divisionId', 'divisionAreaId', 'sovereignCode', 'rationale', 'officialReferences'])
      || typeof value.divisionId !== 'string' || !UUID.test(value.divisionId)
      || typeof value.divisionAreaId !== 'string' || !UUID.test(value.divisionAreaId)
      || typeof value.sovereignCode !== 'string' || !COUNTRY.test(value.sovereignCode)
      || !boundedText(value.rationale, 2000)
      || !Array.isArray(value.officialReferences) || value.officialReferences.length < 1
      || value.officialReferences.length > 8
      || divisionIds.has(value.divisionId) || divisionAreaIds.has(value.divisionAreaId)) fail();
    divisionIds.add(value.divisionId);
    divisionAreaIds.add(value.divisionAreaId);
    return Object.freeze({
      divisionId: value.divisionId,
      divisionAreaId: value.divisionAreaId,
      sovereignCode: value.sovereignCode,
      rationale: value.rationale,
      officialReferences: Object.freeze(value.officialReferences.map(readReference)),
    });
  }).sort((left, right) => left.divisionId.localeCompare(right.divisionId, 'en'));

  return Object.freeze({
    schemaVersion: 1,
    release,
    unresolved: Object.freeze({ ...snapshotEvidence }),
    overrides: Object.freeze(overrides),
  });
}
