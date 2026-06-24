import { describe, expect, it, vi } from "vitest";
import { getUpdateStatus, readCachedUpdateStatus, readNotifiedUpdateVersion, storeNotifiedUpdateVersion } from "../src/update-check";
import { makeTestEnv } from "./helpers/env";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("release update checks", () => {
  it("fetches releases, caches fresh results, falls back from rate limits, and stores notification state", async () => {
    const { env, calls } = makeTestEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      tag_name: "v1.2.0",
      html_url: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v1.2.0"
    })));

    const status = await getUpdateStatus(env, { force: true });

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/tnt2ray/subpilot-worker/releases/latest", expect.objectContaining({
      headers: expect.objectContaining({ accept: "application/vnd.github+json" })
    }));
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("1.2.0");
    await expect(readCachedUpdateStatus(env)).resolves.toMatchObject({
      latestVersion: "1.2.0",
      updateAvailable: true
    });
    expect(calls.puts).toBeGreaterThan(0);

    vi.restoreAllMocks();
    const { env: fallbackEnv } = makeTestEnv();
    const redirectResponse = new Response("", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    Object.defineProperty(redirectResponse, "url", { value: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v1.3.0" });
    const fallbackFetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(redirectResponse);

    const fallbackStatus = await getUpdateStatus(fallbackEnv, { force: true });

    expect(fallbackFetchMock).toHaveBeenNthCalledWith(1, "https://api.github.com/repos/tnt2ray/subpilot-worker/releases/latest", expect.any(Object));
    expect(fallbackFetchMock).toHaveBeenNthCalledWith(2, "https://github.com/tnt2ray/subpilot-worker/releases/latest", expect.objectContaining({
      redirect: "follow"
    }));
    expect(fallbackStatus.error).toBeNull();
    expect(fallbackStatus.latestVersion).toBe("1.3.0");
    expect(fallbackStatus.releaseUrl).toBe("https://github.com/tnt2ray/subpilot-worker/releases/tag/v1.3.0");

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
    expect(cachedFetchMock).not.toHaveBeenCalled();

    await storeNotifiedUpdateVersion(env, "1.2.0");
    await expect(readNotifiedUpdateVersion(env)).resolves.toBe("1.2.0");
  });
});
