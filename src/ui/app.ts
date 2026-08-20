import type { CityIndex } from '../cities/city-index';
import type { CountryPackageLoadResult } from '../areas/country-package-service';
import type { AreaId, CountryBoundaryPackage, CountryCode } from '../areas/types';
import { sanitizeNote, validateVisitDate } from '../domain/validation';
import type { CachedBoundary, CitySummary, TravelStats, VisitRecord, VisitV2 } from '../domain/types';
import type { MapClick, MapEngine, MapEngineOptions, MapVisit } from '../map/map-engine';
import { exportBackup, parseBackup } from '../storage/backup';
import { calculateStats } from '../storage/statistics';
import type { TripRepository } from '../storage/trip-store';

export interface AppDependencies {
  cityIndex: CityIndex;
  repository: TripRepository;
  createMap(svg: SVGSVGElement, options: MapEngineOptions): MapEngine;
  fetchBoundary(city: CitySummary, signal: AbortSignal): Promise<CachedBoundary | undefined>;
  loadCountry(countryCode: CountryCode, signal: AbortSignal): Promise<CountryPackageLoadResult>;
  exportPoster(layout: 'landscape' | 'square', snapshot: AppSnapshot): Promise<Blob>;
  saveBlob?: (blob: Blob, filename: string) => void;
  chooseBackupText?: () => Promise<string | undefined>;
  now?: () => string;
  attributions?: readonly string[];
  privacyNotice?: string;
}

export interface AppSnapshot {
  title: string;
  visits: VisitRecord[];
  boundaries: CachedBoundary[];
  stats: TravelStats;
}

export interface TravelMapApp {
  ready: Promise<void>;
  whenIdle(): Promise<void>;
  destroy(): void;
}

interface AppElements {
  heading: HTMLHeadingElement;
  title: HTMLInputElement;
  stats: HTMLElement;
  search: HTMLInputElement;
  searchResults: HTMLElement;
  nearby: HTMLElement;
  visitList: HTMLElement;
  editor: HTMLElement;
  actions: HTMLElement;
  importDialog: HTMLElement;
  undo: HTMLElement;
  empty: HTMLElement;
  status: HTMLElement;
  attribution: HTMLElement;
  navigation: HTMLElement;
  map: SVGSVGElement;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function button(label: string, className?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

function cityDisplayName(city: CitySummary): string {
  const primary = city.zhName ?? city.name;
  return city.zhName && city.name !== city.zhName ? `${primary} · ${city.name}` : primary;
}

function appendCityButton(container: HTMLElement, city: CitySummary, onSelect: () => void): void {
  const item = document.createElement('li');
  const action = button(`点亮${city.zhName ?? city.name}`, 'city-option');
  const name = document.createElement('strong');
  name.textContent = cityDisplayName(city);
  const location = document.createElement('small');
  location.textContent = [city.admin1, city.countryCode].filter(Boolean).join(' · ');
  action.replaceChildren(name, location);
  action.setAttribute('aria-label', `点亮${city.zhName ?? city.name}，${location.textContent}`);
  action.addEventListener('click', onSelect);
  item.append(action);
  container.append(item);
}

function buildShell(root: HTMLElement): AppElements {
  root.className = 'travel-app';
  const header = document.createElement('header');
  header.className = 'app-header';
  const heading = document.createElement('h1');
  heading.className = 'map-heading';
  const title = document.createElement('input');
  title.className = 'map-title';
  title.setAttribute('aria-label', '地图标题');
  title.maxLength = 120;
  const stats = document.createElement('div');
  stats.className = 'stats-strip';
  header.append(heading, title, stats);

  const workspace = document.createElement('div');
  workspace.className = 'workspace';
  const mapStage = document.createElement('section');
  mapStage.className = 'map-stage';
  mapStage.setAttribute('aria-label', '旅行地图');
  const map = document.createElementNS(SVG_NAMESPACE, 'svg');
  map.classList.add('world-map');
  const navigation = document.createElement('div');
  navigation.className = 'map-navigation';
  const empty = document.createElement('div');
  empty.className = 'empty-invitation';
  empty.textContent = '从第一座城市开始';
  mapStage.append(navigation, map, empty);

  const journal = document.createElement('aside');
  journal.className = 'journal-panel';
  journal.id = 'travel-journal';
  journal.setAttribute('aria-label', '旅行手账');
  const journalToggle = button('收起手账', 'journal-toggle');
  journalToggle.setAttribute('aria-controls', journal.id);
  journalToggle.setAttribute('aria-expanded', 'true');
  journalToggle.addEventListener('click', () => {
    const collapsed = root.classList.toggle('journal-collapsed');
    journalToggle.textContent = collapsed ? '展开手账' : '收起手账';
    journalToggle.setAttribute('aria-expanded', String(!collapsed));
  });
  const searchLabel = document.createElement('label');
  searchLabel.textContent = '搜索一座去过的城市';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '输入中文、英文或当地名称';
  search.autocomplete = 'off';
  search.maxLength = 100;
  search.setAttribute('aria-label', '搜索城市');
  searchLabel.append(search);
  const searchResults = document.createElement('ul');
  searchResults.className = 'city-results';
  const nearby = document.createElement('section');
  nearby.className = 'nearby-panel';
  const visitList = document.createElement('section');
  visitList.className = 'visit-list';
  const editor = document.createElement('section');
  editor.className = 'visit-editor';
  const actions = document.createElement('div');
  actions.className = 'data-actions';
  const importDialog = document.createElement('section');
  importDialog.className = 'import-dialog';
  const undo = document.createElement('div');
  undo.className = 'undo-action';
  const status = document.createElement('p');
  status.className = 'app-status';
  status.setAttribute('role', 'status');
  const attribution = document.createElement('footer');
  attribution.className = 'data-attribution';
  journal.append(journalToggle, searchLabel, searchResults, nearby, visitList, editor, actions, importDialog, undo, status, attribution);
  workspace.append(mapStage, journal);
  root.replaceChildren(header, workspace);
  return { heading, title, stats, search, searchResults, nearby, visitList, editor, actions, importDialog, undo, empty, status, attribution, navigation, map };
}

export function createApp(root: HTMLElement, dependencies: AppDependencies): TravelMapApp {
  root.setAttribute('aria-busy', 'true');
  const elements = buildShell(root);
  const now = dependencies.now ?? (() => new Date().toISOString());
  let title = '我的世界足迹';
  let visits: VisitRecord[] = [];
  let areaVisits: VisitV2[] = [];
  let boundaries: CachedBoundary[] = [];
  let selectedCityId: number | undefined;
  let selectedAreaId: AreaId | undefined;
  let deletionPending = false;
  let lastDeleted: { visit: VisitRecord; boundary?: CachedBoundary } | undefined;
  let pendingImport: ReturnType<typeof parseBackup> | undefined;
  let activeCountry: CountryBoundaryPackage | undefined;
  let confirmingReplace = false;
  let destroyed = false;
  const pending = new Set<Promise<unknown>>();
  const abortController = new AbortController();
  const mapEngine = dependencies.createMap(elements.map, {
    onMapClick: (point) => {
      if (activeCountry === undefined) showNearby(point);
    },
    onCountrySelect: (countryCode) => void track(enterCountry(countryCode)),
    onAreaSelect: (areaId) => void track(selectArea(areaId)),
  });

  const attributionText = (dependencies.attributions ?? []).filter(Boolean).join(' · ');
  if (attributionText) {
    const sources = document.createElement('p');
    sources.textContent = `数据来源：${attributionText}`;
    elements.attribution.append(sources);
  }
  if (dependencies.privacyNotice) {
    const privacy = document.createElement('p');
    privacy.textContent = dependencies.privacyNotice;
    elements.attribution.append(privacy);
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
    return operation;
  }

  function mapVisits(): MapVisit[] {
    const boundaryByCity = new Map(boundaries.map((boundary) => [boundary.cityId, boundary]));
    return visits.map((visit) => {
      const boundary = boundaryByCity.get(visit.cityId);
      return boundary ? { city: visit.citySnapshot, boundary } : { city: visit.citySnapshot };
    });
  }

  function setStatus(message: string, kind: 'normal' | 'error' = 'normal'): void {
    elements.status.textContent = message;
    elements.status.dataset.kind = kind;
  }

  function renderNavigation(): void {
    elements.navigation.replaceChildren();
    if (activeCountry === undefined) return;
    const back = button('返回世界地图', 'map-back');
    back.addEventListener('click', () => {
      activeCountry = undefined;
      render();
      setStatus('已返回世界地图');
    });
    const label = document.createElement('strong');
    label.textContent = `${activeCountry.countryCode} · ${activeCountry.administrativeScheme}`;
    elements.navigation.append(back, label);
  }

  async function enterCountry(countryCode: CountryCode): Promise<void> {
    setStatus(`正在加载 ${countryCode} 的城市边界`);
    const result = await dependencies.loadCountry(countryCode, abortController.signal);
    if (result.status === 'unavailable') {
      setStatus(`该国家的城市边界尚未发布（${result.reason.kind}）`, 'error');
      return;
    }
    activeCountry = result.package;
    elements.nearby.replaceChildren();
    elements.searchResults.replaceChildren();
    render();
    setStatus(`已进入 ${countryCode}，点击城市区域即可点亮`);
  }

  async function selectArea(areaId: AreaId): Promise<void> {
    if (activeCountry === undefined) return;
    const area = activeCountry.features.find((candidate) => candidate.properties.areaId === areaId);
    if (area === undefined) {
      setStatus('所选城市不属于当前国家地图', 'error');
      return;
    }
    let visit = areaVisits.find((candidate) => candidate.areaId === areaId);
    if (visit === undefined) {
      const timestamp = now();
      visit = {
        areaId,
        areaSnapshot: {
          areaId,
          countryCode: area.properties.countryCode,
          sourceId: area.properties.sourceId,
          adminLevel: area.properties.adminLevel,
          ...(area.properties.nameZh === undefined ? {} : { nameZh: area.properties.nameZh }),
          nameLocal: area.properties.nameLocal,
          aliases: [...area.properties.aliases],
          centroid: [area.properties.centroid[0], area.properties.centroid[1]],
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await dependencies.repository.putAreaVisit(visit);
      areaVisits = [...areaVisits, visit];
    }
    selectedCityId = undefined;
    selectedAreaId = areaId;
    render();
    mapEngine.focusArea(areaId);
    setStatus(`${area.properties.nameZh ?? area.properties.nameLocal}已点亮，可填写日期和备注`);
  }

  function renderStats(): void {
    const stats = calculateStats(visits);
    const areaCountries = new Set(areaVisits.map((visit) => visit.areaSnapshot.countryCode));
    const legacyCountries = new Set(visits.map((visit) => visit.citySnapshot.countryCode));
    const continents = Object.keys(stats.continentCounts).length;
    elements.stats.replaceChildren();
    for (const value of [`${stats.cityCount + areaVisits.length} 座城市`, `${new Set([...areaCountries, ...legacyCountries]).size} 个国家/地区`, `${continents} 个大洲`]) {
      const badge = document.createElement('span');
      badge.textContent = value;
      elements.stats.append(badge);
    }
  }

  function renderVisits(): void {
    const hasVisits = visits.length + areaVisits.length > 0;
    elements.empty.hidden = hasVisits;
    elements.empty.textContent = hasVisits ? '' : '从第一座城市开始';
    elements.visitList.replaceChildren();
    if (!hasVisits) return;
    const heading = document.createElement('h2');
    heading.textContent = '最近足迹';
    const list = document.createElement('ul');
    for (const visit of [...areaVisits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const item = document.createElement('li');
      const name = visit.areaSnapshot.nameZh && visit.areaSnapshot.nameZh !== visit.areaSnapshot.nameLocal
        ? `${visit.areaSnapshot.nameZh} · ${visit.areaSnapshot.nameLocal}`
        : visit.areaSnapshot.nameZh ?? visit.areaSnapshot.nameLocal;
      const edit = button(`编辑${visit.areaSnapshot.nameZh ?? visit.areaSnapshot.nameLocal}`);
      edit.className = 'visit-card';
      edit.setAttribute('aria-label', `编辑${visit.areaSnapshot.nameZh ?? visit.areaSnapshot.nameLocal}`);
      const strong = document.createElement('strong');
      strong.textContent = name;
      const meta = document.createElement('small');
      meta.textContent = [visit.visitedOn, visit.areaSnapshot.countryCode].filter(Boolean).join(' · ');
      edit.replaceChildren(strong, meta);
      edit.addEventListener('click', () => {
        selectedCityId = undefined;
        selectedAreaId = visit.areaId;
        renderEditor();
        mapEngine.focusArea(visit.areaId);
      });
      item.append(edit);
      list.append(item);
    }
    for (const visit of [...visits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const item = document.createElement('li');
      const edit = button(`编辑${visit.citySnapshot.zhName ?? visit.citySnapshot.name}`);
      edit.className = 'visit-card';
      edit.setAttribute('aria-label', `编辑${visit.citySnapshot.zhName ?? visit.citySnapshot.name}`);
      const name = document.createElement('strong');
      name.textContent = cityDisplayName(visit.citySnapshot);
      const meta = document.createElement('small');
      meta.textContent = [visit.visitedOn, visit.citySnapshot.countryCode].filter(Boolean).join(' · ');
      edit.replaceChildren(name, meta);
      edit.addEventListener('click', () => {
        selectedCityId = visit.cityId;
        renderEditor();
        mapEngine.focusCity(visit.citySnapshot);
      });
      item.append(edit);
      list.append(item);
    }
    elements.visitList.append(heading, list);
  }

  function renderEditor(): void {
    elements.editor.replaceChildren();
    const areaVisit = areaVisits.find((candidate) => candidate.areaId === selectedAreaId);
    if (areaVisit !== undefined) {
      renderAreaEditor(areaVisit);
      return;
    }
    const visit = visits.find((candidate) => candidate.cityId === selectedCityId);
    if (!visit) return;
    const heading = document.createElement('h2');
    heading.textContent = cityDisplayName(visit.citySnapshot);
    const dateLabel = document.createElement('label');
    dateLabel.textContent = '到访时间';
    const date = document.createElement('input');
    date.value = visit.visitedOn ?? '';
    date.placeholder = '例如 2024、2024-07 或 2024-07-16';
    date.setAttribute('aria-label', '到访时间');
    dateLabel.append(date);
    const noteLabel = document.createElement('label');
    noteLabel.textContent = '旅行备注';
    const note = document.createElement('textarea');
    note.value = visit.note ?? '';
    note.maxLength = 1000;
    note.setAttribute('aria-label', '旅行备注');
    noteLabel.append(note);
    const save = button('保存记录', 'primary-action');
    save.addEventListener('click', () => {
      void track((async () => {
        try {
          const noteValue = sanitizeNote(note.value);
          const dateValue = date.value.trim();
          const next: VisitRecord = { ...visit, updatedAt: now() };
          if (dateValue) {
            const validated = validateVisitDate(dateValue);
            next.visitedOn = validated.value;
            next.datePrecision = validated.precision;
          } else {
            delete next.visitedOn;
            delete next.datePrecision;
          }
          if (noteValue) next.note = noteValue;
          else delete next.note;
          await dependencies.repository.putVisit(next);
          visits = visits.map((candidate) => candidate.cityId === next.cityId ? next : candidate);
          render();
          setStatus('记录已保存');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : '记录保存失败', 'error');
        }
      })());
    });
    const remove = button('删除这座城市', 'danger-action');
    remove.addEventListener('click', () => {
      deletionPending = true;
      renderEditor();
    });
    elements.editor.append(heading, dateLabel, noteLabel, save);
    if (!boundaries.some((boundary) => boundary.cityId === visit.cityId)) {
      const retry = button('重试城市边界');
      retry.addEventListener('click', () => void track(fetchAndStoreBoundary(visit.citySnapshot)));
      elements.editor.append(retry);
    }
    elements.editor.append(remove);
    if (deletionPending) {
      const warning = document.createElement('p');
      warning.textContent = '删除后可在本次页面内撤销。';
      const confirm = button('确认删除', 'danger-action');
      const cancel = button('取消');
      confirm.addEventListener('click', () => void track(deleteSelected(visit)));
      cancel.addEventListener('click', () => {
        deletionPending = false;
        renderEditor();
      });
      elements.editor.append(warning, confirm, cancel);
    }
  }

  function renderAreaEditor(visit: VisitV2): void {
    const displayName = visit.areaSnapshot.nameZh && visit.areaSnapshot.nameZh !== visit.areaSnapshot.nameLocal
      ? `${visit.areaSnapshot.nameZh} · ${visit.areaSnapshot.nameLocal}`
      : visit.areaSnapshot.nameZh ?? visit.areaSnapshot.nameLocal;
    const heading = document.createElement('h2');
    heading.textContent = displayName;
    const dateLabel = document.createElement('label');
    dateLabel.textContent = '到访时间';
    const date = document.createElement('input');
    date.value = visit.visitedOn ?? '';
    date.placeholder = '例如 2024、2024-07 或 2024-07-16';
    date.setAttribute('aria-label', '到访时间');
    dateLabel.append(date);
    const noteLabel = document.createElement('label');
    noteLabel.textContent = '旅行备注';
    const note = document.createElement('textarea');
    note.value = visit.note ?? '';
    note.maxLength = 500;
    note.setAttribute('aria-label', '旅行备注');
    noteLabel.append(note);
    const save = button('保存记录', 'primary-action');
    save.addEventListener('click', () => void track((async () => {
      try {
        const dateValue = date.value.trim();
        const noteValue = sanitizeNote(note.value);
        const dateFields = dateValue ? validateVisitDate(dateValue) : undefined;
        const next: VisitV2 = {
          ...visit,
          updatedAt: now(),
          ...(dateFields === undefined ? {} : { visitedOn: dateFields.value, datePrecision: dateFields.precision }),
          ...(noteValue ? { note: noteValue } : {}),
        };
        if (dateFields === undefined) {
          delete (next as { visitedOn?: string }).visitedOn;
          delete (next as { datePrecision?: string }).datePrecision;
        }
        if (!noteValue) delete (next as { note?: string }).note;
        await dependencies.repository.putAreaVisit(next);
        areaVisits = areaVisits.map((candidate) => candidate.areaId === next.areaId ? next : candidate);
        render();
        setStatus('记录已保存');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '记录保存失败', 'error');
      }
    })()));
    elements.editor.append(heading, dateLabel, noteLabel, save);
  }

  async function deleteSelected(visit: VisitRecord): Promise<void> {
    const boundary = boundaries.find((candidate) => candidate.cityId === visit.cityId);
    await dependencies.repository.deleteVisit(visit.cityId);
    if (boundary) await dependencies.repository.deleteBoundary(visit.cityId);
    lastDeleted = boundary ? { visit, boundary } : { visit };
    visits = visits.filter((candidate) => candidate.cityId !== visit.cityId);
    boundaries = boundaries.filter((candidate) => candidate.cityId !== visit.cityId);
    selectedCityId = undefined;
    deletionPending = false;
    render();
    renderUndo();
    setStatus('城市已删除');
  }

  function renderUndo(): void {
    elements.undo.replaceChildren();
    if (!lastDeleted) return;
    const undo = button('撤销删除');
    undo.addEventListener('click', () => void track((async () => {
      if (!lastDeleted) return;
      const restored = lastDeleted;
      await dependencies.repository.putVisit(restored.visit);
      if (restored.boundary) await dependencies.repository.putBoundary(restored.boundary);
      visits = [...visits, restored.visit];
      if (restored.boundary) boundaries = [...boundaries, restored.boundary];
      lastDeleted = undefined;
      render();
      renderUndo();
      setStatus('删除已撤销');
    })()));
    elements.undo.append(undo);
  }

  function snapshot(): AppSnapshot {
    return {
      title,
      visits: structuredClone(visits),
      boundaries: structuredClone(boundaries),
      stats: calculateStats(visits),
    };
  }

  function downloadBlob(blob: Blob, filename: string): void {
    if (dependencies.saveBlob) {
      dependencies.saveBlob(blob, filename);
      return;
    }
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function chooseJsonFile(): Promise<string | undefined> {
    if (dependencies.chooseBackupText) return dependencies.chooseBackupText();
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.hidden = true;
      let settled = false;
      const finish = (value?: string): void => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(value);
      };
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) finish();
        else void file.text().then(finish, () => finish());
      }, { once: true });
      window.addEventListener('focus', () => window.setTimeout(() => {
        if (!input.files?.length) finish();
      }, 300), { once: true });
      document.body.append(input);
      input.click();
    });
  }

  function renderImportDialog(): void {
    elements.importDialog.replaceChildren();
    if (!pendingImport) return;
    const message = document.createElement('p');
    message.textContent = `备份包含 ${pendingImport.visits.length + (pendingImport.areaVisits?.length ?? 0)} 座城市，请选择导入方式。`;
    const merge = button('合并导入', 'primary-action');
    merge.addEventListener('click', () => void track(applyImport('merge')));
    const replace = button(confirmingReplace ? '确认替换现有数据' : '替换导入', 'danger-action');
    replace.addEventListener('click', () => {
      if (!confirmingReplace) {
        confirmingReplace = true;
        renderImportDialog();
      } else {
        void track(applyImport('replace'));
      }
    });
    const cancel = button('取消导入');
    cancel.addEventListener('click', () => {
      pendingImport = undefined;
      confirmingReplace = false;
      renderImportDialog();
    });
    elements.importDialog.append(message, merge, replace, cancel);
  }

  async function applyImport(mode: 'merge' | 'replace'): Promise<void> {
    if (!pendingImport) return;
    await dependencies.repository.importBackup(pendingImport, mode);
    [title, visits, boundaries, areaVisits] = await Promise.all([
      dependencies.repository.getTitle(),
      dependencies.repository.listVisits(),
      dependencies.repository.listBoundaries(),
      dependencies.repository.listAreaVisits(),
    ]);
    pendingImport = undefined;
    confirmingReplace = false;
    selectedCityId = undefined;
    selectedAreaId = undefined;
    renderImportDialog();
    render();
    setStatus(mode === 'merge' ? '备份已合并' : '备份已替换');
  }

  function renderActions(): void {
    elements.actions.replaceChildren();
    const exportJson = button('导出 JSON 备份');
    exportJson.addEventListener('click', () => void track((async () => {
      try {
        const backup = await exportBackup(dependencies.repository, now);
        const payload = `${JSON.stringify(backup, null, 2)}\n`;
        downloadBlob(new Blob([payload], { type: 'application/json;charset=utf-8' }), '世界足迹备份.json');
        setStatus('完整备份已导出');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '备份导出失败', 'error');
      }
    })()));
    const importJson = button('导入 JSON 备份');
    importJson.addEventListener('click', () => void track((async () => {
      try {
        const payload = await chooseJsonFile();
        if (payload === undefined) return;
        pendingImport = parseBackup(payload);
        confirmingReplace = false;
        renderImportDialog();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '备份导入失败', 'error');
      }
    })()));
    elements.actions.append(exportJson, importJson);
    for (const [layout, label] of [['landscape', '导出横版海报'], ['square', '导出方形海报']] as const) {
      const action = button(label);
      action.addEventListener('click', () => void track((async () => {
        try {
          const blob = await dependencies.exportPoster(layout, snapshot());
          downloadBlob(blob, `世界足迹-${layout === 'landscape' ? '横版' : '方形'}.png`);
          setStatus('海报已生成');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : '海报生成失败', 'error');
        }
      })()));
      elements.actions.append(action);
    }
  }

  function render(): void {
    if (destroyed) return;
    elements.heading.textContent = title;
    elements.title.value = title;
    renderStats();
    renderVisits();
    renderEditor();
    renderActions();
    renderNavigation();
    if (activeCountry === undefined) {
      const counts = new Map<string, number>();
      for (const visit of visits) counts.set(visit.citySnapshot.countryCode, (counts.get(visit.citySnapshot.countryCode) ?? 0) + 1);
      mapEngine.showWorld([...counts].map(([countryCode, visitedCount]) => ({ countryCode: countryCode as CountryCode, visitedCount })));
      mapEngine.setVisits(mapVisits());
    } else {
      mapEngine.showCountry(activeCountry, new Set(areaVisits
        .filter((visit) => visit.areaSnapshot.countryCode === activeCountry?.countryCode)
        .map((visit) => visit.areaId)));
    }
  }

  function showNearby(point: MapClick): void {
    const nearby = dependencies.cityIndex.nearest(point.lon, point.lat, 5);
    elements.nearby.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = '选择附近城市';
    const list = document.createElement('ul');
    for (const city of nearby) appendCityButton(list, city, () => void addCity(city));
    elements.nearby.append(heading, list);
  }

  async function addCity(city: CitySummary): Promise<void> {
    elements.search.value = '';
    elements.searchResults.replaceChildren();
    elements.nearby.replaceChildren();
    const existing = visits.find((visit) => visit.cityId === city.id);
    if (existing) {
      selectedCityId = existing.cityId;
      render();
      return;
    }
    const timestamp = now();
    const visit: VisitRecord = {
      cityId: city.id,
      citySnapshot: structuredClone(city),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await dependencies.repository.putVisit(visit);
      visits = [...visits, visit];
      selectedCityId = city.id;
      render();
      setStatus(`${city.zhName ?? city.name}已点亮，正在获取城市边界`);
      await fetchAndStoreBoundary(city);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '城市点亮失败', 'error');
    }
  }

  async function fetchAndStoreBoundary(city: CitySummary): Promise<void> {
    try {
      setStatus(`正在获取${city.zhName ?? city.name}的城市边界`);
      const boundary = await dependencies.fetchBoundary(city, abortController.signal);
      if (!boundary) {
        setStatus('暂未找到城市边界，已用光点标记');
        renderEditor();
        return;
      }
      await dependencies.repository.putBoundary(boundary);
      boundaries = [...boundaries.filter((item) => item.cityId !== city.id), boundary];
      render();
      setStatus(`${city.zhName ?? city.name}的城市边界已保存`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '边界获取失败，请稍后手动重试', 'error');
      renderEditor();
    }
  }

  elements.search.addEventListener('input', () => {
    const results = dependencies.cityIndex.search(elements.search.value, 12);
    elements.searchResults.replaceChildren();
    for (const city of results) appendCityButton(elements.searchResults, city, () => void track(addCity(city)));
  });
  elements.title.addEventListener('change', () => {
    const nextTitle = elements.title.value.trim().slice(0, 120) || '我的世界足迹';
    void track(dependencies.repository.setTitle(nextTitle).then(() => {
      title = nextTitle;
      render();
    }));
  });

  const ready = track((async () => {
    try {
      [title, visits, boundaries, areaVisits] = await Promise.all([
        dependencies.repository.getTitle(),
        dependencies.repository.listVisits(),
        dependencies.repository.listBoundaries(),
        dependencies.repository.listAreaVisits(),
      ]);
      render();
      if (dependencies.repository.persistence.mode === 'memory') {
        setStatus('当前记录只保存在本次页面，请及时导出备份', 'error');
      }
    } finally {
      root.setAttribute('aria-busy', 'false');
    }
  })());

  return {
    ready,
    async whenIdle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    destroy(): void {
      destroyed = true;
      abortController.abort();
      mapEngine.destroy();
      root.replaceChildren();
    },
  };
}
