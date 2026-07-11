import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, waitForRetry } from "../src/upstream-fetch";

afterEach(() => {
  vi.useRealTimers();
});

describe("upstream fetch deadlines", () => {
  it("aborts an upstream request when its attempt timeout expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const request = fetchWithTimeout(fetcher, "https://example.com/slow", undefined, 1_000, async (response) => response);
    const rejection = expect(request).rejects.toThrow("Upstream fetch timed out after 1000 ms");

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(fetcher).toHaveBeenCalledWith("https://example.com/slow", expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
  });

  it("uses bounded exponential retry delays", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 10_000;
    const retry = waitForRetry(2, 100, deadline);
    let settled = false;
    void retry.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(settled).toBe(true);
  });

  it("keeps the timeout active while the response body is consumed", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        }
      });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch;
    const request = fetchWithTimeout(fetcher, "https://example.com/slow-body", undefined, 1_000, (response) => response.text());
    const rejection = expect(request).rejects.toThrow("Upstream fetch timed out after 1000 ms");

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
  });
});
