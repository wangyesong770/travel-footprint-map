import { BoundaryProviderError, type BoundaryCandidate, type BoundaryProvider } from './provider';
import { createRequestQueue, type RequestQueue } from './queue';

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const sharedPublicQueue = createRequestQueue({ minimumIntervalMs: 1_000 });

export const NOMINATIM_ATTRIBUTION = '© OpenStreetMap contributors，边界由 Nominatim 提供';
export const NOMINATIM_PRIVACY_NOTICE = '首次获取边界时，会把所选城市名称和国家代码发送给 OpenStreetMap Nominatim；不会发送备注或完整旅行记录。';

export interface NominatimProviderOptions {
  fetch?: typeof globalThis.fetch;
  queue?: RequestQueue;
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface NominatimRecord {
  place_id: number | string;
  name: string;
  display_name: string;
  country_code: string;
  geojson: unknown;
  type?: string;
  addresstype?: string;
  importance?: number;
  osm_type?: string;
  osm_id?: number | string;
}

function abortProviderError(): BoundaryProviderError {
  return new BoundaryProviderError('aborted', '边界请求已取消', false);
}

function readCandidate(value: unknown): NominatimRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((typeof record.place_id !== 'number' && typeof record.place_id !== 'string')
    || typeof record.name !== 'string'
    || typeof record.display_name !== 'string'
    || typeof record.country_code !== 'string'
    || !('geojson' in record)) return undefined;
  const result: NominatimRecord = {
    place_id: record.place_id,
    name: record.name.slice(0, 300),
    display_name: record.display_name.slice(0, 1_000),
    country_code: record.country_code.slice(0, 8),
    geojson: record.geojson,
  };
  if (typeof record.type === 'string') result.type = record.type.slice(0, 80);
  else if (typeof record.addresstype === 'string') result.type = record.addresstype.slice(0, 80);
  if (typeof record.importance === 'number' && Number.isFinite(record.importance)) result.importance = record.importance;
  if (typeof record.osm_type === 'string') result.osm_type = record.osm_type;
  if (typeof record.osm_id === 'number' || typeof record.osm_id === 'string') result.osm_id = record.osm_id;
  return result;
}

function sourceUrl(record: NominatimRecord): string | undefined {
  if (!record.osm_type || record.osm_id === undefined) return undefined;
  const type = record.osm_type.toLocaleLowerCase('en');
  if (type !== 'node' && type !== 'way' && type !== 'relation') return undefined;
  const id = String(record.osm_id);
  if (!/^\d+$/.test(id)) return undefined;
  return `https://www.openstreetmap.org/${type}/${id}`;
}

function asCandidate(record: NominatimRecord): BoundaryCandidate {
  const candidate: BoundaryCandidate = {
    id: String(record.place_id),
    name: record.name,
    displayName: record.display_name,
    countryCode: record.country_code,
    geometry: record.geojson,
  };
  if (record.type) candidate.type = record.type;
  if (record.importance !== undefined) candidate.importance = record.importance;
  const url = sourceUrl(record);
  if (url) candidate.sourceUrl = url;
  return candidate;
}

async function readLimitedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new BoundaryProviderError('response_too_large', '边界响应超过大小限制', false);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new BoundaryProviderError('response_too_large', '边界响应超过大小限制', false);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel('response_too_large');
      throw new BoundaryProviderError('response_too_large', '边界响应超过大小限制', false);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function createNominatimProvider(options: NominatimProviderOptions = {}): BoundaryProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const queue = options.queue ?? sharedPublicQueue;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
  if (endpoint.protocol !== 'https:') throw new Error('Nominatim 地址必须使用 HTTPS');
  if (typeof fetchImplementation !== 'function') throw new Error('当前环境不支持网络请求');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error('Nominatim 请求限制无效');
  }

  return {
    id: 'nominatim',
    attribution: NOMINATIM_ATTRIBUTION,
    fetchCandidates(city, callerSignal): Promise<readonly BoundaryCandidate[]> {
      if (callerSignal?.aborted) return Promise.reject(abortProviderError());
      return queue.enqueue(async () => {
        if (callerSignal?.aborted) throw abortProviderError();
        const controller = new AbortController();
        let timedOut = false;
        let rejectCancellation: (reason?: unknown) => void = () => undefined;
        const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
        const onCallerAbort = (): void => {
          controller.abort(callerSignal?.reason);
          rejectCancellation(callerSignal?.reason ?? new DOMException('请求已取消', 'AbortError'));
        };
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
        const timeout = globalThis.setTimeout(() => {
          timedOut = true;
          const timeoutError = new DOMException('请求超时', 'TimeoutError');
          controller.abort(timeoutError);
          rejectCancellation(timeoutError);
        }, timeoutMs);
        try {
          const url = new URL(endpoint);
          url.searchParams.set('format', 'jsonv2');
          url.searchParams.set('polygon_geojson', '1');
          url.searchParams.set('limit', '5');
          url.searchParams.set('city', city.name);
          url.searchParams.set('countrycodes', city.countryCode.toLocaleLowerCase('en'));
          url.searchParams.set('accept-language', 'zh-CN,en');
          const fetchRequest = fetchImplementation(url.toString(), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
            credentials: 'omit',
          });
          const response = await Promise.race([fetchRequest, cancellation]);
          if (response.status === 429) throw new BoundaryProviderError('rate_limited', '边界服务请求过于频繁，请稍后手动重试', true);
          if (!response.ok) throw new BoundaryProviderError('http', `边界服务返回 HTTP ${response.status}`, response.status >= 500);
          const text = await readLimitedText(response, maxResponseBytes);
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch (error) {
            throw new BoundaryProviderError('invalid_response', '边界服务返回了无效 JSON', false, { cause: error });
          }
          if (!Array.isArray(parsed)) throw new BoundaryProviderError('invalid_response', '边界服务返回格式无效', false);
          return parsed.slice(0, 5).map(readCandidate).filter((item): item is NominatimRecord => item !== undefined).map(asCandidate);
        } catch (error) {
          if (error instanceof BoundaryProviderError) throw error;
          if (timedOut) throw new BoundaryProviderError('timeout', '边界请求超时，请手动重试', true, { cause: error });
          if (callerSignal?.aborted || controller.signal.aborted) throw abortProviderError();
          throw new BoundaryProviderError('network', '无法连接边界服务，请检查网络或浏览器跨域限制', true, { cause: error });
        } finally {
          globalThis.clearTimeout(timeout);
          callerSignal?.removeEventListener('abort', onCallerAbort);
        }
      }, callerSignal).catch((error: unknown) => {
        if (error instanceof BoundaryProviderError) throw error;
        if (callerSignal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw abortProviderError();
        throw new BoundaryProviderError('network', '无法连接边界服务', true, { cause: error });
      });
    },
  };
}
