import './styles.css';

import { boundaryForUi } from './app-wiring';
import { CountryPackageMemoryRepository } from './areas/country-package-memory-repository';
import { CountryPackageService } from './areas/country-package-service';
import { createBoundaryService } from './boundaries/boundary-service';
import {
  createNominatimProvider,
  NOMINATIM_ATTRIBUTION,
  NOMINATIM_PRIVACY_NOTICE,
} from './boundaries/nominatim-provider';
import { createCityIndex } from './cities/city-index';
import { exportPosterPng } from './export/poster';
import { WORLD_MAP } from './generated/world-map';
import { createMapEngine } from './map/map-engine';
import { createTripStore } from './storage/trip-store';
import { createApp } from './ui/app';

const CITY_DATA_ATTRIBUTION = 'GeoNames geographical database, licensed under CC BY 4.0 (https://www.geonames.org/).';
const CITY_DATA_SOURCE_DATE = '2026-08-16';
const CHINA_MAP_ATTRIBUTION = '中国地级边界：cn-atlas by Amll（ISC）';

async function loadCityIndex() {
  const { CITIES } = await import('./generated/cities.data');
  return createCityIndex(CITIES);
}

async function start(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('缺少应用根节点');

  try {
    const repository = await createTripStore();
    const boundaries = createBoundaryService({
      repository,
      provider: createNominatimProvider(),
    });
    const countryPackages = new CountryPackageService({
      repository: new CountryPackageMemoryRepository(),
    });
    const app = createApp(root, {
      loadCityIndex,
      repository,
      createMap: createMapEngine,
      fetchBoundary: async (city, signal) => boundaryForUi(await boundaries.fetchForCity(city, signal)),
      loadCountry: (countryCode, signal) => countryPackages.load(countryCode, signal),
      exportPoster: (layout, snapshot) => exportPosterPng(snapshot, layout),
      attributions: [
        `${CITY_DATA_ATTRIBUTION}（数据日期 ${CITY_DATA_SOURCE_DATE}）`,
        WORLD_MAP.attribution,
        CHINA_MAP_ATTRIBUTION,
        NOMINATIM_ATTRIBUTION,
      ],
      privacyNotice: NOMINATIM_PRIVACY_NOTICE,
    });
    await app.ready;
  } catch (error) {
    root.setAttribute('aria-busy', 'false');
    const message = document.createElement('p');
    message.className = 'startup-error';
    message.setAttribute('role', 'alert');
    message.textContent = error instanceof Error
      ? `旅行地图启动失败：${error.message}`
      : '旅行地图启动失败，请刷新页面重试。';
    root.replaceChildren(message);
  }
}

void start();
