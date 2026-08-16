import type { AreaId, CountryCode, CountryScheme } from './types';
import { requireVerifiedCountryConfig } from '../audit/registry';

type VerifiedCountryScheme = Omit<CountryScheme, 'status'> & { readonly status: 'verified' };

const freezeScheme = (
  scheme: Omit<VerifiedCountryScheme, 'acceptedLevels'> & { acceptedLevels: readonly string[] },
): VerifiedCountryScheme =>
  Object.freeze({
    ...scheme,
    acceptedLevels: Object.freeze([...scheme.acceptedLevels]),
  });

const PRESENTATION: Readonly<Record<string, { readonly acceptedLevels: readonly string[]; readonly labelZh: string }>> =
  Object.freeze({
    CN: Object.freeze({ acceptedLevels: Object.freeze(['prefecture']), labelZh: '地级行政区' }),
    JP: Object.freeze({ acceptedLevels: Object.freeze(['municipality']), labelZh: '市町村' }),
    US: Object.freeze({
      acceptedLevels: Object.freeze(['county', 'independent-city']),
      labelZh: '县及独立市等同行政区',
    }),
  });

const schemeCache = new Map<string, VerifiedCountryScheme>();

const normalizeCountryCode = (countryCode: string): CountryCode => {
  if (!/^[A-Za-z]{2}$/.test(countryCode)) {
    throw new Error('国家代码必须是 ISO 3166-1 alpha-2 的两位英文字母');
  }
  return countryCode.toUpperCase() as CountryCode;
};

export const getCountryScheme = (countryCode: string): VerifiedCountryScheme => {
  const normalized = normalizeCountryCode(countryCode);
  const cached = schemeCache.get(normalized);
  if (cached) return cached;
  const config = requireVerifiedCountryConfig(normalized);
  const presentation = PRESENTATION[normalized];
  const scheme = freezeScheme({
    countryCode: config.sovereignCode,
    source: 'overture',
    acceptedLevels: presentation?.acceptedLevels ?? [config.productLevel],
    labelZh: presentation?.labelZh ?? config.productLevel,
    status: 'verified',
  });
  schemeCache.set(normalized, scheme);
  return scheme;
};

export interface AreaIdentity {
  readonly countryCode: string;
  readonly source: string;
  readonly sourceId: string;
  readonly nameZh?: string;
  readonly nameLocal?: string;
}

const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

export const createAreaId = ({ countryCode, source, sourceId }: AreaIdentity): AreaId => {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source)) {
    throw new Error('区域数据源必须是 1–64 位且只包含英文字母、数字、点、下划线或连字符');
  }
  if (
    sourceId.length === 0 ||
    sourceId.length > 160 ||
    sourceId.trim() !== sourceId ||
    sourceId.includes(':') ||
    containsControlCharacter(sourceId)
  ) {
    throw new Error('区域源 ID 必须是 1–160 位、不含冒号或控制字符的稳定标识');
  }

  return `${normalizedCountryCode}:${source.toLowerCase()}:${sourceId}`;
};
