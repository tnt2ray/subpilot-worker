import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createSession, sessionCookie } from "../src/auth";
import { CONFIG_SCHEMA_VERSION_KEY } from "../src/config-schema";
import { saveConfig } from "../src/config-store";
import { decryptText } from "../src/crypto-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { recordConfigFetch } from "../src/fetch-stats";
import type { AppConfig } from "../src/types";
import { sha256Hex } from "../src/util";
import { restoreMocksAfterEach } from "./helpers/fetch";
import { ctx, makeEnv, makeExecutionContext } from "./helpers/worker";

restoreMocksAfterEach();

async function expectEncryptedSourceCache(
  kv: Map<string, string>,
  key: string,
  expectedContent: string
): Promise<void> {
  const stored = kv.get(key);
  const prefix = "\u001fsubpilot-encrypted-cache:";
  expect(stored?.startsWith(prefix)).toBe(true);
  await expect(decryptText("config-secret", String(stored).slice(prefix.length))).resolves.toBe(expectedContent);
}

describe("asset access control", () => {
  it("rejects oversized login bodies from declared length and bounded streaming reads", async () => {
    const env = makeEnv();
    const declared = await worker.fetch(new Request("https://subpilot.example.com/api/login", {
      method: "POST",
      headers: { "content-length": "5000" },
      body: "{}"
    }), env, ctx);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ token: "x".repeat(5000) })));
        controller.close();
      }
    });
    const streamedRequest = new Request("https://subpilot.example.com/api/login", {
      method: "POST",
      body: stream,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const streamed = await worker.fetch(streamedRequest, env, ctx);

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
    await expect(declared.json()).resolves.toEqual({ error: "Login request body is too large" });
    await expect(streamed.json()).resolves.toEqual({ error: "Login request body is too large" });
  });

  it("treats non-object login JSON as an invalid token", async () => {
    const env = makeEnv();
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/login", {
      method: "POST",
      body: "null"
    }), env, ctx);

    expect(response.status).toBe(401);
  });

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

    for (const path of [
      "/app.js",
      "/app-constants.js",
      "/app-i18n.js",
      "/app-policy-group-spec.js",
      "/app-preview-warnings.js",
      "/app-validation.js",
      "/app-proxy-node-drafts.js",
      "/app-yaml.js",
      "/styles.css"
    ]) {
      await expect(worker.fetch(new Request(`https://subpilot.example.com${path}`), env, ctx)
        .then((response) => response.status)).resolves.toBe(401);
    }

    const session = await createSession(env);
    const appRequest = new Request("https://subpilot.example.com/", {
      headers: { cookie: sessionCookie(session, true) }
    });
    const appResponse = await worker.fetch(appRequest, env, ctx);
    const appHtml = await appResponse.text();

    expect(appResponse.status).toBe(200);
    expect(appHtml).toContain("配置链接");
    expect(appHtml).toContain("/app.js");

    for (const [path, content] of [
      ["/app-policy-group-spec.js", "splitPolicyGroupSpec"],
      ["/app-preview-warnings.js", "groupPreviewWarnings"],
      ["/app-validation.js", "validateStashScriptLines"]
    ]) {
      const moduleResponse = await worker.fetch(new Request(`https://subpilot.example.com${path}`, {
        headers: { cookie: sessionCookie(session, true) }
      }), env, ctx);
      await expect(moduleResponse.text()).resolves.toContain(content);
    }
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

  it("rejects invalid Surge Map Local while saving config", async () => {
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
          mapLocal: ["^https://example\\.com data-type=unknown data=\"{}\""]
        }
      })
    });

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Surge Map Local");
  });

  it("rejects invalid Stash scripts while saving config", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const request = new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        stash: {
          scripts: ["Bad Script = type=http-response,pattern=^https://example.com,script-path=ftp://example.com/script.js"]
        }
      })
    });

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Stash Script");
    expect(body.error).toContain("script-path");
  });

  it("returns a bounded client error when malformed nested patches reach sanitization", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        groups: { Proxy: "select, {all}" },
        surge: { tailscaleNodes: null }
      })
    }), env, ctx);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid config patch" });
  });

  it("rejects top-level config arrays for PUT and PATCH", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/json"
    };

    for (const method of ["PUT", "PATCH"] as const) {
      const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
        method,
        headers,
        body: "[]"
      }), env, ctx);

      expect(response.status).toBe(400);
    }
  });

  it("ignores removed Shadowrocket config patches", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/json"
    };

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        shadowrocket: {
          general: ["bypass-system = true"],
          hosts: ["example.com = 192.0.2.1"],
          headerRewrite: ["^https?:\\/\\/example\\.com\\/api request-header-set X-Test test"],
          scripts: ["Shadowrocket Script = type=http-response,pattern=^https://example.com,script-path=https://example.com/script.js"],
          mitm: { hostname: ["example.com"] },
          rules: ["DOMAIN-SUFFIX,example.com,DIRECT", "FINAL,Proxy"]
        }
      })
    }), env, ctx);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("shadowrocket");

    const persistedResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const persisted = await persistedResponse.json<Record<string, unknown>>();
    expect(persisted).not.toHaveProperty("shadowrocket");
  });

  it("rejects proxy node and policy group name conflicts while saving config", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/json"
    };

    const proxyNodeResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        proxyNodes: [{
          id: "proxy",
          config: "Proxy = socks5, 1.1.1.1, 1080",
          chainFilter: [],
          enabled: true,
          chainExit: false,
          includeInGroups: true
        }]
      })
    }), env, ctx);
    const proxyNodeBody = await proxyNodeResponse.json<{ error: string }>();

    expect(proxyNodeResponse.status).toBe(400);
    expect(proxyNodeBody.error).toBe("代理节点名称 Proxy 不能和策略组名称相同");

    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      proxyNodes: [{
        id: "exit",
        config: "Manual = socks5, 1.1.1.1, 1080",
        chainFilter: [],
        enabled: true,
        chainExit: false,
        includeInGroups: true
      }]
    });

    const groupResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        groups: {
          ...DEFAULT_CONFIG.groups,
          Manual: "select, {all}"
        },
        disabledGroups: []
      })
    }), env, ctx);
    const groupBody = await groupResponse.json<{ error: string }>();

    expect(groupResponse.status).toBe(400);
    expect(groupBody.error).toBe("代理节点名称 Manual 不能和策略组名称相同");
  });

  it("rejects invalid or duplicate compiled rule set names while saving config", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/json"
    };
    const output = {
      name: "AI Rules",
      enabled: true,
      policy: "Proxy",
      sourceIds: [],
      inlineRules: [],
      order: 0,
      surgeOptions: []
    };

    const duplicateResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ruleSets: {
          outputs: [output, { ...output, name: " AI   Rules ", order: 1 }]
        }
      })
    }), env, ctx);
    const duplicateBody = await duplicateResponse.json<{ error: string }>();

    expect(duplicateResponse.status).toBe(400);
    expect(duplicateBody.error).toBe("规则集名称 AI Rules 不能重复");

    const invalidResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ruleSets: {
          outputs: [{ ...output, name: ".." }]
        }
      })
    }), env, ctx);
    const invalidBody = await invalidResponse.json<{ error: string }>();

    expect(invalidResponse.status).toBe(400);
    expect(invalidBody.error).toBe("规则集名称不能为空，也不能使用 . 或 ..");

    const conflictingResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ruleSets: {
          outputs: [output, { ...output, name: "AI Rules-domain", order: 1 }]
        }
      })
    }), env, ctx);
    const conflictingBody = await conflictingResponse.json<{ error: string }>();

    expect(conflictingResponse.status).toBe(400);
    expect(conflictingBody.error).toBe("规则集名称 AI Rules 与 AI Rules-domain 会生成冲突文件名");

    const aggregateConflictResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ruleSets: {
          aggregateByPolicy: true,
          outputs: [
            { ...output, name: "First", policy: "Shared", order: 0 },
            { ...output, name: "Second", policy: "Shared-domain", order: 1 }
          ]
        }
      })
    }), env, ctx);
    const aggregateConflictBody = await aggregateConflictResponse.json<{ error: string }>();
    expect(aggregateConflictResponse.status).toBe(400);
    expect(aggregateConflictBody.error).toBe("规则集名称 Shared 与 Shared-domain 会生成冲突文件名");

    const toggleResponse = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ruleSets: { aggregateByPolicy: true } })
    }), env, ctx);
    const toggled = await toggleResponse.json<AppConfig>();
    expect(toggleResponse.status).toBe(200);
    expect(toggled.ruleSets.aggregateByPolicy).toBe(true);
  });

  it("records config fetch timestamps and recent user agents", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    kv.set("geoip:ip:198.51.100.7", JSON.stringify({ city: { names: { en: "Singapore" } }, country: { iso_code: "SG" } }));
    const env = makeEnv(kv);
    const userAgents = ["Surge TestClient/0", "Mihomo TestClient/1", "Stash TestClient/2", "Surge TestClient/3", "Mihomo TestClient/4", "Surge TestClient/5", "Mihomo TestClient/6", "Shadowrocket TestClient/7"];
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
    expect(body.lastFetched.shadowrocket).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect("surgeResource" in body.lastFetched).toBe(false);
    expect(body.recentUserAgents).toHaveLength(8);
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
      }),
      expect.objectContaining({
        target: "shadowrocket",
        userAgent: "Shadowrocket TestClient/7"
      })
    ]));
    expect(body.recentUserAgents.every((record) => record.target === "surge" || record.target === "clash" || record.target === "stash" || record.target === "shadowrocket")).toBe(true);
    expect(body.recentUserAgents.some((record) => "count" in record)).toBe(false);
    const recentRecordKeys = [...kv.keys()].filter((key) => key.startsWith("stats:config:recentFetch:"));
    expect(recentRecordKeys).toHaveLength(8);
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
        url: "https://subpilot.example.com/sync/read-token?target=shadowrocket",
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
        url: "https://subpilot.example.com/sync/read-token/Unknown.conf",
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
      { userAgent: "Stash/2.0 Clash.Meta", fileName: "subpilot-stash.yaml" },
      { userAgent: "Shadowrocket/2.2.68", fileName: "SubPilot.yaml" }
    ]) {
      const exec = makeExecutionContext();
      const response = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/", {
        headers: { "user-agent": userAgent }
      }), env, exec.ctx);
      const body = await response.text();
      await Promise.all(exec.waitUntil);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(`inline; filename="${fileName}"`);
      if (userAgent.includes("Shadowrocket")) {
        expect(response.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
        expect(body).toContain("proxies:");
        expect(body).toContain("proxy-groups:");
        expect(body).toContain("rules:");
      }
    }
  });

  it("serves subscriptions from compatible config file name paths without using the path as target selection", async () => {
    const kv = new Map<string, string>();
    kv.set("auth:read_token_hash", await sha256Hex("read-token"));
    const env = makeEnv(kv);
    const shadowrocketExec = makeExecutionContext();
    const shadowrocketResponse = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/SubPilot.conf", {
      headers: { "user-agent": "Shadowrocket/2.2.68" }
    }), env, shadowrocketExec.ctx);
    const shadowrocketBody = await shadowrocketResponse.text();
    await Promise.all(shadowrocketExec.waitUntil);

    expect(shadowrocketResponse.status).toBe(200);
    expect(shadowrocketResponse.headers.get("content-disposition")).toBe('inline; filename="SubPilot.yaml"');
    expect(shadowrocketBody).toContain("proxies:");
    expect(kv.get("stats:config:lastFetched:shadowrocket")).toBeDefined();

    const exec = makeExecutionContext();
    const clashResponse = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/SubPilot.conf", {
      headers: { "user-agent": "Mihomo/1" }
    }), env, exec.ctx);
    const clashBody = await clashResponse.text();
    await Promise.all(exec.waitUntil);

    expect(clashResponse.status).toBe(200);
    expect(clashResponse.headers.get("content-disposition")).toBe('inline; filename="SubPilot.yaml"');
    expect(clashBody).toContain("proxies:");

    const invalidNodesResponse = await worker.fetch(new Request("https://subpilot.example.com/sync/read-token/SubPilot.nodes", {
      headers: { "user-agent": "Shadowrocket/2.2.68" }
    }), env, exec.ctx);
    const invalidNodesBody = await invalidNodesResponse.json<{ error: string }>();
    expect(invalidNodesResponse.status).toBe(403);
    expect(invalidNodesBody.error).toBe("Invalid subscription path");
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
    expect(response.headers.get("content-disposition")).toBe('inline; filename="SubPilot.yaml"');
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

  it("includes Surge rule coverage diagnostics in Surge previews", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "RULE-SET,https://rules.example.com/demo.list,Proxy",
          "FINAL,Proxy"
        ]
      }
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://rules.example.com/demo.list") {
        return new Response("DOMAIN,www.example.com");
      }
      return new Response("not found", { status: 404 });
    });
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=surge", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const body = await response.json<{ content: string; warnings: string[] }>();

    expect(response.status).toBe(200);
    expect(body.content).toContain("RULE-SET,https://rules.example.com/demo.list,Proxy");
    expect(body.warnings).toContain("Surge Rule 第 2 行规则集 https://rules.example.com/demo.list 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("includes Clash rule coverage diagnostics in Clash previews", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      clash: {
        ...DEFAULT_CONFIG.clash,
        ruleProviders: [
          "rule-providers:",
          "  Demo:",
          "    type: http",
          "    behavior: domain",
          "    url: https://rules.example.com/demo.yaml"
        ].join("\n"),
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "RULE-SET,Demo,Proxy",
          "MATCH,Proxy"
        ]
      }
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://rules.example.com/demo.yaml") {
        return new Response([
          "payload:",
          "  - '+.example.com'"
        ].join("\n"));
      }
      return new Response("not found", { status: 404 });
    });
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=clash", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const body = await response.json<{ content: string; warnings: string[] }>();

    expect(response.status).toBe(200);
    expect(body.content).toContain("RULE-SET,Demo,Proxy");
    expect(body.warnings).toContain("Clash Rule 第 2 行规则集 Demo 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN-SUFFIX,example.com；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("includes Stash rule coverage diagnostics in Stash previews", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      stash: {
        ...DEFAULT_CONFIG.stash,
        ruleProviders: [
          "rule-providers:",
          "  Demo:",
          "    type: http",
          "    behavior: classical",
          "    url: https://rules.example.com/demo.yaml"
        ].join("\n"),
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "RULE-SET,Demo,Proxy",
          "MATCH,Proxy"
        ]
      }
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://rules.example.com/demo.yaml") {
        return new Response([
          "payload:",
          "  - DOMAIN,www.example.com"
        ].join("\n"));
      }
      return new Response("not found", { status: 404 });
    });
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=stash", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const body = await response.json<{ content: string; warnings: string[] }>();

    expect(response.status).toBe(200);
    expect(body.content).toContain("RULE-SET,Demo,Proxy");
    expect(body.warnings).toContain("Stash Rule 第 2 行规则集 Demo 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
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

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));

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

    const shadowrocketPreviewResponse = await worker.fetch(new Request("https://subpilot.example.com/api/preview?target=shadowrocket", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: "{}"
    }), env, ctx);
    const shadowrocketPreviewBody = await shadowrocketPreviewResponse.json<{ error: string }>();

    expect(shadowrocketPreviewResponse.status).toBe(400);
    expect(shadowrocketPreviewBody.error).toBe("Invalid target");
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
        sources: Array<{ sourceId: string; sourceName: string; cached: boolean; fetchedAt: string | null; nodeCount: number; protocolCounts: Array<{ protocol: string; count: number }> }>;
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
      nodeCount: 0,
      protocolCounts: []
    }]);

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
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
        sources: Array<{ sourceId: string; sourceName: string; cached: boolean; fetchedAt: string | null; nodeCount: number; protocolCounts: Array<{ protocol: string; count: number }> }>;
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
    expect(refreshed.sourceCache.sources).toHaveLength(1);
    expect(refreshed.sourceCache.sources[0]).toMatchObject({
      sourceId: "src1",
      sourceName: "Primary",
      cached: true,
      nodeCount: 1,
      protocolCounts: [{ protocol: "trojan", count: 1 }]
    });
    expect(refreshed.sourceCache.sources[0]?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/sub", expect.objectContaining({ headers: { "user-agent": "Surge iOS/3727" } }));
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await expectEncryptedSourceCache(kv, sourceKey, "Proxy = trojan, proxy.example.com, 443, password=p");
    expect(kv.has("cache:source:stale")).toBe(false);
    expect(kv.has("cache:sourceMeta:stale")).toBe(false);
  });

  it("immediately refreshes changed and added source caches after saving config", async () => {
    const kv = new Map<string, string>();
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [
        {
          id: "stable",
          name: "Stable",
          url: "https://example.com/stable",
          fetchUserAgent: "surge",
          enabled: true
        },
        {
          id: "changed",
          name: "Changed",
          url: "https://example.com/old",
          fetchUserAgent: "surge",
          enabled: true
        }
      ]
    });
    const stableKey = `cache:source:${await sha256Hex("https://example.com/stable|Surge iOS/3727")}`;
    const oldChangedKey = `cache:source:${await sha256Hex("https://example.com/old|Surge iOS/3727")}`;
    const changedKey = `cache:source:${await sha256Hex("https://example.com/new|Surge iOS/3727")}`;
    const addedKey = `cache:source:${await sha256Hex("https://example.com/added|Surge iOS/3727")}`;
    const stableEntry = { key: stableKey, fetchedAt, sourceId: "stable", sourceName: "Stable" };
    const oldChangedEntry = { key: oldChangedKey, fetchedAt, sourceId: "changed", sourceName: "Changed" };
    kv.set(stableKey, "Stable = trojan, stable.example.com, 443, password=p");
    kv.set(oldChangedKey, "Old = trojan, old.example.com, 443, password=p");
    kv.set(`cache:sourceMeta:${stableKey.slice("cache:source:".length)}`, JSON.stringify(stableEntry));
    kv.set(`cache:sourceMeta:${oldChangedKey.slice("cache:source:".length)}`, JSON.stringify(oldChangedEntry));
    kv.set("cache:sourceMeta:index", JSON.stringify([stableEntry, oldChangedEntry]));
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/json"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const target = String(request);
      if (target === "https://example.com/new") {
        return new Response("Changed = trojan, changed.example.com, 443, password=p");
      }
      if (target === "https://example.com/added") {
        return new Response("Added = trojan, added.example.com, 443, password=p");
      }
      return new Response("unexpected source", { status: 500 });
    });

    const execution = makeExecutionContext();
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sources: [
          {
            id: "stable",
            name: "Stable",
            url: "https://example.com/stable",
            fetchUserAgent: "surge",
            enabled: true
          },
          {
            id: "changed",
            name: "Changed",
            url: "https://example.com/new",
            fetchUserAgent: "surge",
            enabled: true
          },
          {
            id: "added",
            name: "Added",
            url: "https://example.com/added",
            fetchUserAgent: "surge",
            enabled: true
          }
        ]
      })
    }), env, execution.ctx);
    await Promise.all(execution.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/new", expect.objectContaining({ headers: { "user-agent": "Surge iOS/3727" } }));
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/added", expect.objectContaining({ headers: { "user-agent": "Surge iOS/3727" } }));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "https://example.com/stable")).toBe(false);
    await expectEncryptedSourceCache(kv, stableKey, "Stable = trojan, stable.example.com, 443, password=p");
    expect(kv.has(oldChangedKey)).toBe(false);
    await expectEncryptedSourceCache(kv, changedKey, "Changed = trojan, changed.example.com, 443, password=p");
    await expectEncryptedSourceCache(kv, addedKey, "Added = trojan, added.example.com, 443, password=p");
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expectEncryptedSourceCache(kv, sourceKey, "previous-content");
  });

  it("keeps the previous source cache and notifies when refreshed content has no nodes", async () => {
    const kv = new Map<string, string>();
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const previousContent = "Proxy = trojan, proxy.example.com, 443, password=p";
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    kv.set(sourceKey, previousContent);
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
      .mockResolvedValueOnce(new Response("subscription temporarily unavailable"))
      .mockResolvedValueOnce(new Response("subscription temporarily unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

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
      sourceCache: { totalNodes: number; protocolCounts: Array<{ protocol: string; count: number }> };
      notification: { telegram: string; warnings: string[] };
    }>();

    expect(refreshResponse.status).toBe(200);
    expect(refreshed).toMatchObject({ refreshed: 0, failed: 1, cached: 1 });
    expect(refreshed.warnings[0]).toContain("No proxy nodes found in upstream subscription");
    expect(refreshed.failures).toEqual([{
      sourceId: "src1",
      sourceName: "Primary",
      reason: "No proxy nodes found in upstream subscription",
      usedCachedContent: true
    }]);
    expect(refreshed.sourceCache).toMatchObject({
      totalNodes: 1,
      protocolCounts: [{ protocol: "trojan", count: 1 }]
    });
    expect(refreshed.notification).toMatchObject({ telegram: "sent", warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expectEncryptedSourceCache(kv, sourceKey, previousContent);
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as { text?: string };
    expect(telegramBody.text).toContain("No proxy nodes found in upstream subscription");
    expect(telegramBody.text).toContain("处理：已沿用旧缓存");
    expect(telegramBody.text).toContain("协议节点：trojan 1，总计 1");
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
    await expectEncryptedSourceCache(kv, sourceKey, "Proxy = trojan, proxy.example.com, 443, password=p");
  });

  it("refreshes compiled rule sets only from the daily scheduled handler", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "daily-source",
          name: "Daily rules",
          url: "https://rules.example/daily.list",
          enabled: true,
          format: "surge-rule-set",
          order: 0
        }],
        outputs: [{
          name: "Daily",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["daily-source"],
          inlineRules: [],
          order: 0,
          surgeOptions: []
        }],
        directRules: []
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("DOMAIN-SUFFIX,daily.example"));

    await worker.scheduled?.({
      cron: "0 */12 * * *",
      scheduledTime: Date.now()
    } as ScheduledController, env, ctx);

    expect(fetchMock).not.toHaveBeenCalledWith("https://rules.example/daily.list");
    expect(kv.has("cache:compiledRuleSetMeta:daily-output")).toBe(false);

    await worker.scheduled?.({
      cron: "0 16 * * *",
      scheduledTime: Date.now()
    } as ScheduledController, env, ctx);

    expect(fetchMock).toHaveBeenCalledWith("https://rules.example/daily.list", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect([...kv.keys()].some((key) => key.startsWith("cache:compiledRuleSetMeta:Daily:v:"))).toBe(true);
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

  it("rewrites rule targets with commas inside parentheses using top-level rule fields", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        groups: { Proxy: "select, {all}" },
        surge: {
          rules: [
            "AND,((DOMAIN,example.com),(DOMAIN-SUFFIX,example.net)),Removed",
            "FINAL,Proxy"
          ]
        },
        clash: {
          rules: [
            "AND,((DOMAIN,example.com),(DOMAIN-SUFFIX,example.net)),Removed",
            "MATCH,Proxy"
          ]
        },
        stash: {
          rules: [
            "AND,((DOMAIN,example.com),(DOMAIN-SUFFIX,example.net)),Removed",
            "MATCH,Proxy"
          ]
        }
      })
    }), env, ctx);
    const body = await response.json<{
      surge: { rules: string[] };
      clash: { rules: string[] };
      stash: { rules: string[] };
    }>();

    expect(response.status).toBe(200);
    expect(body.surge.rules).toContain("AND,((DOMAIN,example.com),(DOMAIN-SUFFIX,example.net)),Proxy");
    expect(body.clash.rules).toContain("AND,((DOMAIN,example.com),(DOMAIN-SUFFIX,example.net)),Proxy");
    expect(body.stash.rules).toContain("AND,((DOMAIN,example.com),(DOMAIN-SUFFIX,example.net)),Proxy");
  });

  it("preserves configured Tailscale targets when policy groups are saved", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const session = await createSession(env);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        groups: { Proxy: "select, {all}" },
        surge: {
          tailscaleNodes: [{
            name: "Tailnet Exit",
            sectionName: "tailnet-exit",
            authKey: "tskey-auth-test",
            enabled: true
          }],
          rules: [
            "DOMAIN-SUFFIX,tailnet.example,Tailnet Exit",
            "FINAL,Proxy"
          ]
        },
        clash: {
          rules: [
            "DOMAIN-SUFFIX,tailnet.example,Tailnet Exit",
            "MATCH,Proxy"
          ]
        },
        stash: {
          rules: [
            "DOMAIN-SUFFIX,tailnet.example,Tailnet Exit",
            "MATCH,Proxy"
          ]
        },
        ruleSets: {
          outputs: [{
            name: "Tailnet Rules",
            enabled: true,
            policy: "Tailnet Exit",
            sourceIds: [],
            inlineRules: [],
            order: 0,
            surgeOptions: []
          }]
        }
      })
    }), env, ctx);
    const body = await response.json<{
      ruleSets: { outputs: Array<{ policy: string }> };
      surge: { rules: string[] };
      clash: { rules: string[] };
      stash: { rules: string[] };
    }>();

    expect(response.status).toBe(200);
    expect(body.ruleSets.outputs[0]?.policy).toBe("Tailnet Exit");
    expect(body.surge.rules).toContain("DOMAIN-SUFFIX,tailnet.example,Tailnet Exit");
    expect(body.clash.rules).toContain("DOMAIN-SUFFIX,tailnet.example,Proxy");
    expect(body.stash.rules).toContain("DOMAIN-SUFFIX,tailnet.example,Proxy");
  });
});
