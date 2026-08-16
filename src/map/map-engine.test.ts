import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CachedBoundary, CitySummary } from '../domain/types';
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
});
