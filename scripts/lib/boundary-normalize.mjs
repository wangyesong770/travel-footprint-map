const MAX_NAME_CODE_POINTS = 160;
const MAX_ALIASES = 20;
const MAX_FEATURES = 250_000;
const MAX_VERTICES_PER_FEATURE = 100_000;

export function normalizeFeatureCollection(input, expectedCountryCode, options = {}) {
  const countryCode = normalizeCountryCode(expectedCountryCode);
  if (!isPlainObject(input) || input.type !== 'FeatureCollection' || !Array.isArray(input.features)) {
    throw new Error('boundary input must be a GeoJSON FeatureCollection');
  }
  if (input.features.length === 0 || input.features.length > MAX_FEATURES) {
    throw new Error(`feature count must be between 1 and ${MAX_FEATURES}`);
  }

  const identities = new Set();
  const features = input.features.map((feature, index) => {
    if (!isPlainObject(feature) || feature.type !== 'Feature' || !isPlainObject(feature.properties)) {
      throw new Error(`feature ${index} must be a GeoJSON Feature`);
    }
    const sourceId = boundedString(feature.id, 'source ID');
    if (sourceId.includes(':')) throw new Error('source ID must not contain a colon');
    if (identities.has(sourceId)) throw new Error(`duplicate source ID: ${sourceId}`);
    identities.add(sourceId);

    const featureCountry = normalizeCountryCode(feature.properties.country);
    if (featureCountry !== countryCode) {
      throw new Error(`country mismatch for source ID ${sourceId}`);
    }
    const geometry = normalizeGeometry(feature.geometry);
    const names = isPlainObject(feature.properties.names) ? feature.properties.names : {};
    const commonNames = isPlainObject(names.common) ? names.common : {};
    const nameLocal = boundedString(names.primary, 'primary name');
    const nameZh = optionalBoundedString(commonNames.zh, 'Chinese name');
    const aliases = normalizeAliases(feature.properties.aliases);
    const adminLevel = boundedString(
      feature.properties.subtype ?? feature.properties.admin_level,
      'administrative level',
    );
    if (Array.isArray(options.acceptedLevels) && !options.acceptedLevels.includes(adminLevel)) {
      throw new Error(`administrative level is not configured for ${countryCode}`);
    }

    return {
      type: 'Feature',
      properties: {
        areaId: `${countryCode}:overture:${sourceId}`,
        countryCode,
        sourceId,
        adminLevel,
        ...(nameZh === undefined ? {} : { nameZh }),
        nameLocal,
        aliases,
        centroid: computeCentroid(geometry),
      },
      geometry,
    };
  });

  features.sort((left, right) => left.properties.areaId.localeCompare(right.properties.areaId, 'en'));
  return { type: 'FeatureCollection', features };
}

export function normalizeMetadata(metadata) {
  if (!isPlainObject(metadata)) throw new Error('source metadata is required');
  const source = boundedString(metadata.source, 'source');
  if (!/^Overture Maps Divisions division_area$/i.test(source)) {
    throw new Error('source must be Overture Maps Divisions division_area');
  }
  const license = boundedString(metadata.license, 'license');
  if (license !== 'ODbL-1.0') throw new Error('Overture Divisions license must be ODbL-1.0');
  const attribution = boundedString(metadata.attribution, 'attribution', 500);
  if (!/Overture Maps Foundation/.test(attribution) || !/ODbL/i.test(attribution)) {
    throw new Error('attribution must identify Overture Maps Foundation and ODbL');
  }
  const boundaryVersion = boundedString(metadata.boundaryVersion, 'boundary version');
  const retrievedAt = boundedString(metadata.retrievedAt, 'retrieved timestamp');
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('retrieved timestamp must be ISO-compatible');
  return { boundaryVersion, retrievedAt, source: 'overture', license, attribution };
}

function normalizeGeometry(geometry) {
  if (!isPlainObject(geometry) || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    throw new Error('geometry must be Polygon or MultiPolygon');
  }
  let vertexCount = 0;
  const polygon = (rings) => {
    if (!Array.isArray(rings) || rings.length === 0) throw new Error('Polygon must contain rings');
    return rings.map((ring, ringIndex) => {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error('ring must have at least four coordinates');
      const normalized = ring.map((position) => {
        vertexCount += 1;
        if (vertexCount > MAX_VERTICES_PER_FEATURE) throw new Error('feature vertex limit exceeded');
        return normalizePosition(position);
      });
      if (!samePosition(normalized[0], normalized.at(-1))) throw new Error('ring must be closed');
      const area = signedRingArea(normalized);
      if (area === 0) throw new Error('ring must enclose a non-zero area');
      const shouldBePositive = ringIndex === 0;
      return (area > 0) === shouldBePositive ? normalized : normalized.toReversed();
    });
  };
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: polygon(geometry.coordinates) };
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    throw new Error('MultiPolygon must contain polygons');
  }
  return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon) };
}

function normalizePosition(position) {
  if (!Array.isArray(position) || position.length !== 2) throw new Error('coordinate must be [longitude, latitude]');
  const [longitude, latitude] = position;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error('coordinate must be finite WGS84 longitude/latitude');
  }
  return [Object.is(longitude, -0) ? 0 : longitude, Object.is(latitude, -0) ? 0 : latitude];
}

function computeCentroid(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let longitudeX = 0;
  let longitudeY = 0;
  let latitude = 0;
  let count = 0;
  for (const rings of polygons) {
    for (const [longitude, currentLatitude] of rings[0].slice(0, -1)) {
      const radians = longitude * Math.PI / 180;
      longitudeX += Math.cos(radians);
      longitudeY += Math.sin(radians);
      latitude += currentLatitude;
      count += 1;
    }
  }
  let longitude = Math.atan2(longitudeY / count, longitudeX / count) * 180 / Math.PI;
  if (Object.is(longitude, -0)) longitude = 0;
  return [roundCoordinate(longitude), roundCoordinate(latitude / count)];
}

function signedRingArea(ring) {
  let area = 0;
  let previousLongitude = ring[0][0];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const currentLongitude = unwrapLongitude(ring[index][0], previousLongitude);
    const nextLongitude = unwrapLongitude(ring[index + 1][0], currentLongitude);
    area += currentLongitude * ring[index + 1][1] - nextLongitude * ring[index][1];
    previousLongitude = currentLongitude;
  }
  return area / 2;
}

function unwrapLongitude(longitude, previous) {
  let result = longitude;
  while (result - previous > 180) result -= 360;
  while (result - previous < -180) result += 360;
  return result;
}

function normalizeAliases(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ALIASES) throw new Error(`aliases must contain at most ${MAX_ALIASES} strings`);
  return [...new Set(value.map((alias) => boundedString(alias, 'alias')))];
}

function normalizeCountryCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) throw new Error('country code must be two ASCII letters');
  return value.toUpperCase();
}

function boundedString(value, label, limit = MAX_NAME_CODE_POINTS) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() !== String(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const result = String(value);
  if (result.length === 0 || Array.from(result).length > limit || containsControlCharacter(result)) {
    throw new Error(`${label} is empty, too long, or contains control characters`);
  }
  return result;
}

function containsControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function optionalBoundedString(value, label) {
  return value === undefined || value === null || value === '' ? undefined : boundedString(value, label);
}

function samePosition(left, right) {
  return Array.isArray(right) && left[0] === right[0] && left[1] === right[1];
}

function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
