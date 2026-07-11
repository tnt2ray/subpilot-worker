type Fetcher = typeof fetch;

export async function fetchWithTimeout<T>(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Upstream fetch timed out after ${timeoutMs} ms`)), timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    return await consume(await fetcher(input, { ...init, signal }));
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForRetry(attempt: number, baseDelayMs: number, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  const delay = Math.min(baseDelayMs * 2 ** attempt, remaining);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
