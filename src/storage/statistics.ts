import type { TravelStats, VisitRecord } from '../domain/types';

export function calculateStats(visits: readonly VisitRecord[]): TravelStats {
  const cities = new Set<number>();
  const countries = new Set<string>();
  const continentCounts: TravelStats['continentCounts'] = {};
  for (const visit of visits) {
    if (cities.has(visit.cityId)) continue;
    cities.add(visit.cityId);
    countries.add(visit.citySnapshot.countryCode);
    const continent = visit.citySnapshot.continentCode;
    continentCounts[continent] = (continentCounts[continent] ?? 0) + 1;
  }
  return { cityCount: cities.size, countryCount: countries.size, continentCounts };
}
