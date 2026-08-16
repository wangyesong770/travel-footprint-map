import type { VisitRecord } from '../domain/types';
import { calculateStats } from './statistics';

const item = (cityId: number, countryCode: string, continentCode: 'AS' | 'EU'): VisitRecord => ({
  cityId,
  citySnapshot: { id: cityId, name: '', asciiName: '', aliases: [], countryCode, continentCode, lat: 0, lon: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

it('counts unique cities/countries and continent distribution', () => {
  expect(calculateStats([item(1, 'CN', 'AS'), item(2, 'CN', 'AS'), item(3, 'FR', 'EU')])).toEqual({
    cityCount: 3,
    countryCount: 2,
    continentCounts: { AS: 2, EU: 1 },
  });
});

it('returns stable empty statistics', () => {
  expect(calculateStats([])).toEqual({ cityCount: 0, countryCount: 0, continentCounts: {} });
});
