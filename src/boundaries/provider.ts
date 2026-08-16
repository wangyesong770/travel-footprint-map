import type { CitySummary } from '../domain/types';

export type BoundaryProviderErrorCode =
  | 'aborted'
  | 'timeout'
  | 'rate_limited'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'response_too_large';

export class BoundaryProviderError extends Error {
  readonly code: BoundaryProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: BoundaryProviderErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BoundaryProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface BoundaryCandidate {
  id: string;
  name: string;
  displayName: string;
  countryCode: string;
  geometry: unknown;
  type?: string;
  importance?: number;
  sourceUrl?: string;
}

export interface BoundaryProvider {
  readonly id: string;
  readonly attribution: string;
  fetchCandidates(city: CitySummary, signal?: AbortSignal): Promise<readonly BoundaryCandidate[]>;
}

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('en');
}

function desiredNames(city: CitySummary): Array<{ value: string; priority: number }> {
  const values: Array<{ value: string; priority: number }> = [];
  if (city.zhName) values.push({ value: normalized(city.zhName), priority: 50 });
  values.push({ value: normalized(city.name), priority: 40 });
  values.push({ value: normalized(city.asciiName), priority: 30 });
  values.push(...city.aliases.map((alias) => ({ value: normalized(alias), priority: 20 })));
  return values.filter((item, index, array) => item.value.length > 0 && array.findIndex((other) => other.value === item.value) === index);
}

export function rankBoundaryCandidates(city: CitySummary, candidates: readonly BoundaryCandidate[]): BoundaryCandidate[] {
  const names = desiredNames(city);
  const countryCode = city.countryCode.toLocaleLowerCase('en');
  return candidates
    .map((candidate, index) => {
      if (candidate.countryCode.toLocaleLowerCase('en') !== countryCode) return undefined;
      const candidateName = normalized(candidate.name);
      const displayName = normalized(candidate.displayName);
      let score = Number.NEGATIVE_INFINITY;
      for (const name of names) {
        if (candidateName === name.value) score = Math.max(score, 1_000 + name.priority);
        else if (displayName.split(',').some((part) => part.trim() === name.value)) score = Math.max(score, 500 + name.priority);
      }
      if (!Number.isFinite(score)) return undefined;
      if (candidate.type === 'administrative' || candidate.type === 'city' || candidate.type === 'town' || candidate.type === 'municipality') score += 10;
      if (typeof candidate.importance === 'number' && Number.isFinite(candidate.importance)) score += Math.max(0, Math.min(1, candidate.importance));
      return { candidate, score, index };
    })
    .filter((item): item is { candidate: BoundaryCandidate; score: number; index: number } => item !== undefined)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}
