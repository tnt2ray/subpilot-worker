import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createSession, sessionCookie } from "../src/auth";
import { CONFIG_SCHEMA_VERSION_KEY } from "../src/config-schema";
import { loadConfig, saveConfig } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { recordConfigFetch } from "../src/fetch-stats";
import { sha256Hex } from "../src/util";
import { makeTestEnv } from "./helpers/env";
import { restoreMocksAfterEach } from "./helpers/fetch";

const mmdb = vi.hoisted(() => ({
  constructorInputs: [] as Uint8Array[]
}));

vi.mock("mmdb-lib", () => ({
  Reader: class {
    constructor(input: Uint8Array) {
      mmdb.constructorInputs.push(input);
      const text = new TextDecoder().decode(input.slice(0, 4));
      if (text !== "MMDB") throw new Error("invalid mmdb");
    }
    get() {
      return null;
    }
  }
}));

restoreMocksAfterEach();

function makeEnv(kv = new Map<string, string>()): Env {
  const assets = new Map<string, string>([
    ["/index.html", "<!doctype html><title>SubPilot 控制台</title><a>配置链接</a><script src=\"/app.js\"></script>"],
    ["/login.html", "<!doctype html><title>SubPilot 登录</title><main>管理员登录</main><script>fetch('/api/login')</script>"],
    ["/app.js", "console.log('admin app')"],
    ["/styles.css", ".admin{}"]
  ]);
  return makeTestEnv(kv, { assets }).env;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

function makeExecutionContext(): { ctx: ExecutionContext; waitUntil: Promise<unknown>[] } {
  const waitUntil: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => { waitUntil.push(promise); },
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext,
    waitUntil
  };
}

describe("asset access control", () => {
  it("serves the login page before a session, blocks assets, and serves the admin app after login", async () => {
    const env = makeEnv();
    const response = await worker.fetch(new Request("https://subpilot.example.com/"), env, ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("管理员登录");
    expect(html).not.toContain("配置链接");
    expect(html).not.toContain("配置预览");
    expect(html).not.toContain("策略组");
    expect(html).not.toContain("/app.js");
    expect(html).not.toContain("/styles.css");
    expect(html).toContain("/api/login");

    await expect(worker.fetch(new Request("https://subpilot.example.com/app.js"), env, ctx)
      .then((response) => response.status)).resolves.toBe(401);
    await expect(worker.fetch(new Request("https://subpilot.example.com/styles.css"), env, ctx)
      .then((response) => response.status)).resolves.toBe(401);

    const session = await createSession(env);
    const appRequest = new Request("https://subpilot.example.com/", {
      headers: { cookie: sessionCookie(session, true) }
    });
    const appResponse = await worker.fetch(appRequest, env, ctx);
    const appHtml = await appResponse.text();

    expect(appResponse.status).toBe(200);
    expect(appHtml).toContain("配置链接");
    expect(appHtml).toContain("/app.js");
  });

  it("auto-migrates KV from system status and keeps explicit migration idempotent", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };

    expect(kv.has(CONFIG_SCHEMA_VERSION_KEY)).toBe(false);

    const statusResponse = await worker.fetch(new Request("https://subpilot.example.com/api/system/status", { headers }), env, ctx);
    const statusBody = await statusResponse.json<{ app: { version: string }; schema?: unknown }>();

    expect(statusResponse.status).toBe(200);
    expect(statusBody.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(statusBody.schema).toBeUndefined();
    expect(kv.get(CONFIG_SCHEMA_VERSION_KEY)).toBeDefined();

    const migrateResponse = await worker.fetch(new Request("https://subpilot.example.com/api/system/migrate", {
      method: "POST",
      headers
    }), env, ctx);
    const migrateBody = await migrateResponse.json<{ schema: { current: number; stored: number; pending: number[] } }>();

    expect(migrateResponse.status).toBe(200);
    expect(migrateBody.schema.stored).toBe(migrateBody.schema.current);
    expect(migrateBody.schema.pending).toEqual([]);
  });

  it("proxies explicit Surge online validation for authenticated admins", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      valid: false,
      error: { message: "Invalid Surge profile" }
    })));
    const request = new Request("https://subpilot.example.com/api/surge/validate-online", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: "[General]\nloglevel = notify\n\n[Rule]\nFINAL,DIRECT\n",
        acknowledgeRisk: true
      })
    });

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json<{ valid: boolean; error: string }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({ valid: false, error: "Invalid Surge profile" });
    expect(fetchMock).toHaveBeenCalledWith("https://services.nssurge.com/v1/config/validate", expect.objectContaining({
      method: "POST",
      body: "[General]\nloglevel = notify\n\n[Rule]\nFINAL,DIRECT\n"
    }));
  });

  it("sanitizes proxy credentials before Surge online validation", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      valid: true
    })));
    const request = new Request("https://subpilot.example.com/api/surge/validate-online", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: [
          "[Proxy]",
          "Real HTTPS = https, real.example.com, 8443, username=real-user, password=real-pass, sni=edge.example.com",
          "Real VLESS = vless, 203.0.113.7, 1443, username=ed221103-1170-4b5e-bb11-2dfe0f9aa001, tls=true, ws-headers=Host:ws.example.com",
          "Real TUIC = tuic, tuic.example.com, 10443, username=ed221103-1170-4b5e-bb11-2dfe0f9aa002, token=real-token",
          "Real URL = trojan://url-pass@url.example.com:443?sni=url-sni.example.com#node",
          "",
          "[Rule]",
          "FINAL,DIRECT"
        ].join("\n"),
        acknowledgeRisk: true
      })
    });

    const response = await worker.fetch(request, env, ctx);
    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string;

    expect(response.status).toBe(200);
    expect(sent).toContain("Real HTTPS = https, test.local, 443, password=test, username=test, sni=test.local");
    expect(sent).toContain("Real VLESS = vless, test.local, 443, username=00000000-0000-4000-8000-000000000002, tls=true, ws-headers=Host:test.local");
    expect(sent).toContain("Real TUIC = tuic, test.local, 443, username=00000000-0000-4000-8000-000000000003, token=test");
    expect(sent).toContain("Real URL = trojan, test.local, 443, password=test, sni=test.local");
    expect(sent).toContain("[Rule]\nFINAL,DIRECT");
    expect(sent).not.toContain("real.example.com");
    expect(sent).not.toContain("203.0.113.7");
    expect(sent).not.toContain("real-user");
    expect(sent).not.toContain("real-pass");
    expect(sent).not.toContain("real-token");
    expect(sent).not.toContain("edge.example.com");
    expect(sent).not.toContain("ws.example.com");
    expect(sent).not.toContain("trojan://");
    expect(sent).not.toContain("url-pass");
    expect(sent).not.toContain("url.example.com");
    expect(sent).not.toContain("url-sni.example.com");
  });

  it("validates detached Surge profiles with a sanitized inline profile instead of external resource URLs", async () => {
    const env = makeEnv(new Map([["auth:read_token_hash", await sha256Hex("read-token")]]));
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }],
      groups: {
        Proxy: "select, {all}"
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: ["FINAL,Proxy"]
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/sub") {
        return new Response("JP 1 = trojan, real.example.com, 443, password=real-pass, sni=edge.example.com");
      }
      if (String(url) === "https://services.nssurge.com/v1/config/validate") {
        return new Response(JSON.stringify({ valid: true }));
      }
      return new Response("not found", { status: 404 });
    });

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/surge/validate-online", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: [
          "#!MANAGED-CONFIG https://subpilot.example.com/sync/read-token/ interval=604800 strict=true",
          "[Proxy]",
          "#!include https://subpilot.example.com/sync/read-token/surge-resources/",
          "[Proxy Group]",
          "#!include https://subpilot.example.com/sync/read-token/surge-resources/",
          "[Rule]",
          "FINAL,Proxy"
        ].join("\n"),
        acknowledgeRisk: true
      })
    }), env, ctx);
    const body = await response.json<{ valid: boolean }>();
    const submitted = String(fetchMock.mock.calls.find(([url]) => String(url) === "https://services.nssurge.com/v1/config/validate")?.[1]?.body);

    expect(response.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(submitted).toContain("#!MANAGED-CONFIG https://subpilot.invalid/sync/validation/ interval=43200 strict=true");
    expect(submitted).toContain("[Proxy]\n[Primary] JP 1 = trojan, test.local, 443");
    expect(submitted).toContain("[Proxy Group]\nProxy = select, [Primary] JP 1");
    expect(submitted).not.toContain("surge-resources");
    expect(submitted).not.toContain("read-token");
    expect(submitted).not.toContain("real.example.com");
    expect(submitted).not.toContain("real-pass");
  });

  it("uploads and reports the GeoIP MMDB for authenticated admins", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };
    const form = new FormData();
    form.append("file", new File(["MMDB-country-data"], "GeoLite2-Country.mmdb", { type: "application/octet-stream" }));

    const uploadResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers,
      body: form
    }), env, ctx);
    const uploaded = await uploadResponse.json<{ uploaded: boolean; fileName: string; size: number; updatedAt: string }>();

    expect(uploadResponse.status).toBe(200);
    expect(uploaded).toMatchObject({
      uploaded: true,
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country", "arrayBuffer")).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country:meta", "json")).resolves.toMatchObject({
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });

    const statusResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      headers
    }), env, ctx);
    await expect(statusResponse.json()).resolves.toMatchObject({
      uploaded: true,
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });

    const deleteResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "DELETE",
      headers
    }), env, ctx);
    expect(deleteResponse.status).toBe(404);
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country", "arrayBuffer")).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country:meta", "json")).resolves.toMatchObject({
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });
  });

  it("rejects GeoIP MMDB uploads without an admin session or valid MMDB content", async () => {
    const env = makeEnv();
    const unauthenticatedForm = new FormData();
    unauthenticatedForm.append("file", new File(["MMDB-country-data"], "GeoLite2-Country.mmdb"));
    const unauthorizedResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      body: unauthenticatedForm
    }), env, ctx);

    expect(unauthorizedResponse.status).toBe(401);

    const session = await createSession(env);
    const invalidForm = new FormData();
    invalidForm.append("file", new File(["not-mmdb"], "bad.txt"));
    const invalidResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: invalidForm
    }), env, ctx);
    const body = await invalidResponse.json<{ error: string }>();

    expect(invalidResponse.status).toBe(400);
    expect(body.error).toBe("Invalid MMDB file");
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country")).resolves.toBeNull();
  });

  it("does not report GeoIP MMDB as uploaded when only metadata exists", async () => {
    const env = makeEnv(new Map([
      ["geoip:mmdb:country:meta", JSON.stringify({
        fileName: "GeoLite2-Country.mmdb",
        size: 1024,
        updatedAt: "2026-06-21T00:00:00.000Z"
      })]
    ]));
    const session = await createSession(env);
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ uploaded: false });
  });

  it("rejects invalid Surge hosts while saving config", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const request = new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        surge: {
          hosts: ["[Host]"]
        }
      })
    });

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Surge Host");
  });

  it("rejects invalid Surge URL Rewrite while saving config", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const request = new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        surge: {
          urlRewrite: ["^http:\\/\\/ad\\.com - block"]
        }
      })
    });

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Surge URL Rewrite");
  });

  it("records config fetch timestamps and recent user agents", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    kv.set("geoip:ip:198.51.100.7", JSON.stringify({ city: { names: { en: "Singapore" } }, country: { iso_code: "SG" } }));
    const env = makeEnv(kv);
    const userAgents = ["Surge TestClient/0", "Mihomo TestClient/1", "Stash TestClient/2", "Surge TestClient/3", "Mihomo TestClient/4", "Surge TestClient/5", "Mihomo TestClient/6"];
    for (const [index, userAgent] of userAgents.entries()) {
      const exec = makeExecutionContext();
      const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/", {
        headers: {
          "cf-connecting-ip": "198.51.100.7",
          "user-agent": userAgent
        }
      }), env, exec.ctx);

      expect(response.status).toBe(200);
      await Promise.all(exec.waitUntil);
    }
    const session = await createSession(env);
    const statsResponse = await worker.fetch(new Request("https://subpilot.example.com/api/stats", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const body = await statsResponse.json<{
      lastFetched: Record<string, string | null>;
      recentUserAgents: Array<{
        target: string;
        userAgent: string;
	        ipAddress: string;
	        location: { countryCode: string; city: string; label: string };
	        fetchedAt: string;
	      }>;
	    }>();

    expect(statsResponse.status).toBe(200);
    expect(body.lastFetched.surge).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.lastFetched.clash).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.lastFetched.stash).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect("surgeResource" in body.lastFetched).toBe(false);
    expect(body.recentUserAgents).toHaveLength(7);
    expect(body.recentUserAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: "surge",
        userAgent: "Surge TestClient/0",
        ipAddress: "198.51.100.7",
        location: expect.objectContaining({
          countryCode: "SG",
          city: "Singapore",
          label: "Singapore, SG"
        })
      }),
      expect.objectContaining({
        target: "clash",
        userAgent: "Mihomo TestClient/6"
      }),
      expect.objectContaining({
        target: "stash",
        userAgent: "Stash TestClient/2"
      })
    ]));
    expect(body.recentUserAgents.every((record) => record.target === "surge" || record.target === "clash" || record.target === "stash")).toBe(true);
    expect(body.recentUserAgents.some((record) => "count" in record)).toBe(false);
    const recentRecordKeys = [...kv.keys()].filter((key) => key.startsWith("stats:config:recentFetch:"));
    expect(recentRecordKeys).toHaveLength(7);
    expect(kv.has("stats:config:recentFetches")).toBe(false);
  });

  it("keeps repeated config fetch records as individual rows", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    const env = makeEnv(kv);
    for (const [url, userAgent] of [
      ["https://subpilot.example.com/sync/read-token/", "Surge Mac/11390"],
      ["https://subpilot.example.com/sync/read-token/", "Mihomo/1"]
    ] as const) {
      const exec = makeExecutionContext();
      const response = await worker.fetch(new Request(url, {
        headers: {
          "cf-connecting-ip": "198.51.100.7",
          "user-agent": userAgent
        }
      }), env, exec.ctx);
      expect(response.status).toBe(200);
      await Promise.all(exec.waitUntil);
    }
    for (let index = 0; index < 6; index += 1) {
      const exec = makeExecutionContext();
      const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/", {
        headers: {
          "cf-connecting-ip": "198.51.100.7",
          "user-agent": "Surge Mac/11390"
        }
      }), env, exec.ctx);
      expect(response.status).toBe(200);
      await Promise.all(exec.waitUntil);
    }
    const session = await createSession(env);

    const statsResponse = await worker.fetch(new Request("https://subpilot.example.com/api/stats", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const body = await statsResponse.json<{ recentUserAgents: Array<{ target: string; userAgent: string }> }>();
    const surgeRows = body.recentUserAgents.filter((record) => record.target === "surge" && record.userAgent === "Surge Mac/11390");
    const clashRows = body.recentUserAgents.filter((record) => record.target === "clash" && record.userAgent === "Mihomo/1");

    expect(statsResponse.status).toBe(200);
    expect(body.recentUserAgents).toHaveLength(8);
    expect(surgeRows).toHaveLength(7);
    expect(clashRows).toHaveLength(1);
    expect(body.recentUserAgents.some((record) => "count" in record)).toBe(false);
    expect([...kv.keys()].filter((key) => key.startsWith("stats:config:recentFetch:"))).toHaveLength(8);
  });

  it("keeps at most 500 stored config fetch records by pruning the oldest keys", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);

    vi.useFakeTimers();
    try {
      for (let index = 0; index < 501; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 5, 21, 0, 0, index)));
        await recordConfigFetch(env, index % 2 === 0 ? "surge" : "clash", new Request("https://subpilot.example.com/sync/read-token/", {
          headers: {
            "cf-connecting-ip": "198.51.100.7",
            "user-agent": `Fetch Client/${index}`
          }
        }));
      }
    } finally {
      vi.useRealTimers();
    }

    const recentRecordKeys = [...kv.keys()].filter((key) => key.startsWith("stats:config:recentFetch:"));
    expect(recentRecordKeys).toHaveLength(500);
    expect(recentRecordKeys.some((key) => key.includes("2026-06-21T00:00:00.000Z"))).toBe(false);
    expect(recentRecordKeys.some((key) => key.includes("2026-06-21T00:00:01.000Z"))).toBe(true);
  });

  it("keeps reading legacy recent fetch records from the aggregate key", async () => {
    const kv = new Map<string, string>();
    kv.set("stats:config:recentFetches", JSON.stringify([{
      target: "surge",
      userAgent: "Legacy Surge/1",
      ipAddress: "203.0.113.10",
      location: { countryCode: "US", city: "New York", label: "New York, US", source: "cloudflare" },
      fetchedAt: "2026-06-20T12:00:00.000Z"
    }]));
    const env = makeEnv(kv);
    const session = await createSession(env);

    const statsResponse = await worker.fetch(new Request("https://subpilot.example.com/api/stats", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const body = await statsResponse.json<{ recentUserAgents: Array<{ target: string; userAgent: string; ipAddress: string }> }>();

    expect(statsResponse.status).toBe(200);
    expect(body.recentUserAgents).toEqual([expect.objectContaining({
      target: "surge",
      userAgent: "Legacy Surge/1",
      ipAddress: "203.0.113.10"
    })]);
  });

  it("rejects legacy, malformed, invalid-token, and explicit-target subscription links", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    const env = makeEnv(kv);

    const cases = [
      {
        url: "https://subpilot.example.com/sync/read-token?target=surge",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token?target=clash",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token?target=stash",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/wrong-token/",
        status: 400,
        error: "Invalid subscription token"
      },
      {
        url: "https://subpilot.example.com/sync/wrong-token/surge",
        status: 400,
        error: "Invalid subscription token"
      },
      {
        url: "https://subpilot.example.com/sync/wrong-token?target=surge",
        status: 400,
        error: "Invalid subscription token"
      },
      {
        url: "https://subpilot.example.com/sync/read-token",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync//read-token/surge",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge/",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/stash",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/stash/",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge?foo=bar",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/SubPilot.conf",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/unknown",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge-resources",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge-resources/",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge-resources/?foo=bar",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge-resources/Proxy/",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read-token/surge-resources/Proxy.list?foo=bar",
        status: 403,
        error: "Invalid subscription path"
      },
      {
        url: "https://subpilot.example.com/sync/read%20token/surge",
        status: 400,
        error: "Invalid subscription token"
      }
    ];

    for (const item of cases) {
      const response = await worker.fetch(new Request(item.url), env, ctx);
      const body = await response.json<{ error: string }>();

      expect(response.status).toBe(item.status);
      expect(body.error).toBe(item.error);
    }

    const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/surge", {
      headers: { "user-agent": "Surge iOS" }
    }), env, ctx);
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Invalid subscription path");
  });

  it("serves automatic target subscriptions from the token trailing slash path", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    const env = makeEnv(kv);
    for (const { userAgent, fileName } of [
      { userAgent: "Mihomo/1", fileName: "SubPilot.yaml" },
      { userAgent: "Stash/2.0 Clash.Meta", fileName: "subpilot-stash.yaml" }
    ]) {
      const exec = makeExecutionContext();
      const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/", {
        headers: { "user-agent": userAgent }
      }), env, exec.ctx);
      await Promise.all(exec.waitUntil);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(`inline; filename=${fileName}`);
    }
  });

  it("rejects removed Surge resource endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("JP 1 = trojan, jp.example.com, 443, password=p"));
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    const env = makeEnv(kv);
    const exec = makeExecutionContext();

    const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/surge-resources/Proxy.list", {
      headers: { "user-agent": "curl/8.0" }
    }), env, exec.ctx);
    const body = await response.json<{ error: string }>();
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(403);
    expect(body.error).toBe("Invalid subscription path");
    expect(kv.has("stats:config:lastFetched:surgeResource")).toBe(false);
    expect(kv.has("stats:config:lastFetched:surge")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects automatic subscriptions when user-agent cannot be inferred", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    const env = makeEnv(kv);

    const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/", {
      headers: { "user-agent": "TestClient/1" }
    }), env, ctx);

    expect(response.status).toBe(401);
  });

  it("uses the configured managed base URL path as the strict subscription entry", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    kv.set("config:settings:managedBaseUrl", JSON.stringify("https://subpilot.example.com/sywwqnc"));
    const env = makeEnv(kv);
    const exec = makeExecutionContext();

    const response = await worker.fetch(new Request("https://subpilot.example.com/sywwqnc/read-token/", {
      headers: { "user-agent": "Mihomo/1" }
    }), env, exec.ctx);
    const body = await response.text();
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("inline; filename=SubPilot.yaml");
    expect(body).toContain("proxies:");
  });

  it("rejects default or malformed subscription links when managed base URL uses another path", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    kv.set("config:settings:managedBaseUrl", JSON.stringify("https://subpilot.example.com/sywwqnc"));
    const env = makeEnv(kv);

    for (const url of [
      "https://subpilot.example.com/sync/read-token/",
      "https://subpilot.example.com/sywwqnc/read-token/121"
    ]) {
      const response = await worker.fetch(new Request(url), env, ctx);
      const body = await response.json<{ error: string }>();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Invalid subscription path");
    }
  });

  it("uses a real read token URL in Surge previews", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/sub") {
        return new Response("JP 1 = trojan, jp.example.com, 443, password=p");
      }
      return new Response("not found", { status: 404 });
    });
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=surge", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const body = await response.json<{ content: string }>();

    expect(response.status).toBe(200);
    expect(body.content).toMatch(/^#!MANAGED-CONFIG https:\/\/subpilot\.example\.com\/sync\/[A-Za-z0-9_-]+\/ interval=43200 strict=true/m);
    expect(body.content).toContain("[Proxy]\n[Primary] JP 01 = trojan, jp.example.com, 443");
    expect(body.content).not.toContain("policy-path=");
    expect(body.content).not.toContain("surge-resources");
    expect(body.content).not.toContain("/preview/");
    expect(body.content).not.toContain("/api/preview");
  });

  it("uses the configured managed base URL in Surge previews", async () => {
    const kv = new Map<string, string>();
    kv.set("config:settings:managedBaseUrl", JSON.stringify("https://links.example.com/sywwqnc/"));
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://links.example.com/sywwqnc/"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/sub") {
        return new Response("JP 1 = trojan, jp.example.com, 443, password=p");
      }
      return new Response("not found", { status: 404 });
    });
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://admin.example.com/api/preview?target=surge", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const body = await response.json<{ content: string }>();

    expect(response.status).toBe(200);
    expect(body.content).toMatch(/^#!MANAGED-CONFIG https:\/\/links\.example\.com\/sywwqnc\/[A-Za-z0-9_-]+\/ interval=43200 strict=true/m);
    expect(body.content).toContain("[Proxy]\n[Primary] JP 01 = trojan, jp.example.com, 443");
    expect(body.content).not.toContain("policy-path=");
    expect(body.content).not.toContain("surge-resources");
    expect(body.content).not.toContain("https://admin.example.com/");
    expect(body.content).not.toContain("/sywwqnc//");
  });

  it("rejects invalid preview targets and requests without an inferred target", async () => {
    const env = makeEnv();
    const session = await createSession(env);

    const invalidTargetResponse = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=unknown", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const invalidTargetBody = await invalidTargetResponse.json<{ error: string }>();

    expect(invalidTargetResponse.status).toBe(400);
    expect(invalidTargetBody.error).toBe("Invalid target");

    const missingTargetResponse = await worker.fetch(new Request("https://subpilot.example.com/api/preview", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "user-agent": "Mozilla/5.0"
      },
      body: "{}"
    }), env, ctx);
    const missingTargetBody = await missingTargetResponse.json<{ error: string }>();

    expect(missingTargetResponse.status).toBe(400);
    expect(missingTargetBody.error).toBe("Missing target");

    const stashPreviewResponse = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=stash", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const stashPreviewBody = await stashPreviewResponse.json<{ content: string }>();

    expect(stashPreviewResponse.status).toBe(200);
    expect(stashPreviewBody.content).toMatch(/^#SUBSCRIBED https:\/\/subpilot\.example\.com\/sync\/[A-Za-z0-9_-]+\/\n# Last Updated:/);
    expect(stashPreviewBody.content).toContain("proxies:");
    expect(stashPreviewBody.content).not.toContain("/api/preview");
    expect(stashPreviewBody.content).not.toContain("ca-p12");
    expect(stashPreviewBody.content).not.toContain("ca-passphrase");
  });

  it("reports and refreshes upstream source cache", async () => {
    const kv = new Map<string, string>();
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    kv.set("cache:source:stale", "stale-content");
    kv.set("cache:sourceMeta:stale", JSON.stringify({ key: "cache:source:stale", fetchedAt, sourceId: "stale", sourceName: "Stale" }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{ key: "cache:source:stale", fetchedAt, sourceId: "stale", sourceName: "Stale" }]));
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };

    const statsResponse = await worker.fetch(new Request("https://subpilot.example.com/api/stats", { headers }), env, ctx);
    const stats = await statsResponse.json<{
      sourceCache: {
        count: number;
        updatedAt: string | null;
        expectedCount: number;
        cachedSourceCount: number;
        allSourcesCached: boolean;
        totalNodes: number;
        protocolCounts: Array<{ protocol: string; count: number }>;
        sources: Array<{ sourceId: string; sourceName: string; cached: boolean; fetchedAt: string | null; nodeCount: number }>;
      };
    }>();
    expect(stats.sourceCache.count).toBe(1);
    expect(stats.sourceCache.updatedAt).toBe(fetchedAt);
    expect(stats.sourceCache).toMatchObject({
      expectedCount: 1,
      cachedSourceCount: 0,
      allSourcesCached: false,
      totalNodes: 0
    });
    expect(stats.sourceCache.sources).toEqual([{
      sourceId: "src1",
      sourceName: "Primary",
      cached: false,
      fetchedAt: null,
      nodeCount: 0
    }]);

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(new Response("temporary unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Proxy = trojan, proxy.example.com, 443, password=p"));
    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/cache/source/refresh", {
      method: "POST",
      headers
    }), env, ctx);
    const refreshed = await refreshResponse.json<{
      refreshed: number;
      failed: number;
      deleted: number;
      sourceCache: {
        expectedCount: number;
        cachedSourceCount: number;
        allSourcesCached: boolean;
        totalNodes: number;
        protocolCounts: Array<{ protocol: string; count: number }>;
      };
    }>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;

    expect(refreshResponse.status).toBe(200);
    expect(refreshed).toMatchObject({ refreshed: 1, failed: 0, deleted: 1 });
    expect(refreshed.sourceCache).toMatchObject({
      expectedCount: 1,
      cachedSourceCount: 1,
      allSourcesCached: true,
      totalNodes: 1
    });
    expect(refreshed.sourceCache.protocolCounts).toEqual([{ protocol: "trojan", count: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/sub", { headers: { "user-agent": "Surge iOS/3727" } });
    expect(kv.get(sourceKey)).toBe("Proxy = trojan, proxy.example.com, 443, password=p");
    expect(kv.has("cache:source:stale")).toBe(false);
    expect(kv.has("cache:sourceMeta:stale")).toBe(false);
  });

  it("keeps the previous source cache when all retry attempts fail", async () => {
    const kv = new Map<string, string>();
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    kv.set(sourceKey, "previous-content");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt,
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt,
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream error", { status: 500 }));

    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/cache/source/refresh", {
      method: "POST",
      headers
    }), env, ctx);
    const refreshed = await refreshResponse.json<{
      refreshed: number;
      failed: number;
      cached: number;
      warnings: string[];
      failures: { sourceId: string; sourceName: string; reason: string; usedCachedContent: boolean }[];
    }>();

    expect(refreshResponse.status).toBe(200);
    expect(refreshed).toMatchObject({ refreshed: 0, failed: 1, cached: 1 });
    expect(refreshed.warnings[0]).toContain("Primary: HTTP 500");
    expect(refreshed.failures).toEqual([{
      sourceId: "src1",
      sourceName: "Primary",
      reason: "HTTP 500",
      usedCachedContent: true
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(kv.get(sourceKey)).toBe("previous-content");
  });

  it("sends Telegram notifications when a Telegram bot token is configured", async () => {
    const kv = new Map<string, string>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    kv.set(sourceKey, "previous-content");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeTestEnv(kv).env;
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramChatId: "123456",
        notificationTelegramBotToken: "telegram-token"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/cache/source/refresh", {
      method: "POST",
      headers
    }), env, ctx);
    const refreshed = await refreshResponse.json<{
      failed: number;
      notification: { telegram: string; warnings: string[] };
    }>();

    expect(refreshResponse.status).toBe(200);
    expect(refreshed.failed).toBe(1);
    expect(refreshed.notification).toMatchObject({ telegram: "sent", warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("https://api.telegram.org/bottelegram-token/sendMessage");
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body ?? "{}")) as { text?: string };
    expect(telegramBody.text).toContain("失败订阅源：");
    expect(telegramBody.text).toContain("上游缓存：1 / 1 个启用源已缓存，全部就绪");
    expect(telegramBody.text).toContain("缓存更新时间：2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("协议节点：未解析到节点");
    expect(telegramBody.text).toContain("名称：Primary");
    expect(telegramBody.text).toContain("ID：src1");
    expect(telegramBody.text).toContain("原因：HTTP 500");
    expect(telegramBody.text).toContain("处理：已沿用旧缓存");
    expect(telegramBody.text).not.toContain("2026-06-20T01:00:00.000Z");
    expect(telegramBody.text).not.toContain("UTC+8");
  });

  it("generates a one-time Telegram bind command and registers the webhook", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/bind-code", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({ token: "telegram-token" })
    }), env, ctx);
    const result = await response.json<{
      code: string;
      command: string;
      expiresAt: string;
      config: typeof DEFAULT_CONFIG;
    }>();

    expect(response.status).toBe(200);
    expect(result.code).toMatch(/^[A-Z0-9]{10}$/);
    expect(result.command).toBe(`/bind ${result.code}`);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(kv.get("auth:telegram_bind")).not.toContain(result.code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/setWebhook");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("url")).toBe("https://subpilot.example.com/api/telegram/webhook");
    expect(body.get("drop_pending_updates")).toBe("true");
    expect(result.config.settings.notificationChannel).toBe("telegram");
    expect(result.config.settings.notificationTelegramBotToken).toBe("telegram-token");
    expect(result.config.settings.notificationTelegramWebhookSecret).toBe(body.get("secret_token"));
  });

  it("blocks Telegram bind command generation and chat unbinding without an admin session", async () => {
    const env = makeEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const bindResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/bind-code", {
      method: "POST",
      body: JSON.stringify({ token: "telegram-token" })
    }), env, ctx);

    const unbindResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/unbind", {
      method: "POST"
    }), env, ctx);

    expect(bindResponse.status).toBe(401);
    expect(unbindResponse.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers a Telegram webhook when saving Telegram notification settings", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({
        settings: {
          notificationChannel: "telegram",
          notificationTelegramBotToken: "telegram-token"
        }
      })
    }), env, ctx);
    const saved = await response.json<typeof DEFAULT_CONFIG>();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/setWebhook");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("url")).toBe("https://subpilot.example.com/api/telegram/webhook");
    expect(body.get("drop_pending_updates")).toBe("true");
    expect(body.get("allowed_updates")).toBe(JSON.stringify(["message", "edited_message", "channel_post", "edited_channel_post"]));
    expect(body.get("secret_token")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(saved.settings.notificationTelegramWebhookSecret).toBe(body.get("secret_token"));
  });

  it("clears Telegram chat binding without removing webhook settings", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "-1001234567890",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex("ABC123XYZ9"),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/unbind", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const saved = await response.json<typeof DEFAULT_CONFIG>();

    expect(response.status).toBe(200);
    expect(saved.settings.notificationChannel).toBe("telegram");
    expect(saved.settings.notificationTelegramChatId).toBe("");
    expect(saved.settings.notificationTelegramBotToken).toBe("telegram-token");
    expect(saved.settings.notificationTelegramWebhookSecret).toBe("webhook-secret");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.toBeNull();
  });

  it("records Telegram chat id from a valid one-time bind command", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const code = "ABC123XYZ9";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: `/bind ${code}`,
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Ops Group"
          }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("-1001234567890");
    expect(saved.settings.notificationTelegramBotToken).toBe("telegram-token");
    expect(saved.settings.notificationTelegramWebhookSecret).toBe("webhook-secret");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
      chat_id: "-1001234567890",
      text: "SubPilot Telegram 通知已绑定成功。"
    });
  });

  it("ignores Telegram bind commands after a chat is already bound", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const code = "ABC123XYZ9";
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 2,
        message: {
          text: `/bind ${code}`,
          chat: { id: 999999, type: "private", first_name: "Other" }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("123456");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("responds to Telegram status commands from the bound chat", async () => {
    const kv = new Map<string, string>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    kv.set(sourceKey, "Proxy = trojan, proxy.example.com, 443, password=p\nVMess = vmess, vmess.example.com, 443, username=00000000-0000-0000-0000-000000000001");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt,
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt,
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeEnv(kv);
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 3,
        message: {
          text: "/status",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as { chat_id?: string; text?: string };
    expect(telegramBody.chat_id).toBe("123456");
    expect(telegramBody.text).toContain("SubPilot 状态");
    expect(telegramBody.text).toContain("订阅源：启用 1 / 停用 0");
    expect(telegramBody.text).toContain("上游缓存：1 / 1 个启用源已缓存，全部就绪");
    expect(telegramBody.text).toContain("缓存更新时间：2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("协议节点：trojan 1，vmess 1，总计 2");
    expect(telegramBody.text).toContain("Primary：已缓存，2 个节点，2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("最近 Surge 配置获取：");
    expect(telegramBody.text).toContain("最近 Clash 配置获取：");
    expect(telegramBody.text).not.toContain("2026-06-20T01:00:00.000Z");
    expect(telegramBody.text).not.toContain("UTC+8");
    expect(telegramBody.text).not.toContain("Chat ID");
  });

  it("limits Telegram recent fetch output to five configured-time-zone rows", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret",
        displayTimeZone: "UTC"
      }
    });

    vi.useFakeTimers();
    try {
      for (let index = 0; index < 6; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 5, 20, 0, 0, index)));
        await recordConfigFetch(env, index % 2 === 0 ? "surge" : "clash", new Request("https://subpilot.example.com/sync/read-token/", {
          headers: {
            "cf-connecting-ip": "198.51.100.7",
            "user-agent": `Recent Client/${index}`
          }
        }));
      }
    } finally {
      vi.useRealTimers();
    }

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 4,
        message: {
          text: "/recent",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as { text?: string };
    expect(telegramBody.text).toContain("最近配置拉取：");
    expect(telegramBody.text).toContain("1. Clash 配置，2026-06-20 00:00:05，UA：Recent Client/5");
    expect(telegramBody.text).toContain("5. Clash 配置，2026-06-20 00:00:01，UA：Recent Client/1");
    expect(telegramBody.text).not.toContain("Recent Client/0");
    expect(telegramBody.text).not.toContain("2026-06-20T00:00:05.000Z");
    expect(telegramBody.text).not.toContain("UTC+8");
  });

  it("ignores Telegram commands from chats that are not bound", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 4,
        message: {
          text: "/status",
          chat: { id: 999999, type: "private", first_name: "Other" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exec.waitUntil).toHaveLength(0);
  });

  it("silently ignores Telegram commands before a chat is bound", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 5,
        message: {
          text: "/status",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exec.waitUntil).toHaveLength(0);
  });

  it("refreshes upstream source cache from the bound Telegram chat", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response("Proxy = trojan, proxy.example.com, 443, password=p"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 5,
        message: {
          text: "/refresh",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://example.com/sub");
    const doneBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as { text?: string };
    expect(doneBody.text).toContain("上游订阅源强制获取完成");
    expect(doneBody.text).toContain("刷新成功：1");
    expect(doneBody.text).toContain("刷新失败：0");
    expect(doneBody.text).toContain("上游缓存：1 / 1 个启用源已缓存，全部就绪");
    expect(doneBody.text).toContain("协议节点：trojan 1，总计 1");
  });

  it("continues Telegram refresh when the start message fails", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "message failed" })))
      .mockResolvedValueOnce(new Response("Proxy = trojan, proxy.example.com, 443, password=p"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 6,
        message: {
          text: "/refresh",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://example.com/sub");
    const doneBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as { text?: string };
    expect(doneBody.text).toContain("上游订阅源强制获取完成");
    expect(doneBody.text).toContain("刷新成功：1");
  });

  it("does not record Telegram chat id from read tokens or invalid bind codes", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex("ABC123XYZ9"),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const readTokenResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: "read-token",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, ctx);
    const wrongCodeResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 2,
        message: {
          text: "/bind WRONG1",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(readTokenResponse.status).toBe(200);
    expect(wrongCodeResponse.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
      chat_id: "123456",
      text: "绑定失败：请在 SubPilot 后台重新生成绑定命令，并在 10 分钟内发送完整的 /bind 命令。"
    });
  });

  it("does not record Telegram chat id from expired bind codes", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const code = "ABC123XYZ9";
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: `/bind ${code}`,
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
      chat_id: "123456",
      text: "绑定失败：请在 SubPilot 后台重新生成绑定命令，并在 10 分钟内发送完整的 /bind 命令。"
    });
  });

  it("rejects Telegram webhook requests with an invalid secret", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret"
      },
      body: JSON.stringify({ update_id: 1 })
    }), env, ctx);

    expect(response.status).toBe(403);
  });

  it("deletes the Telegram webhook when the Telegram bot token is cleared", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({
        settings: {
          notificationTelegramBotToken: ""
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/deleteWebhook");
    expect(saved.settings.notificationChannel).toBe("off");
    expect(saved.settings.notificationTelegramChatId).toBe("");
    expect(saved.settings.notificationTelegramWebhookSecret).toBe("");
  });

  it("does not send channel notifications when no Telegram bot token is configured", async () => {
    const kv = new Map<string, string>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    kv.set(sourceKey, "previous-content");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeTestEnv(kv).env;
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "off",
        notificationTelegramChatId: "123456",
        notificationTelegramBotToken: ""
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream error", { status: 500 }));

    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/cache/source/refresh", {
      method: "POST",
      headers
    }), env, ctx);
    const refreshed = await refreshResponse.json<{
      failed: number;
      notification: { telegram: string; warnings: string[] };
    }>();

    expect(refreshResponse.status).toBe(200);
    expect(refreshed.failed).toBe(1);
    expect(refreshed.notification).toMatchObject({ telegram: "disabled", warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports source cache entries missing from the metadata index", async () => {
    const kv = new Map<string, string>();
    const fetchedAtA = "2026-06-20T01:00:00.000Z";
    const fetchedAtB = "2026-06-20T01:05:00.000Z";
    kv.set("cache:source:a", "subscription-a");
    kv.set("cache:source:b", "subscription-b");
    kv.set("cache:sourceMeta:a", JSON.stringify({ key: "cache:source:a", fetchedAt: fetchedAtA, sourceId: "a", sourceName: "A" }));
    kv.set("cache:sourceMeta:b", JSON.stringify({ key: "cache:source:b", fetchedAt: fetchedAtB, sourceId: "b", sourceName: "B" }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{ key: "cache:source:a", fetchedAt: fetchedAtA, sourceId: "a", sourceName: "A" }]));
    const env = makeEnv(kv);
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/stats", { headers }), env, ctx);
    const stats = await response.json<{ sourceCache: { count: number; updatedAt: string | null } }>();

    expect(stats.sourceCache.count).toBe(2);
    expect(stats.sourceCache.updatedAt).toBe(fetchedAtB);
  });

  it("refreshes upstream source cache from the scheduled handler", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Proxy = trojan, proxy.example.com, 443, password=p"));

    await worker.scheduled?.({
      cron: "0 */12 * * *",
      scheduledTime: Date.now()
    } as ScheduledController, env, ctx);

    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    expect(kv.get(sourceKey)).toBe("Proxy = trojan, proxy.example.com, 443, password=p");
  });

  it("keeps Static-IP out of default groups and rules", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const session = await createSession(env);
    const groups = { ...DEFAULT_CONFIG.groups };

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({ groups, disabledGroups: [] })
    }), env, ctx);
    const body = await response.json<{
      groups: Record<string, string>;
      surge: { rules: string[] };
      clash: { rules: string[] };
      stash: { rules: string[] };
    }>();

    expect(response.status).toBe(200);
    expect(body.groups).not.toHaveProperty("Static-IP");
    expect(body.groups).toHaveProperty("Static");
    expect(body.surge.rules.some((rule) => rule.includes("Static-IP"))).toBe(false);
    expect(body.clash.rules.some((rule) => rule.includes("Static-IP"))).toBe(false);
    expect(body.stash.rules.some((rule) => rule.includes("Static-IP"))).toBe(false);
    expect(body.surge.rules).toContain("RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Google/Google.list,Static,extended-matching");
    expect(body.clash.rules).toContain("RULE-SET,Google,Static");
    expect(body.stash.rules).toContain("RULE-SET,Google,Static");
    expect(JSON.parse(kv.get("config:groups:index") ?? "[]")).not.toContain("Static-IP");
    expect(kv.has("config:groups:Static-IP")).toBe(false);
  });
});
