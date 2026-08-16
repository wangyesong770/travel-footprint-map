import { fireEvent, getByLabelText, getByRole, getByText, queryByText } from '@testing-library/dom';

import { createCityIndex } from '../cities/city-index';
import { sampleCities } from '../cities/sample-data';
import type { CachedBoundary } from '../domain/types';
import type { MapClick, MapEngine, MapEngineOptions, MapVisit } from '../map/map-engine';
import { createMemoryTripStore } from '../storage/memory-store';
import { createApp } from './app';
import type { AppSnapshot } from './app';

function setup() {
  document.body.innerHTML = '<main id="app"></main>';
  const root = document.querySelector<HTMLElement>('#app')!;
  const repository = createMemoryTripStore();
  let mapClick: ((point: MapClick) => void) | undefined;
  let visits: readonly MapVisit[] = [];
  const mapEngine: MapEngine = {
    setVisits(next) { visits = next; },
    getViewState: () => ({ zoom: 1, offsetX: 0, offsetY: 0 }),
    focusCity: vi.fn(),
    destroy: vi.fn(),
  };
  const boundary = vi.fn(async (): Promise<CachedBoundary | undefined> => undefined);
  const poster = vi.fn<(layout: 'landscape' | 'square', snapshot: AppSnapshot) => Promise<Blob>>(
    async () => new Blob(['png'], { type: 'image/png' }),
  );
  const saveBlob = vi.fn();
  const chooseBackupText = vi.fn(async (): Promise<string | undefined> => undefined);
  const app = createApp(root, {
    cityIndex: createCityIndex(sampleCities),
    repository,
    createMap(_svg: SVGSVGElement, options: MapEngineOptions) {
      mapClick = options.onMapClick;
      return mapEngine;
    },
    fetchBoundary: boundary,
    exportPoster: poster,
    saveBlob,
    chooseBackupText,
    now: () => '2026-08-16T00:00:00.000Z',
    attributions: ['GeoNames CC BY 4.0', 'Natural Earth public domain'],
    privacyNotice: '仅在获取边界时发送所选城市名称，不发送旅行备注。',
  });
  return { root, repository, app, boundary, poster, saveBlob, chooseBackupText, get visits() { return visits; }, clickMap: (lon: number, lat: number) => mapClick?.({ lon, lat }) };
}

describe('travel map app', () => {
  it('renders an inviting empty state and zeroed statistics', async () => {
    const view = setup();
    await view.app.ready;

    expect(getByRole(view.root, 'heading', { name: '我的世界足迹' })).toBeTruthy();
    expect(getByText(view.root, '从第一座城市开始')).toBeTruthy();
    expect(getByText(view.root, '0 座城市')).toBeTruthy();
    expect(view.root.getAttribute('aria-busy')).toBe('false');
    expect(getByText(view.root, /GeoNames CC BY 4.0/)).toBeTruthy();
    expect(getByText(view.root, /不发送旅行备注/)).toBeTruthy();
  });

  it('searches locally and immediately saves a selected city', async () => {
    const view = setup();
    await view.app.ready;
    const search = getByLabelText(view.root, '搜索城市');
    fireEvent.input(search, { target: { value: '慕尼黑' } });
    fireEvent.click(getByRole(view.root, 'button', { name: /点亮慕尼黑/ }));
    await view.app.whenIdle();

    expect((await view.repository.listVisits())[0]?.citySnapshot.name).toBe('München');
    expect(view.visits).toHaveLength(1);
    expect(getByText(view.root, '1 座城市')).toBeTruthy();
    expect(queryByText(view.root, '从第一座城市开始')).toBeNull();
    expect(view.boundary).toHaveBeenCalledOnce();
  });

  it('shows nearby candidates after a map click before lighting a city', async () => {
    const view = setup();
    await view.app.ready;
    view.clickMap(11.57, 48.14);

    expect(getByText(view.root, '选择附近城市')).toBeTruthy();
    fireEvent.click(getByRole(view.root, 'button', { name: /点亮慕尼黑/ }));
    await view.app.whenIdle();
    expect(await view.repository.listVisits()).toHaveLength(1);
  });

  it('edits a fuzzy date and plain-text note', async () => {
    const view = setup();
    await view.app.ready;
    const search = getByLabelText(view.root, '搜索城市');
    fireEvent.input(search, { target: { value: '慕尼黑' } });
    fireEvent.click(getByRole(view.root, 'button', { name: /点亮慕尼黑/ }));
    await view.app.whenIdle();

    fireEvent.click(getByRole(view.root, 'button', { name: /编辑慕尼黑/ }));
    fireEvent.input(getByLabelText(view.root, '到访时间'), { target: { value: '2024-07' } });
    fireEvent.input(getByLabelText(view.root, '旅行备注'), { target: { value: '  夏日散步  ' } });
    fireEvent.click(getByRole(view.root, 'button', { name: '保存记录' }));
    await view.app.whenIdle();

    const saved = await view.repository.getVisit(2_867_714);
    expect(saved?.visitedOn).toBe('2024-07');
    expect(saved?.datePrecision).toBe('month');
    expect(saved?.note).toBe('夏日散步');
  });

  it('offers an explicit boundary retry after the light-point fallback', async () => {
    const view = setup();
    await view.app.ready;
    fireEvent.input(getByLabelText(view.root, '搜索城市'), { target: { value: '慕尼黑' } });
    fireEvent.click(getByRole(view.root, 'button', { name: /点亮慕尼黑/ }));
    await view.app.whenIdle();
    fireEvent.click(getByRole(view.root, 'button', { name: '重试城市边界' }));
    await view.app.whenIdle();
    expect(view.boundary).toHaveBeenCalledTimes(2);
  });

  it('warns when persistence is unavailable', async () => {
    const view = setup();
    await view.app.ready;
    expect(getByText(view.root, /当前记录只保存在本次页面/)).toBeTruthy();
  });

  it('collapses and restores the responsive journal panel', async () => {
    const view = setup();
    await view.app.ready;
    fireEvent.click(getByRole(view.root, 'button', { name: '收起手账' }));
    expect(view.root.classList.contains('journal-collapsed')).toBe(true);
    expect(getByRole(view.root, 'button', { name: '展开手账' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('requires confirmation before deletion and offers undo', async () => {
    const view = setup();
    await view.app.ready;
    fireEvent.input(getByLabelText(view.root, '搜索城市'), { target: { value: '慕尼黑' } });
    fireEvent.click(getByRole(view.root, 'button', { name: /点亮慕尼黑/ }));
    await view.app.whenIdle();
    fireEvent.click(getByRole(view.root, 'button', { name: /编辑慕尼黑/ }));
    fireEvent.click(getByRole(view.root, 'button', { name: '删除这座城市' }));
    expect(await view.repository.listVisits()).toHaveLength(1);
    fireEvent.click(getByRole(view.root, 'button', { name: '确认删除' }));
    await view.app.whenIdle();
    expect(await view.repository.listVisits()).toHaveLength(0);
    fireEvent.click(getByRole(view.root, 'button', { name: '撤销删除' }));
    await view.app.whenIdle();
    expect(await view.repository.listVisits()).toHaveLength(1);
  });

  it('persists a custom title and requests both poster layouts', async () => {
    const view = setup();
    await view.app.ready;
    const title = getByLabelText(view.root, '地图标题');
    fireEvent.input(title, { target: { value: '2026 漫游记' } });
    fireEvent.change(title);
    await view.app.whenIdle();
    expect(await view.repository.getTitle()).toBe('2026 漫游记');

    fireEvent.click(getByRole(view.root, 'button', { name: '导出横版海报' }));
    fireEvent.click(getByRole(view.root, 'button', { name: '导出方形海报' }));
    await view.app.whenIdle();
    expect(view.poster.mock.calls.map(([layout]) => layout)).toEqual(['landscape', 'square']);
  });

  it('exports a complete JSON backup and lets the user choose merge import', async () => {
    const view = setup();
    await view.app.ready;
    fireEvent.click(getByRole(view.root, 'button', { name: '导出 JSON 备份' }));
    await view.app.whenIdle();
    expect(view.saveBlob.mock.calls[0]?.[1]).toMatch(/\.json$/);

    view.chooseBackupText.mockResolvedValue(JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-08-16T00:00:00.000Z',
      title: '导入足迹',
      visits: [{
        cityId: sampleCities[0]!.id,
        citySnapshot: sampleCities[0],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      boundaries: [],
    }));
    fireEvent.click(getByRole(view.root, 'button', { name: '导入 JSON 备份' }));
    await view.app.whenIdle();
    fireEvent.click(getByRole(view.root, 'button', { name: '合并导入' }));
    await view.app.whenIdle();
    expect(await view.repository.listVisits()).toHaveLength(1);
    expect(getByRole(view.root, 'heading', { name: '导入足迹' })).toBeTruthy();
  });
});
