const WARNING_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;

export function auditCountry(input, config, reference = {}) {
  const features = Array.isArray(input) ? input : input?.features;
  if (!Array.isArray(features)) throw new Error('features must be an array or FeatureCollection');
  const failures = [];
  const appliedExceptions = new Set();
  const identities = new Set();
  const areaIds = [];
  const validGeometries = [];
  const geometryOwners = new Map();
  const vertexCounts = [];
  let vertexCount = 0;

  for (const [index, feature] of features.entries()) {
    const properties = feature?.properties;
    const divisionId = stringValue(properties?.divisionId ?? properties?.sourceId);
    const sourceId = stringValue(properties?.sourceId);
    const areaId = stringValue(properties?.areaId);
    if (divisionId === undefined) {
      addFailure(failures, 'DIVISION_ID_MISSING', { featureIndex: index });
    } else if (identities.has(divisionId)) {
      addFailure(failures, 'DIVISION_ID_DUPLICATE', { divisionIds: [divisionId] });
    } else {
      identities.add(divisionId);
    }
    if (areaId !== undefined) areaIds.push(areaId);
    if (divisionId !== undefined && (sourceId !== divisionId
      || areaId !== `${config?.sovereignCode}:overture:${divisionId}`
      || properties?.countryCode !== config?.sovereignCode)) {
      addFailure(failures, 'IDENTITY_MISMATCH', { divisionIds: [divisionId] });
    }
    if (typeof properties?.nameLocal !== 'string' || properties.nameLocal.trim().length === 0) {
      addFailure(failures, 'LOCAL_NAME_MISSING', divisionId === undefined ? { featureIndex: index } : { divisionIds: [divisionId] });
    }

    let inspected;
    try {
      inspected = inspectGeometry(feature?.geometry);
    } catch {
      addFailure(failures, 'GEOMETRY_INVALID', divisionId === undefined ? { featureIndex: index } : { divisionIds: [divisionId] });
      continue;
    }
    for (const code of inspected.failures) {
      addFailure(failures, code, divisionId === undefined ? { featureIndex: index } : { divisionIds: [divisionId] });
    }
    if (inspected.failures.length > 0) continue;
    if (!Number.isSafeInteger(vertexCount + inspected.vertexCount)) {
      addFailure(failures, 'VERTEX_COUNT_OVERFLOW');
      continue;
    }
    vertexCount += inspected.vertexCount;
    vertexCounts.push(inspected.vertexCount);
    const geometryKey = canonicalGeometry(inspected.polygons);
    const previousOwner = geometryOwners.get(geometryKey);
    if (previousOwner !== undefined && divisionId !== undefined) {
      addFailure(failures, 'DUPLICATE_GEOMETRY', { divisionIds: [previousOwner, divisionId].sort(compareText) });
    } else if (divisionId !== undefined) {
      geometryOwners.set(geometryKey, divisionId);
    }
    if (divisionId !== undefined) validGeometries.push({ divisionId, polygons: inspected.polygons, boxes: polygonBoxes(inspected.polygons) });
  }

  validateIndexIds(areaIds, reference.indexIds, failures);
  validateCount(features.length, config?.expectedCount, failures);
  findOverlaps(validGeometries, reference.exceptions, failures, appliedExceptions);

  const compressedBytes = Number.isSafeInteger(reference.compressedBytes) && reference.compressedBytes >= 0
    ? reference.compressedBytes
    : 0;
  const warnings = [];
  if (compressedBytes > WARNING_BYTES) warnings.push('PACKAGE_SIZE_P95_EXCEEDED');
  if (compressedBytes > MAX_BYTES) addFailure(failures, 'PACKAGE_TOO_LARGE');

  vertexCounts.sort((left, right) => left - right);
  const metrics = {
    featureCount: features.length,
    vertexCount,
    vertices: {
      p50: percentile(vertexCounts, 0.5),
      p95: percentile(vertexCounts, 0.95),
      max: vertexCounts.at(-1) ?? 0,
    },
    compressedBytes,
    warnings,
  };
  failures.sort(compareFailure);
  if (failures.length > 0) return { status: 'failed', failures, metrics };
  return { status: 'verified', metrics, exceptions: [...appliedExceptions].sort(compareText) };
}

function inspectGeometry(geometry) {
  const failures = [];
  const polygons = [];
  let vertexCount = 0;
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') {
    return { failures: ['GEOMETRY_TYPE_INVALID'], polygons, vertexCount };
  }
  const rawPolygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(rawPolygons) || rawPolygons.length === 0) return { failures: ['GEOMETRY_EMPTY'], polygons, vertexCount };
  for (const rawRings of rawPolygons) {
    if (!Array.isArray(rawRings) || rawRings.length === 0) {
      failures.push('GEOMETRY_EMPTY');
      continue;
    }
    const rings = [];
    for (const rawRing of rawRings) {
      if (!Array.isArray(rawRing) || rawRing.length < 4) {
        failures.push('RING_TOO_SHORT');
        continue;
      }
      const ring = [];
      for (const rawPosition of rawRing) {
        if (!Array.isArray(rawPosition) || rawPosition.length !== 2
          || !Number.isFinite(rawPosition[0]) || !Number.isFinite(rawPosition[1])
          || rawPosition[0] < -180 || rawPosition[0] > 180
          || rawPosition[1] < -90 || rawPosition[1] > 90) {
          failures.push('COORDINATE_INVALID');
          continue;
        }
        ring.push([rawPosition[0], rawPosition[1]]);
        if (!Number.isSafeInteger(vertexCount + 1)) failures.push('VERTEX_COUNT_OVERFLOW');
        else vertexCount += 1;
      }
      if (ring.length !== rawRing.length) continue;
      if (!samePosition(ring[0], ring.at(-1))) failures.push('RING_NOT_CLOSED');
      const unwrapped = unwrapRing(ring);
      if (signedArea(unwrapped) === 0) failures.push('RING_ZERO_AREA');
      rings.push(unwrapped);
    }
    if (rings.length === rawRings.length) polygons.push(rings);
  }
  return { failures: [...new Set(failures)].sort(compareText), polygons, vertexCount };
}

function validateIndexIds(areaIds, rawIndexIds, failures) {
  if (!Array.isArray(rawIndexIds)) {
    addFailure(failures, 'INDEX_ID_MISMATCH');
    return;
  }
  const indexIds = rawIndexIds.filter((value) => typeof value === 'string');
  const packageUnique = [...new Set(areaIds)].sort(compareText);
  const indexUnique = [...new Set(indexIds)].sort(compareText);
  if (packageUnique.length !== areaIds.length || indexUnique.length !== indexIds.length
    || packageUnique.length !== indexUnique.length
    || packageUnique.some((value, index) => value !== indexUnique[index])) {
    addFailure(failures, 'INDEX_ID_MISMATCH');
  }
}

function validateCount(actual, expectation, failures) {
  if (Number.isSafeInteger(expectation?.minimum) && Number.isSafeInteger(expectation?.maximum)) {
    if (expectation.minimum < 0 || expectation.maximum < expectation.minimum
      || actual < expectation.minimum || actual > expectation.maximum) addFailure(failures, 'COUNT_MISMATCH');
    return;
  }
  if (expectation?.kind === 'exact') {
    if (!Number.isSafeInteger(expectation.value) || actual !== expectation.value) addFailure(failures, 'COUNT_MISMATCH');
    return;
  }
  if (expectation?.kind === 'range') {
    if (!Number.isSafeInteger(expectation.min) || !Number.isSafeInteger(expectation.max)
      || expectation.min < 0 || expectation.max < expectation.min
      || actual < expectation.min || actual > expectation.max) addFailure(failures, 'COUNT_MISMATCH');
    return;
  }
  addFailure(failures, 'COUNT_REFERENCE_INVALID');
}

function findOverlaps(features, rawExceptions, failures, appliedExceptions) {
  const exceptions = normalizeOverlapExceptions(rawExceptions, failures);
  const entries = [];
  for (const feature of features) {
    for (const box of feature.boxes) {
      for (const shift of [-360, 0, 360]) entries.push({ ...box, minX: box.minX + shift, maxX: box.maxX + shift, feature });
    }
  }
  entries.sort((left, right) => left.minX - right.minX || left.maxX - right.maxX || compareText(left.feature.divisionId, right.feature.divisionId));
  const active = [];
  const candidates = new Set();
  for (const entry of entries) {
    let write = 0;
    for (const candidate of active) if (candidate.maxX > entry.minX) active[write++] = candidate;
    active.length = write;
    for (const candidate of active) {
      if (candidate.feature === entry.feature || candidate.maxY <= entry.minY || entry.maxY <= candidate.minY) continue;
      const pair = [candidate.feature.divisionId, entry.feature.divisionId].sort(compareText);
      candidates.add(`${pair[0]}\u0000${pair[1]}`);
    }
    active.push(entry);
  }

  const byId = new Map(features.map((feature) => [feature.divisionId, feature]));
  for (const encoded of [...candidates].sort(compareText)) {
    const divisionIds = encoded.split('\u0000');
    const left = byId.get(divisionIds[0]);
    const right = byId.get(divisionIds[1]);
    if (left === undefined || right === undefined || !geometriesOverlap(left.polygons, right.polygons)) continue;
    const exception = exceptions.get(encoded);
    if (exception === undefined) addFailure(failures, 'OVERLAP_UNEXPLAINED', { divisionIds });
    else appliedExceptions.add(exception);
  }
}

function normalizeOverlapExceptions(rawExceptions, failures) {
  const result = new Map();
  if (rawExceptions === undefined) return result;
  if (!Array.isArray(rawExceptions)) {
    addFailure(failures, 'EXCEPTION_INVALID');
    return result;
  }
  const ids = new Set();
  for (const exception of rawExceptions) {
    if (!safeAuditId(exception?.id, 128) || ids.has(exception.id)
      || exception.kind !== 'overlap' || !Array.isArray(exception.divisionIds)
      || exception.divisionIds.length !== 2 || exception.divisionIds.some((value) => !safeAuditId(value, 400))
      || exception.divisionIds[0] === exception.divisionIds[1]) {
      addFailure(failures, 'EXCEPTION_INVALID');
      continue;
    }
    ids.add(exception.id);
    const pair = [...exception.divisionIds].sort(compareText);
    const key = `${pair[0]}\u0000${pair[1]}`;
    if (result.has(key)) addFailure(failures, 'EXCEPTION_INVALID');
    else result.set(key, exception.id);
  }
  return result;
}

function geometriesOverlap(leftPolygons, rightPolygons) {
  for (const left of leftPolygons) {
    for (const rightRaw of rightPolygons) {
      const shift = Math.round((ringMeanLongitude(left[0]) - ringMeanLongitude(rightRaw[0])) / 360) * 360;
      const right = shift === 0 ? rightRaw : rightRaw.map((ring) => ring.map(([x, y]) => [x + shift, y]));
      if (polygonsOverlap(left, right)) return true;
    }
  }
  return false;
}

function polygonsOverlap(left, right) {
  for (const leftRing of left) {
    for (const rightRing of right) {
      for (let leftIndex = 0; leftIndex < leftRing.length - 1; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < rightRing.length - 1; rightIndex += 1) {
          if (segmentsProperlyIntersect(leftRing[leftIndex], leftRing[leftIndex + 1], rightRing[rightIndex], rightRing[rightIndex + 1])) return true;
        }
      }
    }
  }
  return left[0].slice(0, -1).some((point) => pointInPolygon(point, right) === 1)
    || right[0].slice(0, -1).some((point) => pointInPolygon(point, left) === 1);
}

function pointInPolygon(point, rings) {
  const outer = pointInRing(point, rings[0]);
  if (outer !== 1) return outer;
  for (const hole of rings.slice(1)) {
    const result = pointInRing(point, hole);
    if (result === 0) return 0;
    if (result === 1) return -1;
  }
  return 1;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if (pointOnSegment([x, y], a, b)) return 0;
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function segmentsProperlyIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return abC !== 0 && abD !== 0 && cdA !== 0 && cdB !== 0
    && Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB);
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function pointOnSegment(point, start, end) {
  return orientation(start, end, point) === 0
    && point[0] >= Math.min(start[0], end[0]) && point[0] <= Math.max(start[0], end[0])
    && point[1] >= Math.min(start[1], end[1]) && point[1] <= Math.max(start[1], end[1]);
}

function polygonBoxes(polygons) {
  return polygons.map((rings) => {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const [x, y] of rings[0]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { minX, maxX, minY, maxY };
  });
}

function unwrapRing(ring) {
  if (ring.length === 0) return [];
  const result = [[ring[0][0], ring[0][1]]];
  for (let index = 1; index < ring.length; index += 1) {
    let longitude = ring[index][0];
    const previous = result[index - 1][0];
    while (longitude - previous > 180) longitude -= 360;
    while (longitude - previous < -180) longitude += 360;
    result.push([longitude, ring[index][1]]);
  }
  return result;
}

function canonicalGeometry(polygons) {
  const normalized = polygons.map((rings) => {
    const mean = ringMeanLongitude(rings[0]);
    const shift = -Math.floor((mean + 180) / 360) * 360;
    const shifted = shift === 0 ? rings : rings.map((ring) => ring.map(([x, y]) => [x + shift, y]));
    return [canonicalRing(shifted[0]), ...shifted.slice(1).map(canonicalRing).sort(compareCoordinates)];
  }).sort(compareCoordinates);
  return JSON.stringify(normalized);
}

function canonicalRing(ring) {
  const body = ring.slice(0, -1);
  if (body.length === 0) return ring;
  const forward = rotateToMinimum(body);
  const reverse = rotateToMinimum([...body].reverse());
  const chosen = compareCoordinates(forward, reverse) <= 0 ? forward : reverse;
  return [...chosen, chosen[0]];
}

function rotateToMinimum(ring) {
  let minimum = 0;
  for (let index = 1; index < ring.length; index += 1) if (compareCoordinates(ring[index], ring[minimum]) < 0) minimum = index;
  return [...ring.slice(minimum), ...ring.slice(0, minimum)];
}

function compareCoordinates(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right), 'en');
}

function ringMeanLongitude(ring) {
  return ring.slice(0, -1).reduce((sum, [longitude]) => sum + longitude, 0) / Math.max(1, ring.length - 1);
}

function signedArea(ring) {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return sum / 2;
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function samePosition(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left[0] === right[0] && left[1] === right[1];
}

function addFailure(failures, code, detail = {}) {
  const candidate = { code, ...detail };
  const serialized = JSON.stringify(candidate);
  if (!failures.some((failure) => JSON.stringify(failure) === serialized)) failures.push(candidate);
}

function compareFailure(left, right) {
  return left.code.localeCompare(right.code, 'en') || JSON.stringify(left).localeCompare(JSON.stringify(right), 'en');
}

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeAuditId(value, maximum) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= maximum
    && ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
    });
}
