import { describe, expect, it, vi } from "vitest";
import { getUpdateStatus, readCachedUpdateStatus, readNotifiedUpdateVersion, storeNotifiedUpdateVersion } from "../src/update-check";
import { makeTestEnv } from "./helpers/env";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("release update checks", () => {
  it("fetches the latest GitHub release and caches the result", async () => {
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
  });

  it("falls back to the GitHub latest release redirect when the API is rate limited", async () => {
    const { env } = makeTestEnv();
    const redirectResponse = new Response("", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    Object.defineProperty(redirectResponse, "url", { value: "https://github.com/tnt2ray/subpilot-worker/releases/tag/v1.3.0" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(redirectResponse);

    const status = await getUpdateStatus(env, { force: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.github.com/repos/tnt2ray/subpilot-worker/releases/latest", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://github.com/tnt2ray/subpilot-worker/releases/latest", expect.objectContaining({
      redirect: "follow"
    }));
    expect(status.error).toBeNull();
    expect(status.latestVersion).toBe("1.3.0");
    expect(status.releaseUrl).toBe("https://github.com/tnt2ray/subpilot-worker/releases/tag/v1.3.0");
  });

  it("reuses a fresh cached check unless forced", async () => {
    const { env } = makeTestEnv(new Map([["stats:updateCheck:latest", JSON.stringify({
      latestVersion: "1.0.0",
      releaseUrl: "https://example.com/release",
      checkedAt: new Date().toISOString(),
      error: null
    })]]));
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const status = await getUpdateStatus(env);

    expect(status.updateAvailable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores the Telegram-notified version", async () => {
    const { env } = makeTestEnv();

    await storeNotifiedUpdateVersion(env, "1.2.0");

    await expect(readNotifiedUpdateVersion(env)).resolves.toBe("1.2.0");
  });
});
