import { afterEach, vi } from "vitest";

export function restoreMocksAfterEach(): void {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

export function mockSubscription(content: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));
}
