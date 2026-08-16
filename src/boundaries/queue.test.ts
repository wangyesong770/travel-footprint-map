import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRequestQueue } from './queue';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('serialized request queue', () => {
  it('runs one task at a time with at least one second between starts', async () => {
    const starts: number[] = [];
    const queue = createRequestQueue({ minimumIntervalMs: 1_000 });

    const first = queue.enqueue(async () => { starts.push(Date.now()); return 'first'; });
    const second = queue.enqueue(async () => { starts.push(Date.now()); return 'second'; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(starts).toEqual([0, 1_000]);
  });

  it('removes an aborted queued request without running its task', async () => {
    const queue = createRequestQueue({ minimumIntervalMs: 1_000 });
    const controller = new AbortController();
    const task = vi.fn(async () => 'never');
    await queue.enqueue(async () => 'first');
    const pending = queue.enqueue(task, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).not.toHaveBeenCalled();
  });

  it('continues after a task failure', async () => {
    const queue = createRequestQueue({ minimumIntervalMs: 1_000 });
    const failed = queue.enqueue(async () => { throw new Error('boom'); });
    const next = queue.enqueue(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).resolves.toBe('ok');
  });
});
