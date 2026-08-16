export const MAX_MERCATOR_LATITUDE = 85.05112878;

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface GeographicPoint {
  lon: number;
  lat: number;
}

function assertFinite(...values: number[]): void {
  if (!values.every(Number.isFinite)) {
    throw new Error('坐标必须是有限数值');
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function wrapLongitude(longitude: number): number {
  assertFinite(longitude);
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function project(longitude: number, latitude: number): ProjectedPoint {
  assertFinite(longitude, latitude);
  const lon = longitude >= -180 && longitude <= 180 ? longitude : wrapLongitude(longitude);
  const lat = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const radians = (lat * Math.PI) / 180;

  return {
    x: (lon + 180) / 360,
    y: (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2,
  };
}

export function unproject(x: number, y: number): GeographicPoint {
  assertFinite(x, y);
  const normalizedX = ((x % 1) + 1) % 1;
  const normalizedY = clamp(y, 0, 1);
  const latitude = (Math.atan(Math.sinh(Math.PI * (1 - 2 * normalizedY))) * 180) / Math.PI;

  return {
    lon: normalizedX * 360 - 180,
    lat: clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE),
  };
}
