import type { CachedBoundary, TravelStats, VisitRecord } from '../domain/types';
import { composePosterSvg, exportPosterPng, type PosterInput } from './poster';

const visit = (cityId: number, lon: number, lat: number): VisitRecord => ({
  cityId,
  citySnapshot: {
    id: cityId,
    name: `City ${cityId}`,
    asciiName: `City ${cityId}`,
    aliases: [],
    countryCode: 'CN',
    continentCode: 'AS',
    lon,
    lat,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  note: '绝不能进入海报 <script>alert(1)</script>',
});

const boundary = (cityId: number): CachedBoundary => ({
  cityId,
  geometry: {
    type: 'MultiPolygon',
    coordinates: [[[[120, 30], [121, 30], [121, 31], [120, 30]]]],
  },
  source: 'fixture',
  fetchedAt: '2026-01-01T00:00:00.000Z',
});

const stats: TravelStats = { cityCount: 2, countryCount: 1, continentCounts: { AS: 2 } };
const input = (overrides: Partial<PosterInput> = {}): PosterInput => ({
  title: '我的世界足迹',
  stats,
  visits: [visit(1, 120.5, 30.5), visit(2, 2.35, 48.86)],
  boundaries: [boundary(1)],
  ...overrides,
});

describe('composePosterSvg', () => {
  it.each([
    ['landscape', 1600, 1000],
    ['square', 1200, 1200],
  ] as const)('composes a %s poster at exact dimensions', (format, width, height) => {
    const svg = composePosterSvg(input(), format);
    expect(svg).toContain(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`);
    expect(svg).toContain('我的世界足迹');
    expect(svg).toContain('2 座城市');
    expect(svg).toContain('1 个国家/地区');
    expect(svg).toContain('data-layer="world-map"');
    expect(svg).toContain('data-layer="visited-boundaries"');
    expect(svg).toContain('data-layer="fallback-points"');
    expect(svg).not.toContain('绝不能进入海报');
    expect(svg).not.toContain('button');
  });

  it('handles an empty map and truncates/escapes a malicious long title', () => {
    const title = `<script>\u0000alert('x')</script>${'旅行'.repeat(40)}`;
    const svg = composePosterSvg(input({ title, visits: [], boundaries: [], stats: { cityCount: 0, countryCount: 0, continentCounts: {} } }), 'square');
    expect(svg).toContain('0 座城市');
    expect(svg).toContain('…');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('\u0000');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('data-city-id=');
  });

  it('normalizes an antimeridian boundary without drawing a world-spanning segment', () => {
    const dateline: CachedBoundary = {
      ...boundary(1),
      geometry: { type: 'MultiPolygon', coordinates: [[[[179, 10], [-179, 10], [-179, 11], [179, 10]]]] },
    };
    const svg = composePosterSvg(input({ visits: [visit(1, 179.5, 10)], boundaries: [dateline] }), 'landscape');
    expect(svg).toContain('data-city-id="1"');
    expect(svg).not.toContain('NaN');
  });
});

describe('exportPosterPng', () => {
  function dependencies(mode: 'load' | 'image-error' | 'blob-error' = 'load') {
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:poster');
    const drawImage = vi.fn();
    const image = {} as HTMLImageElement;
    Object.defineProperty(image, 'src', {
      set() { queueMicrotask(() => mode === 'image-error' ? image.onerror?.(new Event('error')) : image.onload?.(new Event('load'))); },
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: BlobCallback) => callback(mode === 'blob-error' ? null : new Blob(['png'], { type: 'image/png' }))),
    } as unknown as HTMLCanvasElement;
    return {
      deps: {
        createImage: () => image,
        createCanvas: () => canvas,
        url: { createObjectURL, revokeObjectURL },
      },
      canvas,
      drawImage,
      revokeObjectURL,
    };
  }

  it('converts SVG to PNG and always revokes its object URL', async () => {
    const fixture = dependencies();
    const result = await exportPosterPng(input(), 'landscape', fixture.deps);
    expect(result.type).toBe('image/png');
    expect(fixture.canvas.width).toBe(1600);
    expect(fixture.canvas.height).toBe(1000);
    expect(fixture.drawImage).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:poster');
  });

  it.each([
    ['image-error', '海报图片加载失败'],
    ['blob-error', '海报 PNG 生成失败'],
  ] as const)('localizes %s and revokes the URL', async (mode, message) => {
    const fixture = dependencies(mode);
    await expect(exportPosterPng(input(), 'square', fixture.deps)).rejects.toThrow(message);
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:poster');
  });

  it('revokes the URL and localizes an Image construction failure', async () => {
    const fixture = dependencies();
    fixture.deps.createImage = () => { throw new Error('constructor failed'); };
    await expect(exportPosterPng(input(), 'square', fixture.deps)).rejects.toThrow('海报导出失败');
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:poster');
  });
});
