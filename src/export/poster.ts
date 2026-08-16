import type { CachedBoundary, TravelStats, VisitRecord } from '../domain/types';
import { WORLD_MAP } from '../generated/world-map';
import { normalizeAntimeridian } from '../map/geometry';
import { project } from '../map/projection';

export type PosterFormat = 'landscape' | 'square';

export interface PosterInput {
  title: string;
  stats: TravelStats;
  visits: readonly VisitRecord[];
  boundaries: readonly CachedBoundary[];
}

export interface PosterDependencies {
  createImage: () => HTMLImageElement;
  createCanvas: () => HTMLCanvasElement;
  url: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

interface PosterLayout {
  width: number;
  height: number;
  mapX: number;
  mapY: number;
  mapWidth: number;
  mapHeight: number;
  titleY: number;
  statsY: number;
}

const layouts: Record<PosterFormat, PosterLayout> = {
  landscape: {
    width: 1600,
    height: 1000,
    mapX: 80,
    mapY: 250,
    mapWidth: 1440,
    mapHeight: 720,
    titleY: 112,
    statsY: 184,
  },
  square: {
    width: 1200,
    height: 1200,
    mapX: 60,
    mapY: 330,
    mapWidth: 1080,
    mapHeight: 540,
    titleY: 126,
    statsY: 210,
  },
};

const continentNames: Record<string, string> = {
  AF: '非洲', AN: '南极洲', AS: '亚洲', EU: '欧洲', NA: '北美洲', OC: '大洋洲', SA: '南美洲',
};

function escapeXml(value: string): string {
  const validXml = [...value].filter((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D
      || (codePoint >= 0x20 && codePoint <= 0xD7FF)
      || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
      || (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
  }).join('');
  return validXml.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

function truncate(value: string, maximumCodePoints: number): string {
  const points = [...value.trim()];
  if (points.length <= maximumCodePoints) return points.join('');
  return `${points.slice(0, maximumCodePoints - 1).join('')}…`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Math.max(0, Math.trunc(value))) : '0';
}

function composeStats(stats: TravelStats): string {
  const continents = Object.entries(stats.continentCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${continentNames[code] ?? code} ${formatNumber(count)}`)
    .join(' · ');
  const summary = `${formatNumber(stats.cityCount)} 座城市  ·  ${formatNumber(stats.countryCount)} 个国家/地区`;
  return continents.length > 0 ? `${summary}  ·  ${continents}` : summary;
}

function geometryPath(boundary: CachedBoundary): string {
  const normalized = normalizeAntimeridian(boundary.geometry);
  const commands: string[] = [];
  for (const polygon of normalized.coordinates) {
    for (const ring of polygon) {
      ring.forEach(([longitude, latitude], index) => {
        const point = project(longitude, latitude);
        commands.push(`${index === 0 ? 'M' : 'L'}${(point.x * 1000).toFixed(2)} ${(point.y * 500).toFixed(2)}`);
      });
      commands.push('Z');
    }
  }
  return commands.join('');
}

function worldLayer(): string {
  const countries = WORLD_MAP.countries.map((country) => (
    `<path d="${country.path}" data-country="${escapeXml(country.id)}"/>`
  )).join('');
  const labels = WORLD_MAP.countries.flatMap((country) => (
    'label' in country && country.label
      ? [`<text x="${country.label.x}" y="${country.label.y}">${escapeXml(country.label.name)}</text>`]
      : []
  )).join('');
  return `<g data-layer="world-map" class="countries">${countries}</g><g class="country-labels">${labels}</g>`;
}

function visitedLayers(input: PosterInput): string {
  const visitsById = new Map(input.visits.map((visit) => [visit.cityId, visit]));
  const renderedBoundaries = new Set<number>();
  const paths: string[] = [];
  for (const boundary of input.boundaries) {
    if (!visitsById.has(boundary.cityId) || renderedBoundaries.has(boundary.cityId)) continue;
    const path = geometryPath(boundary);
    if (path.length === 0) continue;
    renderedBoundaries.add(boundary.cityId);
    paths.push(`<path data-city-id="${boundary.cityId}" d="${path}"/>`);
  }
  const points = input.visits.flatMap((visit) => {
    if (renderedBoundaries.has(visit.cityId)) return [];
    const point = project(visit.citySnapshot.lon, visit.citySnapshot.lat);
    return [`<circle data-city-id="${visit.cityId}" cx="${(point.x * 1000).toFixed(2)}" cy="${(point.y * 500).toFixed(2)}" r="4.5"/>`];
  });
  return `<g data-layer="visited-boundaries" class="visited">${paths.join('')}</g><g data-layer="fallback-points" class="points">${points.join('')}</g>`;
}

/** Creates a deterministic, self-contained SVG without notes or interactive UI. */
export function composePosterSvg(input: PosterInput, format: PosterFormat): string {
  const layout = layouts[format];
  const title = escapeXml(truncate(input.title || '我的世界足迹', 36));
  const statistics = escapeXml(composeStats(input.stats));
  const scale = layout.mapWidth / 1000;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${title}">
<defs>
  <pattern id="paper" width="36" height="36" patternUnits="userSpaceOnUse"><rect width="36" height="36" fill="#F8F2E7"/><circle cx="5" cy="8" r="0.7" fill="#D7CDBB" opacity=".22"/><circle cx="27" cy="25" r="0.55" fill="#D7CDBB" opacity=".18"/></pattern>
  <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#304A49" flood-opacity=".13"/></filter>
</defs>
<rect width="100%" height="100%" fill="url(#paper)"/>
<text x="${layout.width / 2}" y="${layout.titleY}" text-anchor="middle" class="title">${title}</text>
<path d="M${layout.width / 2 - 88} ${layout.titleY + 20} Q${layout.width / 2} ${layout.titleY + 34} ${layout.width / 2 + 88} ${layout.titleY + 20}" class="thread"/>
<text x="${layout.width / 2}" y="${layout.statsY}" text-anchor="middle" class="stats">${statistics}</text>
<g transform="translate(${layout.mapX} ${layout.mapY}) scale(${scale})" filter="url(#soft-shadow)">
  <rect width="1000" height="500" rx="22" fill="#DDE9E7"/>
  ${worldLayer()}
  ${visitedLayers(input)}
</g>
<text x="${layout.width - 42}" y="${layout.height - 26}" text-anchor="end" class="attribution">底图：${escapeXml(WORLD_MAP.attribution)}</text>
<style>
  .title{font:700 54px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:#304A49;letter-spacing:2px}.stats{font:500 22px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:#617873}.thread{fill:none;stroke:#D5A54A;stroke-width:4;stroke-linecap:round;stroke-dasharray:10 11}.countries path{fill:#EEF0E7;stroke:#9BB0AA;stroke-width:.65;vector-effect:non-scaling-stroke}.country-labels{font:500 7px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:#708581;text-anchor:middle;opacity:.72;pointer-events:none}.visited path{fill:#EA765F;fill-opacity:.78;stroke:#C95D4B;stroke-width:1.1;fill-rule:evenodd;vector-effect:non-scaling-stroke}.points circle{fill:#EA765F;stroke:#FFF8ED;stroke-width:2;vector-effect:non-scaling-stroke}.attribution{font:400 13px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:#7F908B}
</style>
</svg>`;
}

function defaultDependencies(): PosterDependencies {
  return {
    createImage: () => new Image(),
    createCanvas: () => document.createElement('canvas'),
    url: URL,
  };
}

function waitForImage(image: HTMLImageElement, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('海报图片加载失败'));
    image.src = source;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('海报 PNG 生成失败')), 'image/png');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'SecurityError') {
        reject(new Error('海报导出失败：画布受浏览器安全策略限制'));
      } else {
        reject(new Error('海报 PNG 生成失败'));
      }
    }
  });
}

/** Converts the self-contained SVG into a PNG Blob and releases all temporary URLs. */
export async function exportPosterPng(
  input: PosterInput,
  format: PosterFormat,
  dependencies: PosterDependencies = defaultDependencies(),
): Promise<Blob> {
  const layout = layouts[format];
  const svg = composePosterSvg(input, format);
  let source: string;
  try {
    source = dependencies.url.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  } catch {
    throw new Error('海报导出失败：无法创建临时图片');
  }
  let image: HTMLImageElement | undefined;
  try {
    image = dependencies.createImage();
    await waitForImage(image, source);
    const canvas = dependencies.createCanvas();
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持海报导出');
    try {
      context.drawImage(image, 0, 0, layout.width, layout.height);
    } catch {
      throw new Error('海报绘制失败');
    }
    return await canvasBlob(canvas);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('海报') || error.message.startsWith('当前浏览器'))) throw error;
    throw new Error('海报导出失败', { cause: error });
  } finally {
    if (image) {
      image.onload = null;
      image.onerror = null;
    }
    try { dependencies.url.revokeObjectURL(source); } catch { /* best-effort release */ }
  }
}
