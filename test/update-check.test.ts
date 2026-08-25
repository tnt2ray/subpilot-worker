import { describe, expect, it, vi } from "vitest";
import { getUpdateStatus, readCachedUpdateStatus, readNotifiedUpdateVersion, storeNotifiedUpdateVersion } from "../src/update-check";
import { makeTestEnv } from "./helpers/env";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("release update checks", () => {
  it("fetches releases, caches fresh results, falls back from rate limits, and stores notification state", async () => {
    const { env, calls } = makeTestEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      tag_name: "v99.0.0",
      html_url: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v99.0.0"
    })));

    const status = await getUpdateStatus(env, { force: true });

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/tnt2ray/subpilot-worker/releases/latest", expect.objectContaining({
      headers: expect.objectContaining({ accept: "application/vnd.github+json" })
    }));
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("99.0.0");
    await expect(readCachedUpdateStatus(env)).resolves.toMatchObject({
      latestVersion: "99.0.0",
      updateAvailable: true
    });
    expect(calls.puts).toBeGreaterThan(0);

    vi.restoreAllMocks();
    const { env: fallbackEnv } = makeTestEnv();
    const redirectResponse = new Response("", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    Object.defineProperty(redirectResponse, "url", { value: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v99.1.0" });
    const fallbackFetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(redirectResponse);

    const fallbackStatus = await getUpdateStatus(fallbackEnv, { force: true });

    expect(fallbackFetchMock).toHaveBeenNthCalledWith(1, "https://api.github.com/repos/tnt2ray/subpilot-worker/releases/latest", expect.any(Object));
    expect(fallbackFetchMock).toHaveBeenNthCalledWith(2, "https://github.com/tnt2ray/subpilot-worker/releases/latest", expect.objectContaining({
      redirect: "follow"
    }));
    expect(fallbackStatus.error).toBeNull();
    expect(fallbackStatus.latestVersion).toBe("99.1.0");
    expect(fallbackStatus.releaseUrl).toBe("https://github.com/tnt2ray/subpilot-worker/releases/tag/v99.1.0");

    vi.restoreAllMocks();
    const { env: cachedEnv } = makeTestEnv(new Map([["stats:updateCheck:latest", JSON.stringify({
      latestVersion: "1.0.0",
      releaseUrl: "https://example.com/release",
      checkedAt: new Date().toISOString(),
      error: null
    })]]));
    const cachedFetchMock = vi.spyOn(globalThis, "fetch");

    const cachedStatus = await getUpdateStatus(cachedEnv);

    expect(cachedStatus.updateAvailable).toBe(false);
    expect(cachedStatus.releaseUrl).toBeNull();
    expect(cachedFetchMock).not.toHaveBeenCalled();

    await storeNotifiedUpdateVersion(env, "1.2.0");
    await expect(readNotifiedUpdateVersion(env)).resolves.toBe("1.2.0");
  });

  it("bounds GitHub responses and rejects untrusted release links", async () => {
    const { env } = makeTestEnv();
    const redirectResponse = new Response("", { status: 200 });
    Object.defineProperty(redirectResponse, "url", {
      value: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v88.0.0"
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("oversized", {
        headers: { "content-length": String(65 * 1024) }
      }))
      .mockResolvedValueOnce(redirectResponse);

    const status = await getUpdateStatus(env, { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({
      latestVersion: "88.0.0",
      releaseUrl: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v88.0.0",
      error: null
    });

    vi.restoreAllMocks();
    const { env: maliciousEnv } = makeTestEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      tag_name: "v89.0.0",
      html_url: "javascript:alert(1)"
    })));

    await expect(getUpdateStatus(maliciousEnv, { force: true })).resolves.toMatchObject({
      latestVersion: "89.0.0",
      releaseUrl: "https://github.com/tnt2ray/subpilot-worker/releases/latest"
    });
  });

  it("returns a successful live result after one failed cache write without retrying the same KV key", async () => {
    const { env } = makeTestEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      tag_name: "v77.0.0",
      html_url: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v77.0.0"
    })));
    const put = vi.spyOn(env.SUBPILOT_CONFIG, "put").mockRejectedValue(new Error("KV PUT rate limit"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getUpdateStatus(env, { force: true })).resolves.toMatchObject({
      latestVersion: "77.0.0",
      updateAvailable: true,
      error: null
    });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("does not trust a cached timestamp from the future", async () => {
    const { env } = makeTestEnv(new Map([["stats:updateCheck:latest", JSON.stringify({
      latestVersion: "1.0.0",
      releaseUrl: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v1.0.0",
      checkedAt: new Date(Date.now() + 60_000).toISOString(),
      error: null
    })]]));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      tag_name: "v78.0.0",
      html_url: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v78.0.0"
    })));

    await expect(getUpdateStatus(env)).resolves.toMatchObject({ latestVersion: "78.0.0" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
