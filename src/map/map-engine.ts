import type { CachedBoundary, CitySummary, MultiPolygonGeometry } from '../domain/types';
import type { AreaId, CityArea, CountryBoundaryPackage, CountryCode } from '../areas/types';
import { WORLD_MAP } from '../generated/world-map';
import { normalizeAntimeridian, validateGeometry } from './geometry';
import { project, unproject } from './projection';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 500;
const MIN_ZOOM = 1;
const WORLD_MAX_ZOOM = 8;
const COUNTRY_MAX_ZOOM = 4096;

export interface WorldMapLabel {
  name: string;
  x: number;
  y: number;
}

export interface WorldMapCountry {
  id: string;
  path: string;
  label?: WorldMapLabel;
}

export interface WorldMapData {
  attribution: string;
  countries: readonly WorldMapCountry[];
}

export interface MapVisit {
  city: CitySummary;
  boundary?: CachedBoundary;
}

export interface MapViewState {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface MapClick {
  lon: number;
  lat: number;
}

export interface MapEngineOptions {
  worldMap?: WorldMapData;
  onMapClick?: (point: MapClick) => void;
  onCountrySelect?: (countryCode: CountryCode) => void;
  onAreaSelect?: (areaId: AreaId) => void;
  prefersReducedMotion?: boolean;
  maxGeometryVertices?: number;
}

export interface MapEngine {
  setVisits(visits: readonly MapVisit[]): void;
  showWorld(summary?: readonly WorldCountrySummary[]): void;
  showCountry(countryPackage: CountryBoundaryPackage, visitedAreaIds: ReadonlySet<string>): void;
  getViewState(): Readonly<MapViewState>;
  focusCity(city: CitySummary): void;
  focusArea(areaId: AreaId): void;
  destroy(): void;
}

export interface WorldCountrySummary {
  readonly countryCode: CountryCode;
  readonly visitedCount: number;
}

interface PointerPosition {
  x: number;
  y: number;
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampState(state: MapViewState, maximumZoom: number): MapViewState {
  const zoom = clamp(state.zoom, MIN_ZOOM, maximumZoom);
  return {
    zoom,
    offsetX: clamp(state.offsetX, MAP_WIDTH - MAP_WIDTH * zoom, 0),
    offsetY: clamp(state.offsetY, MAP_HEIGHT - MAP_HEIGHT * zoom, 0),
  };
}

function zoomAround(state: MapViewState, nextZoom: number, anchorX: number, anchorY: number, maximumZoom: number): MapViewState {
  const zoom = clamp(nextZoom, MIN_ZOOM, maximumZoom);
  const ratio = zoom / state.zoom;
  return clampState({
    zoom,
    offsetX: anchorX - (anchorX - state.offsetX) * ratio,
    offsetY: anchorY - (anchorY - state.offsetY) * ratio,
  }, maximumZoom);
}

function eventPoint(svg: SVGSVGElement, clientX: number, clientY: number): PointerPosition {
  const rectangle = svg.getBoundingClientRect();
  if (rectangle.width <= 0 || rectangle.height <= 0) return { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
  return {
    x: (clientX - rectangle.left) / rectangle.width * MAP_WIDTH,
    y: (clientY - rectangle.top) / rectangle.height * MAP_HEIGHT,
  };
}

function geometryPath(geometry: MultiPolygonGeometry): string {
  const normalized = normalizeAntimeridian(geometry);
  return normalized.coordinates.map((polygon) => polygon.map((ring) => ring.map(([longitude, latitude], index) => {
    const point = project(longitude, latitude);
    const x = Number((point.x * MAP_WIDTH).toFixed(3));
    const y = Number((point.y * MAP_HEIGHT).toFixed(3));
    return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
  }).join('') + 'Z').join('')).join('');
}

function isSafeGeneratedPath(path: string): boolean {
  return path.length <= 1_000_000 && /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(path);
}

interface PathBounds {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
}

function pathBounds(path: string): PathBounds | undefined {
  const values = path.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/giu)?.map(Number) ?? [];
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < values.length; index += 2) {
    const x = values[index]!;
    const y = values[index + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }
  if (![minimumX, maximumX, minimumY, maximumY].every(Number.isFinite)) return undefined;
  return { minimumX, maximumX, minimumY, maximumY };
}

function pathBoundingArea(path: string): number {
  const bounds = pathBounds(path);
  if (bounds === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(bounds.maximumX - bounds.minimumX, 0) * Math.max(bounds.maximumY - bounds.minimumY, 0);
}

function markerLabel(city: CitySummary): string {
  return `已到访：${city.zhName ?? city.name}${city.zhName && city.name !== city.zhName ? ` · ${city.name}` : ''}`;
}

function areaLabel(area: CityArea): string {
  const primary = area.properties.nameZh ?? area.properties.nameLocal;
  return area.properties.nameZh && area.properties.nameLocal !== area.properties.nameZh
    ? `${primary} · ${area.properties.nameLocal}`
    : primary;
}

function isTinyArea(area: CityArea, zoom = 1): boolean {
  const polygons = area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates;
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [longitude, latitude] of ring) {
        const point = project(longitude, latitude);
        minimumX = Math.min(minimumX, point.x * MAP_WIDTH);
        maximumX = Math.max(maximumX, point.x * MAP_WIDTH);
        minimumY = Math.min(minimumY, point.y * MAP_HEIGHT);
        maximumY = Math.max(maximumY, point.y * MAP_HEIGHT);
      }
    }
  }
  return Math.max(maximumX - minimumX, maximumY - minimumY) * zoom < 4;
}

function fitAreas(areas: readonly CityArea[], setState: (state: MapViewState) => void): void {
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const area of areas) {
    const polygons = area.geometry.type === 'Polygon'
      ? [area.geometry.coordinates]
      : area.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const [longitude, latitude] of ring) {
          const point = project(longitude, latitude);
          minimumX = Math.min(minimumX, point.x * MAP_WIDTH);
          maximumX = Math.max(maximumX, point.x * MAP_WIDTH);
          minimumY = Math.min(minimumY, point.y * MAP_HEIGHT);
          maximumY = Math.max(maximumY, point.y * MAP_HEIGHT);
        }
      }
    }
  }
  if (![minimumX, maximumX, minimumY, maximumY].every(Number.isFinite)) {
    setState({ zoom: 1, offsetX: 0, offsetY: 0 });
    return;
  }
  const width = Math.max(maximumX - minimumX, 1);
  const height = Math.max(maximumY - minimumY, 1);
  const zoom = clamp(Math.min(MAP_WIDTH * 0.82 / width, MAP_HEIGHT * 0.82 / height), MIN_ZOOM, COUNTRY_MAX_ZOOM);
  setState({
    zoom,
    offsetX: MAP_WIDTH / 2 - (minimumX + maximumX) / 2 * zoom,
    offsetY: MAP_HEIGHT / 2 - (minimumY + maximumY) / 2 * zoom,
  });
}

export function createMapEngine(svg: SVGSVGElement, options: MapEngineOptions = {}): MapEngine {
  const worldMap: WorldMapData = options.worldMap ?? WORLD_MAP as unknown as WorldMapData;
  const reducedMotion = options.prefersReducedMotion
    ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ?? false;

  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
  svg.setAttribute('role', 'application');
  svg.setAttribute('aria-label', '世界旅行足迹地图，可拖动并缩放');
  svg.setAttribute('tabindex', '0');
  svg.dataset.reducedMotion = String(reducedMotion);
  svg.style.touchAction = 'none';

  const viewport = createSvgElement('g');
  viewport.dataset.mapViewport = '';
  if (!reducedMotion) viewport.style.transition = 'transform 180ms ease-out';
  const countriesLayer = createSvgElement('g');
  countriesLayer.dataset.mapCountries = '';
  const labelsLayer = createSvgElement('g');
  labelsLayer.dataset.mapLabels = '';
  const boundariesLayer = createSvgElement('g');
  boundariesLayer.dataset.mapBoundaries = '';
  const pointsLayer = createSvgElement('g');
  pointsLayer.dataset.mapPoints = '';
  viewport.append(countriesLayer, labelsLayer, boundariesLayer, pointsLayer);
  svg.append(viewport);

  // SVG hit testing prefers later siblings. Draw larger countries first so
  // microstates remain clickable where their paths overlap a neighbour.
  for (const country of [...worldMap.countries].sort((left, right) => pathBoundingArea(right.path) - pathBoundingArea(left.path))) {
    if (!/^[A-Za-z0-9-]{1,12}$/.test(country.id) || !isSafeGeneratedPath(country.path)) continue;
    const path = createSvgElement('path');
    path.dataset.country = country.id;
    path.setAttribute('d', country.path);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('tabindex', '0');
    path.setAttribute('role', 'button');
    path.setAttribute('aria-label', `进入${country.label?.name ?? country.id}`);
    countriesLayer.append(path);
    const bounds = pathBounds(country.path);
    if (bounds !== undefined && Math.max(bounds.maximumX - bounds.minimumX, bounds.maximumY - bounds.minimumY) < 8) {
      path.removeAttribute('tabindex');
      path.removeAttribute('role');
      path.removeAttribute('aria-label');
      path.setAttribute('aria-hidden', 'true');
      const hit = createSvgElement('circle');
      hit.dataset.countryHit = country.id;
      hit.setAttribute('cx', String((bounds.minimumX + bounds.maximumX) / 2));
      hit.setAttribute('cy', String((bounds.minimumY + bounds.maximumY) / 2));
      hit.setAttribute('r', '4');
      hit.setAttribute('fill', 'transparent');
      hit.setAttribute('stroke', 'none');
      hit.setAttribute('pointer-events', 'all');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', `进入${country.label?.name ?? country.id}`);
      countriesLayer.append(hit);
    }
    if (country.label
      && typeof country.label.name === 'string'
      && Number.isFinite(country.label.x)
      && Number.isFinite(country.label.y)
      && country.label.x >= 0 && country.label.x <= MAP_WIDTH
      && country.label.y >= 0 && country.label.y <= MAP_HEIGHT) {
      const label = createSvgElement('text');
      label.dataset.countryLabel = country.id;
      label.setAttribute('x', String(country.label.x));
      label.setAttribute('y', String(country.label.y));
      label.textContent = country.label.name.slice(0, 80);
      label.setAttribute('aria-hidden', 'true');
      labelsLayer.append(label);
    }
  }

  let state: MapViewState = { zoom: 1, offsetX: 0, offsetY: 0 };
  let maximumZoom = WORLD_MAX_ZOOM;
  let destroyed = false;
  let dragStart: PointerPosition | undefined;
  let stateAtDragStart: MapViewState | undefined;
  let movedDuringDrag = false;
  let suppressNextClick = false;
  const pointers = new Map<number, PointerPosition>();
  let pinchDistance: number | undefined;
  let pinchState: MapViewState | undefined;
  const areaById = new Map<AreaId, CityArea>();

  const applyTransform = (): void => {
    viewport.setAttribute('transform', `translate(${state.offsetX.toFixed(3)} ${state.offsetY.toFixed(3)}) scale(${state.zoom.toFixed(4)})`);
  };
  applyTransform();

  const setState = (nextState: MapViewState): void => {
    state = clampState(nextState, maximumZoom);
    applyTransform();
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = eventPoint(svg, event.clientX, event.clientY);
    const factor = Math.exp(-event.deltaY * 0.002);
    setState(zoomAround(state, state.zoom * factor, point.x, point.y, maximumZoom));
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(
      '[data-country], [data-country-hit], [data-area-id], [data-area-hit], [data-visited-boundary], [data-visited-point]',
    )) return;
    const pointerId = event.pointerId ?? 1;
    const point = eventPoint(svg, event.clientX, event.clientY);
    pointers.set(pointerId, point);
    dragStart = point;
    stateAtDragStart = { ...state };
    movedDuringDrag = false;
    pinchDistance = undefined;
    pinchState = undefined;
    if (typeof svg.setPointerCapture === 'function') {
      try { svg.setPointerCapture(pointerId); } catch { /* Synthetic events may not be capturable. */ }
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const pointerId = event.pointerId ?? 1;
    if (!pointers.has(pointerId)) return;
    const point = eventPoint(svg, event.clientX, event.clientY);
    pointers.set(pointerId, point);
    if (pointers.size >= 2) {
      const [first, second] = [...pointers.values()];
      if (!first || !second) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const anchor = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      if (pinchDistance === undefined || pinchState === undefined) {
        pinchDistance = Math.max(distance, 1);
        pinchState = { ...state };
      } else {
        setState(zoomAround(pinchState, pinchState.zoom * distance / pinchDistance, anchor.x, anchor.y, maximumZoom));
        movedDuringDrag = true;
      }
      return;
    }
    if (!dragStart || !stateAtDragStart) return;
    const deltaX = point.x - dragStart.x;
    const deltaY = point.y - dragStart.y;
    if (Math.hypot(deltaX, deltaY) > 3) movedDuringDrag = true;
    setState({ ...stateAtDragStart, offsetX: stateAtDragStart.offsetX + deltaX, offsetY: stateAtDragStart.offsetY + deltaY });
  };

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId ?? 1);
    suppressNextClick ||= movedDuringDrag;
    if (pointers.size === 0) {
      dragStart = undefined;
      stateAtDragStart = undefined;
      movedDuringDrag = false;
      pinchDistance = undefined;
      pinchState = undefined;
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (event.target instanceof Element) {
      const countryHit = event.target.closest<SVGElement>('[data-country-hit]');
      if (countryHit?.dataset.countryHit && /^[A-Z]{2}$/.test(countryHit.dataset.countryHit)) {
        options.onCountrySelect?.(countryHit.dataset.countryHit as CountryCode);
        return;
      }
      const area = event.target.closest<SVGElement>('[data-area-id]');
      if (area?.dataset.areaId) {
        options.onAreaSelect?.(area.dataset.areaId as AreaId);
        return;
      }
      const areaHit = event.target.closest<SVGElement>('[data-area-hit]');
      if (areaHit?.dataset.areaHit) {
        options.onAreaSelect?.(areaHit.dataset.areaHit as AreaId);
        return;
      }
      const country = event.target.closest<SVGElement>('[data-country]');
      if (country?.dataset.country && /^[A-Z]{2}$/.test(country.dataset.country)) {
        options.onCountrySelect?.(country.dataset.country as CountryCode);
        return;
      }
      if (event.target.closest('[data-visited-boundary], [data-visited-point]')) return;
    }
    const point = eventPoint(svg, event.clientX, event.clientY);
    const worldX = (point.x - state.offsetX) / state.zoom;
    const worldY = (point.y - state.offsetY) / state.zoom;
    const geographic = unproject(worldX / MAP_WIDTH, worldY / MAP_HEIGHT);
    options.onMapClick?.(geographic);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element) {
      const countryHit = event.target.closest<SVGElement>('[data-country-hit]');
      if (countryHit?.dataset.countryHit && /^[A-Z]{2}$/.test(countryHit.dataset.countryHit)) {
        event.preventDefault();
        options.onCountrySelect?.(countryHit.dataset.countryHit as CountryCode);
        return;
      }
      const area = event.target.closest<SVGElement>('[data-area-id]');
      if (area?.dataset.areaId) {
        event.preventDefault();
        options.onAreaSelect?.(area.dataset.areaId as AreaId);
        return;
      }
      const country = event.target.closest<SVGElement>('[data-country]');
      if (country?.dataset.country && /^[A-Z]{2}$/.test(country.dataset.country)) {
        event.preventDefault();
        options.onCountrySelect?.(country.dataset.country as CountryCode);
        return;
      }
    }
    const centerX = MAP_WIDTH / 2;
    const centerY = MAP_HEIGHT / 2;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setState(zoomAround(state, state.zoom * 1.25, centerX, centerY, maximumZoom));
    } else if (event.key === '-') {
      event.preventDefault();
      setState(zoomAround(state, state.zoom / 1.25, centerX, centerY, maximumZoom));
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = 40;
      setState({
        ...state,
        offsetX: state.offsetX + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0),
        offsetY: state.offsetY + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0),
      });
    }
  };

  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('click', onClick);
  svg.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  return {
    setVisits(visits): void {
      if (destroyed) return;
      boundariesLayer.replaceChildren();
      pointsLayer.replaceChildren();
      const seen = new Set<number>();
      for (const visit of visits) {
        if (seen.has(visit.city.id)) continue;
        seen.add(visit.city.id);
        let renderedBoundary = false;
        if (visit.boundary) {
          try {
            const geometry = validateGeometry(visit.boundary.geometry, { maxVertices: options.maxGeometryVertices ?? 50_000 });
            const pathData = geometryPath(geometry);
            if (pathData && isSafeGeneratedPath(pathData)) {
              const path = createSvgElement('path');
              path.dataset.visitedBoundary = String(visit.city.id);
              path.setAttribute('d', pathData);
              path.setAttribute('fill-rule', 'evenodd');
              path.setAttribute('vector-effect', 'non-scaling-stroke');
              path.setAttribute('tabindex', '0');
              path.setAttribute('role', 'button');
              path.setAttribute('aria-label', markerLabel(visit.city));
              boundariesLayer.append(path);
              renderedBoundary = true;
            }
          } catch {
            renderedBoundary = false;
          }
        }
        if (!renderedBoundary) {
          try {
            const projected = project(visit.city.lon, visit.city.lat);
            const point = createSvgElement('circle');
            point.dataset.visitedPoint = String(visit.city.id);
            point.setAttribute('cx', String(Number((projected.x * MAP_WIDTH).toFixed(3))));
            point.setAttribute('cy', String(Number((projected.y * MAP_HEIGHT).toFixed(3))));
            point.setAttribute('r', '5');
            point.setAttribute('vector-effect', 'non-scaling-stroke');
            point.setAttribute('tabindex', '0');
            point.setAttribute('role', 'button');
            point.setAttribute('aria-label', markerLabel(visit.city));
            pointsLayer.append(point);
          } catch {
            // Invalid city snapshots are ignored rather than poisoning the map.
          }
        }
      }
    },
    showWorld(summary = []): void {
      if (destroyed) return;
      maximumZoom = WORLD_MAX_ZOOM;
      areaById.clear();
      boundariesLayer.replaceChildren();
      pointsLayer.replaceChildren();
      countriesLayer.style.display = '';
      labelsLayer.style.display = '';
      svg.setAttribute('aria-label', '世界旅行足迹地图，选择国家进入城市地图');
      const countByCountry = new Map(summary.map((item) => [item.countryCode, item.visitedCount]));
      for (const country of countriesLayer.querySelectorAll<SVGPathElement>('[data-country]')) {
        const count = countByCountry.get(country.dataset.country as CountryCode) ?? 0;
        country.classList.toggle('country-visited', count > 0);
        if (count > 0) country.dataset.visitedCount = String(count);
        else delete country.dataset.visitedCount;
      }
      setState({ zoom: 1, offsetX: 0, offsetY: 0 });
    },
    showCountry(countryPackage, visitedAreaIds): void {
      if (destroyed) return;
      maximumZoom = COUNTRY_MAX_ZOOM;
      countriesLayer.style.display = 'none';
      labelsLayer.style.display = 'none';
      pointsLayer.replaceChildren();
      boundariesLayer.replaceChildren();
      areaById.clear();
      svg.setAttribute('aria-label', `${countryPackage.countryCode} ${countryPackage.administrativeScheme}地图，选择城市区域点亮`);
      fitAreas(countryPackage.features, setState);
      for (const area of countryPackage.features) {
        try {
          const geometry = validateGeometry(area.geometry, { maxVertices: options.maxGeometryVertices ?? 100_000 });
          const pathData = geometryPath(geometry);
          if (!pathData || !isSafeGeneratedPath(pathData)) continue;
          const path = createSvgElement('path');
          path.dataset.areaId = area.properties.areaId;
          path.setAttribute('d', pathData);
          path.setAttribute('fill-rule', 'evenodd');
          path.setAttribute('vector-effect', 'non-scaling-stroke');
          path.setAttribute('tabindex', '0');
          path.setAttribute('role', 'button');
          path.setAttribute('aria-label', `${visitedAreaIds.has(area.properties.areaId) ? '已点亮' : '点亮'}${areaLabel(area)}`);
          path.classList.add(visitedAreaIds.has(area.properties.areaId) ? 'area-visited' : 'area-unvisited');
          if (isTinyArea(area, state.zoom)) {
            const hit = createSvgElement('path');
            hit.dataset.areaHit = area.properties.areaId;
            hit.setAttribute('d', pathData);
            hit.setAttribute('fill', 'transparent');
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '12');
            hit.setAttribute('vector-effect', 'non-scaling-stroke');
            hit.setAttribute('aria-hidden', 'true');
            boundariesLayer.append(hit);
          }
          boundariesLayer.append(path);
          areaById.set(area.properties.areaId, area);
        } catch {
          // Runtime packages are validated before rendering; a defensive skip prevents one feature poisoning the map.
        }
      }
    },
    getViewState(): Readonly<MapViewState> {
      return Object.freeze({ ...state });
    },
    focusCity(city): void {
      if (destroyed) return;
      const location = project(city.lon, city.lat);
      const zoom = Math.max(state.zoom, 3);
      setState({
        zoom,
        offsetX: MAP_WIDTH / 2 - location.x * MAP_WIDTH * zoom,
        offsetY: MAP_HEIGHT / 2 - location.y * MAP_HEIGHT * zoom,
      });
    },
    focusArea(areaId): void {
      if (destroyed) return;
      const area = areaById.get(areaId);
      if (!area) return;
      const path = [...boundariesLayer.querySelectorAll<SVGPathElement>('[data-area-id]')]
        .find((candidate) => candidate.dataset.areaId === areaId);
      path?.focus();
      const location = project(area.properties.centroid[0], area.properties.centroid[1]);
      const zoom = Math.max(state.zoom, 4);
      setState({
        zoom,
        offsetX: MAP_WIDTH / 2 - location.x * MAP_WIDTH * zoom,
        offsetY: MAP_HEIGHT / 2 - location.y * MAP_HEIGHT * zoom,
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('click', onClick);
      svg.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
      if (typeof svg.releasePointerCapture === 'function') {
        for (const pointerId of pointers.keys()) {
          try { svg.releasePointerCapture(pointerId); } catch { /* Pointer may already be released. */ }
        }
      }
      pointers.clear();
      dragStart = undefined;
      stateAtDragStart = undefined;
    },
  };
}
