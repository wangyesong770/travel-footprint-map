const ID_LIMIT = 400;

/**
 * Selects extracted Overture division rows without inferring an administrative level.
 * Source ownership and land geometry are hard gates. The allowlist overrides only the
 * reviewed raw-field predicate; the denylist always wins.
 */
export function selectCountryFeatures(rows, config) {
  if (!Array.isArray(rows)) throw new Error('selector rows must be an array');
  const sovereignCode = countryCode(config?.sovereignCode, 'sovereignCode');
  const sourceCodes = new Set(requiredArray(config?.sourceCountryCodes, 'sourceCountryCodes').map((code) => countryCode(code, 'sourceCountryCode')));
  const selector = config?.overtureSelector;
  if (!isPlainObject(selector)) throw new Error('overtureSelector is required');
  const subtypes = new Set(array(selector.subtypes, 'selector subtypes').map((value) => text(value, 'selector subtype')));
  const adminLevels = new Set(array(selector.adminLevels, 'selector adminLevels').map((value) => safeInteger(value, 'selector adminLevel')));
  const localTypeRules = selector.localTypeRules === undefined
    ? []
    : array(selector.localTypeRules, 'selector localTypeRules').map(normalizeLocalTypeRule);
  if (subtypes.size === 0 && adminLevels.size === 0 && localTypeRules.length === 0) throw new Error('selector must contain a positive predicate');
  const allowlist = new Set(array(config?.allowlist, 'allowlist').map((value) => text(value, 'allowlist divisionId', ID_LIMIT)));
  const denylist = new Set(array(config?.denylist, 'denylist').map((value) => text(value, 'denylist divisionId', ID_LIMIT)));
  const productLevel = text(config?.productLevel, 'productLevel');
  const seen = new Set();
  const selected = [];

  for (const input of rows) {
    if (!isPlainObject(input)) throw new Error('selector row must be an object');
    const divisionId = text(input.divisionId, 'divisionId', ID_LIMIT);
    if (seen.has(divisionId)) throw new Error(`duplicate divisionId: ${divisionId}`);
    seen.add(divisionId);

    const owned = typeof input.sourceCountryCode === 'string'
      && sourceCodes.has(input.sourceCountryCode.toUpperCase());
    if (!owned || input.isLand !== true) continue;

    const matchesRawFields = (subtypes.size === 0 || subtypes.has(input.subtype))
      && (adminLevels.size === 0 || adminLevels.has(input.adminLevel))
      && localTypeRules.every((rule) => rule.values.has(input.localType));
    if ((!matchesRawFields && !allowlist.has(divisionId)) || denylist.has(divisionId)) continue;

    selected.push({ ...input, divisionId, sovereignCode, productLevel });
  }

  return selected.sort((left, right) => left.divisionId.localeCompare(right.divisionId, 'en'));
}

function normalizeLocalTypeRule(input) {
  if (!isPlainObject(input)) throw new Error('local type rule must be an object');
  if (input.field !== 'local_type') throw new Error('local type field must be local_type');
  const values = new Set(requiredArray(input.values, 'local type values').map((value) => text(value, 'local type value')));
  return { values };
}

function array(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredArray(value, label) {
  const result = array(value, label);
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function countryCode(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/u.test(value)) throw new Error(`${label} must be an ISO2 code`);
  return value.toUpperCase();
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
}

function text(value, label, limit = 160) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || [...value].length > limit) {
    throw new Error(`${label} must be a bounded string`);
  }
  if ([...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
  })) throw new Error(`${label} contains control characters`);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
