import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CachedBoundary, CitySummary } from '../domain/types';
import type { CityArea, CountryBoundaryPackage } from '../areas/types';
import { createMapEngine } from './map-engine';

const city: CitySummary = {
  id: 1,
  name: 'Test City',
  asciiName: 'Test City',
  aliases: [],
  countryCode: 'TC',
  continentCode: 'AS',
  lat: 0,
  lon: 0,
};

const boundary: CachedBoundary = {
  cityId: 1,
  geometry: {
    type: 'MultiPolygon',
    coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]],
  },
  source: 'fixture',
  fetchedAt: '2026-08-16T00:00:00.000Z',
};

const countryPackage: CountryBoundaryPackage = {
  schemaVersion: 1,
  countryCode: 'CN',
  boundaryVersion: 'fixture',
  administrativeScheme: '地级行政区',
  source: 'overture',
  attribution: 'fixture',
  features: [
    {
      type: 'Feature',
      properties: {
        areaId: 'CN:overture:beijing',
        countryCode: 'CN',
        sourceId: 'beijing',
        adminLevel: 'prefecture',
        nameZh: '北京',
        nameLocal: 'Beijing',
        aliases: [],
        centroid: [116.4, 39.9],
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[115, 39], [117, 39], [117, 41], [115, 39]]],
      },
    },
    {
      type: 'Feature',
      properties: {
        areaId: 'CN:overture:shanghai',
        countryCode: 'CN',
        sourceId: 'shanghai',
        adminLevel: 'prefecture',
        nameZh: '上海',
        nameLocal: 'Shanghai',
        aliases: [],
        centroid: [121.47, 31.23],
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[120.8, 30.7], [122, 30.7], [122, 31.8], [120.8, 30.7]]],
      },
    },
  ],
};

function makeSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) }),
  });
  document.body.append(svg);
  return svg;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('SVG map engine', () => {
  it('renders countries, sparse labels, boundaries, and accessible fallback points', () => {
    const svg = makeSvg();
    const engine = createMapEngine(svg, {
      worldMap: {
        attribution: 'fixture',
        countries: [{ id: 'TC', path: 'M0 0L10 0L10 10Z', label: { name: '测试国', x: 5, y: 5 } }],
      },
    });

    engine.setVisits([{ city, boundary }, { city: { ...city, id: 2, name: 'Fallback', lon: 30 } }]);

    expect(svg.querySelectorAll('[data-country]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-country-label]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-visited-boundary]')).toHaveLength(1);
    const point = svg.querySelector<SVGCircleElement>('[data-visited-point]');
    expect(point?.getAttribute('tabindex')).toBe('0');
    expect(point?.getAttribute('aria-label')).toContain('Fallback');
    engine.destroy();
  });

  it('keeps wheel zoom anchored and clamps panning to the world', () => {
    const svg = makeSvg();
    const engine = createMapEngine(svg, { worldMap: { attribution: 'fixture', countries: [] } });

    svg.dispatchEvent(new WheelEvent('wheel', { clientX: 250, clientY: 100, deltaY: -100, bubbles: true, cancelable: true }));
    const zoomed = engine.getViewState();
    expect(zoomed.zoom).toBeGreaterThan(1);
    expect((250 - zoomed.offsetX) / zoomed.zoom).toBeCloseTo(250, 6);
    expect((100 - zoomed.offsetY) / zoomed.zoom).toBeCloseTo(100, 6);

    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100 }));
    svg.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10000, clientY: 10000 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 10000, clientY: 10000 }));
    const panned = engine.getViewState();
    expect(panned.offsetX).toBeLessThanOrEqual(0);
    expect(panned.offsetY).toBeLessThanOrEqual(0);
    expect(panned.offsetX).toBeGreaterThanOrEqual(1000 - 1000 * panned.zoom);
    expect(panned.offsetY).toBeGreaterThanOrEqual(500 - 500 * panned.zoom);
    engine.destroy();
  });

  it('inverse-projects a click and supports keyboard zoom', () => {
    const onMapClick = vi.fn();
    const svg = makeSvg();
    const engine = createMapEngine(svg, { onMapClick, worldMap: { attribution: 'fixture', countries: [] } });

    svg.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 250, bubbles: true }));
    expect(onMapClick).toHaveBeenCalledWith(expect.objectContaining({ lon: expect.closeTo(0, 6), lat: expect.closeTo(0, 6) }));

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(engine.getViewState().zoom).toBeGreaterThan(1);
    engine.destroy();
  });

  it('cancels pointer interaction and removes global listeners on destroy', () => {
    const svg = makeSvg();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const engine = createMapEngine(svg, { worldMap: { attribution: 'fixture', countries: [] } });

    svg.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    engine.destroy();

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function));
  });

  it('falls back to a point when cached boundary geometry is malicious', () => {
    const svg = makeSvg();
    const engine = createMapEngine(svg, {
      maxGeometryVertices: 3,
      worldMap: { attribution: 'fixture', countries: [] },
    });

    engine.setVisits([{ city, boundary }]);

    expect(svg.querySelector('[data-visited-boundary]')).toBeNull();
    expect(svg.querySelector('[data-visited-point]')).not.toBeNull();
    engine.destroy();
  });

  it('disables animated transforms when reduced motion is requested', () => {
    const svg = makeSvg();
    const engine = createMapEngine(svg, {
      prefersReducedMotion: true,
      worldMap: { attribution: 'fixture', countries: [] },
    });

    expect(svg.dataset.reducedMotion).toBe('true');
    expect(svg.querySelector('[data-map-viewport]')?.getAttribute('style') ?? '').not.toContain('transition');
    engine.destroy();
  });

  it('navigates from an interactive world country by click and keyboard', () => {
    const onCountrySelect = vi.fn();
    const svg = makeSvg();
    const engine = createMapEngine(svg, {
      onCountrySelect,
      worldMap: {
        attribution: 'fixture',
        countries: [{ id: 'CN', path: 'M0 0L10 0L10 10Z', label: { name: '中国', x: 5, y: 5 } }],
      },
    });
    engine.showWorld([{ countryCode: 'CN', visitedCount: 2 }]);

    const country = svg.querySelector<SVGPathElement>('[data-country="CN"]')!;
    expect(country.getAttribute('role')).toBe('button');
    expect(country.getAttribute('tabindex')).toBe('0');
    expect(country.classList.contains('country-visited')).toBe(true);
    country.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    country.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onCountrySelect).toHaveBeenCalledTimes(2);
    expect(onCountrySelect).toHaveBeenLastCalledWith('CN');
    engine.destroy();
  });

  it('renders every country area and emits the same stable id for visited re-clicks', () => {
    const onAreaSelect = vi.fn();
    const svg = makeSvg();
    const engine = createMapEngine(svg, {
      onAreaSelect,
      worldMap: { attribution: 'fixture', countries: [] },
    });

    engine.showCountry(countryPackage, new Set(['CN:overture:beijing']));

    expect(svg.querySelectorAll('[data-area-id]')).toHaveLength(2);
    const visited = svg.querySelector<SVGPathElement>('[data-area-id="CN:overture:beijing"]')!;
    const unvisited = svg.querySelector<SVGPathElement>('[data-area-id="CN:overture:shanghai"]')!;
    expect(visited.classList.contains('area-visited')).toBe(true);
    expect(unvisited.classList.contains('area-unvisited')).toBe(true);
    expect(visited.getAttribute('aria-label')).toContain('北京');

    visited.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    visited.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onAreaSelect).toHaveBeenNthCalledWith(1, 'CN:overture:beijing');
    expect(onAreaSelect).toHaveBeenNthCalledWith(2, 'CN:overture:beijing');
    engine.destroy();
  });

  it('focuses an area without changing its identity or visited state', () => {
    const svg = makeSvg();
    const engine = createMapEngine(svg, { worldMap: { attribution: 'fixture', countries: [] } });
    engine.showCountry(countryPackage, new Set(['CN:overture:beijing']));

    engine.focusArea('CN:overture:beijing');

    const area = svg.querySelector<SVGPathElement>('[data-area-id="CN:overture:beijing"]')!;
    expect(document.activeElement).toBe(area);
    expect(area.classList.contains('area-visited')).toBe(true);
    expect(area.dataset.areaId).toBe('CN:overture:beijing');
    engine.destroy();
  });

  it('adds a transparent delegated hit path for a visually tiny area', () => {
    const onAreaSelect = vi.fn();
    const svg = makeSvg();
    const tinyArea: CityArea = {
      ...countryPackage.features[0]!,
      properties: { ...countryPackage.features[0]!.properties, areaId: 'CN:overture:tiny' as const, sourceId: 'tiny' },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[[116, 39], [116.001, 39], [116.001, 39.001], [116, 39]]],
      },
    };
    const engine = createMapEngine(svg, { onAreaSelect, worldMap: { attribution: 'fixture', countries: [] } });
    engine.showCountry({ ...countryPackage, features: [tinyArea] }, new Set());

    const hit = svg.querySelector<SVGPathElement>('[data-area-hit="CN:overture:tiny"]')!;
    expect(hit).not.toBeNull();
    expect(hit.getAttribute('aria-hidden')).toBe('true');
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onAreaSelect).toHaveBeenCalledWith('CN:overture:tiny');
    engine.destroy();
  });
});
