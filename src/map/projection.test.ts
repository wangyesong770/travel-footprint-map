import { describe, expect, it } from 'vitest';

import { MAX_MERCATOR_LATITUDE, project, unproject } from './projection';

describe('Web Mercator projection', () => {
  it('round-trips an ordinary coordinate', () => {
    const projected = project(116.4074, 39.9042);
    const restored = unproject(projected.x, projected.y);

    expect(restored.lon).toBeCloseTo(116.4074, 8);
    expect(restored.lat).toBeCloseTo(39.9042, 8);
  });

  it('clamps latitude to the finite Web Mercator limit', () => {
    expect(project(0, 90).y).toBeCloseTo(project(0, MAX_MERCATOR_LATITUDE).y, 12);
    expect(project(0, -90).y).toBeCloseTo(project(0, -MAX_MERCATOR_LATITUDE).y, 12);
  });

  it('wraps longitude and clamps projected inputs when unprojecting', () => {
    expect(project(540, 0).x).toBeCloseTo(0, 12);
    expect(unproject(-10, -10).lat).toBeCloseTo(MAX_MERCATOR_LATITUDE, 8);
    expect(unproject(11, 11).lat).toBeCloseTo(-MAX_MERCATOR_LATITUDE, 8);
  });

  it('rejects non-finite values', () => {
    expect(() => project(Number.NaN, 0)).toThrow('坐标必须是有限数值');
    expect(() => unproject(0, Number.POSITIVE_INFINITY)).toThrow('坐标必须是有限数值');
  });
});
