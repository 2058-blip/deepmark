export interface EncodingRetryOptions {
  signal: AbortSignal;
  active: () => boolean;
  onRetry?: (reason: unknown, attempt: number, delay: number) => void;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

function stopped(): DOMException {
  return new DOMException('同步编码已暂停，已完成的操作仍保留在本机。', 'AbortError');
}

/** Retry transport failures, never invalid geometry, storage errors or denied access. */
export function retryableEncodingError(reason: unknown): boolean {
  const value = reason as {status?: number; name?: string; message?: string} | null;
  if (value?.name === 'AbortError') return false;
  if (typeof value?.status === 'number')
    return [408, 425, 429].includes(value.status) || value.status >= 500 && value.status <= 599;
  return value?.name === 'NetworkError' || value?.name === 'TypeError'
    && /fetch|network|load failed|连接|网络/i.test(value.message || '');
}

function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(stopped()); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(stopped()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => { cleanup(); resolve(value); }, reason => { cleanup(); reject(reason); });
  });
}

function pause(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { clearTimeout(timer); cleanup(); reject(stopped()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
    signal.addEventListener('abort', abort, {once: true});
  });
}

/** Keep the same durable operation in `encoding` until all resources are ready.
 * Offline retries sleep with capped backoff; disposal or permission revocation
 * interrupts both the sleep and an in-flight attempt without publishing it.
 */
export async function retryWorkbenchEncoding<T>(
  encode: (assertActive: () => void) => Promise<T>, options: EncodingRetryOptions,
): Promise<T> {
  const initial = options.initialDelayMs ?? 500, maximum = options.maximumDelayMs ?? 30_000;
  if (!Number.isFinite(initial) || initial < 1 || !Number.isFinite(maximum) || maximum < initial)
    throw new Error('同步重试间隔无效。');
  const assertActive = () => { if (options.signal.aborted || !options.active()) throw stopped(); };
  for (let attempt = 0;; attempt++) {
    assertActive();
    try {
      const result = await interruptible(encode(assertActive), options.signal);
      assertActive();
      return result;
    } catch (reason) {
      assertActive();
      if (!retryableEncodingError(reason)) throw reason;
      const delay = Math.min(maximum, initial * 2 ** Math.min(attempt, 16));
      options.onRetry?.(reason, attempt + 1, delay);
      await pause(delay, options.signal);
    }
  }
}
