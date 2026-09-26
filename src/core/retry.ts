/** Retry an async operation with backoff, only for errors the caller marks retryable. */

export interface RetryOptions {
  /** Wait before each retry; its length is the retry count. */
  backoffMs: number[];
  isRetryable(error: unknown): boolean;
  sleep?(ms: number): Promise<void>;
  /** Called before each retry (e.g. to reload the page after a bot challenge). */
  onRetry?(error: unknown, attempt: number): Promise<void> | void;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= opts.backoffMs.length || !opts.isRetryable(e)) throw e;
      await opts.onRetry?.(e, attempt + 1);
      await sleep(opts.backoffMs[attempt]);
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
