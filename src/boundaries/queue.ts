export interface RequestQueue {
  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface RequestQueueOptions {
  minimumIntervalMs?: number;
  now?: () => number;
}

function abortError(signal?: AbortSignal): DOMException {
  if (signal?.reason instanceof DOMException && signal.reason.name === 'AbortError') return signal.reason;
  return new DOMException('请求已取消', 'AbortError');
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return signal?.aborted ? Promise.reject(abortError(signal)) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class SerialRequestQueue implements RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly minimumIntervalMs: number;
  private readonly now: () => number;

  constructor(options: RequestQueueOptions) {
    this.minimumIntervalMs = options.minimumIntervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.minimumIntervalMs) || this.minimumIntervalMs < 0) {
      throw new Error('请求间隔必须是非负有限数值');
    }
  }

  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async (): Promise<T> => {
      if (signal?.aborted) throw abortError(signal);
      const delay = Math.max(0, this.lastStart + this.minimumIntervalMs - this.now());
      await wait(delay, signal);
      if (signal?.aborted) throw abortError(signal);
      this.lastStart = this.now();
      return task();
    };
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createRequestQueue(options: RequestQueueOptions = {}): RequestQueue {
  return new SerialRequestQueue(options);
}
