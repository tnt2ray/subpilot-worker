import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_SCHEMA_VERSION_KEY, CURRENT_KV_SCHEMA_VERSION, ensureKvSchema, readKvSchemaStatus, runKvMigrations } from "../src/config-schema";
import { loadConfig } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { makeTestEnv } from "./helpers/env";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function enforceKvPutRateLimit(env: Env): void {
  const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
  const lastWrites = new Map<string, number>();
  vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
    const key = String(args[0]);
    const now = Date.now();
    const previous = lastWrites.get(key);
    if (previous !== undefined && now - previous < 1_000) throw new Error(`KV PUT rate limit for ${key}`);
    lastWrites.set(key, now);
    return originalPut(...args);
  });
}

describe("KV schema migrations", () => {
  it("initializes old KV stores, composes migrations, and runs automatically before loading config", async () => {
    const { env, kv } = makeTestEnv();

    await expect(readKvSchemaStatus(env)).resolves.toMatchObject({
      current: CURRENT_KV_SCHEMA_VERSION,
      stored: 0,
      migrated: false,
      pending: Array.from({ length: CURRENT_KV_SCHEMA_VERSION }, (_item, index) => index + 1)
    });

    await expect(ensureKvSchema(env)).resolves.toMatchObject({
      current: CURRENT_KV_SCHEMA_VERSION,
      stored: CURRENT_KV_SCHEMA_VERSION,
      migrated: true,
      pending: []
    });
    expect(kv.get(CONFIG_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_KV_SCHEMA_VERSION));
    expect(JSON.parse(String(kv.get("config:settings:displayTimeZone") ?? "null"))).toBe("Asia/Shanghai");
    expect(JSON.parse(String(kv.get("config:stash:port") ?? "null"))).toBe(DEFAULT_CONFIG.stash.port);
    expect(JSON.parse(String(kv.get("config:stash:mitm") ?? "null"))).toEqual(DEFAULT_CONFIG.stash.mitm);
    expect(JSON.parse(String(kv.get("config:ruleSets:mode") ?? "null"))).toBe("compiled");
    expect(JSON.parse(String(kv.get("config:ruleSets:aggregateByPolicy") ?? "null"))).toBe(false);
    expect([...kv.keys()].some((key) => key.startsWith("config:shadowrocket:"))).toBe(false);

    const { env: autoEnv, kv: autoKv } = makeTestEnv();
    await expect(loadConfig(autoEnv).then((config) => config.ruleSets)).resolves.toMatchObject({
      mode: "compiled",
      directRules: [{
        enabled: true,
        rule: "FINAL,Proxy",
        policy: "Proxy"
      }]
    });
    expect(autoKv.get(CONFIG_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_KV_SCHEMA_VERSION));

    const { env: legacyNoSchemaEnv, kv: legacyNoSchemaKv } = makeTestEnv(new Map([
      ["config:settings:userAgentSurge", JSON.stringify("Existing Surge")]
    ]));
    await runKvMigrations(legacyNoSchemaEnv);
    expect(JSON.parse(String(legacyNoSchemaKv.get("config:ruleSets:mode") ?? "null"))).toBe("manual");

    const { env: v1Env, kv: v1Kv } = makeTestEnv(new Map([[CONFIG_SCHEMA_VERSION_KEY, "1"]]));

    await expect(runKvMigrations(v1Env)).resolves.toMatchObject({
      current: CURRENT_KV_SCHEMA_VERSION,
      stored: CURRENT_KV_SCHEMA_VERSION,
      migrated: true,
      pending: []
    });

    expect(JSON.parse(String(v1Kv.get("config:settings:displayTimeZone") ?? "null"))).toBe("Asia/Shanghai");

    const { env: existingEnv, kv: existingKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "1"],
      ["config:settings:displayTimeZone", JSON.stringify("UTC")]
    ]));

    await runKvMigrations(existingEnv);

    expect(JSON.parse(String(existingKv.get("config:settings:displayTimeZone") ?? "null"))).toBe("UTC");

    const { env: stashEnv, kv: stashKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "2"],
      ["config:stash:port", JSON.stringify(9900)]
    ]));

    await runKvMigrations(stashEnv);

    expect(JSON.parse(String(stashKv.get("config:stash:port") ?? "null"))).toBe(9900);
    expect(JSON.parse(String(stashKv.get("config:stash:dns") ?? "null"))).toEqual(DEFAULT_CONFIG.stash.dns);

    const legacyExit = {
      protocol: "socks5",
      server: "203.0.113.1",
      port: 1080,
      username: "user",
      password: "secret"
    };
    const { env: proxyNodeEnv, kv: proxyNodeKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "3"],
      ["config:chain:exitProxy", JSON.stringify(legacyExit)],
      ["config:chain:filter", JSON.stringify(["AI", "US"])]
    ]));

    await runKvMigrations(proxyNodeEnv);

    expect(JSON.parse(String(proxyNodeKv.get("config:proxyNodes:index") ?? "[]"))).toEqual(["legacy-chain-exit"]);
    expect(JSON.parse(String(proxyNodeKv.get("config:proxyNodes:legacy-chain-exit") ?? "{}"))).toEqual({
      id: "legacy-chain-exit",
      config: "Chain Exit = socks5, 203.0.113.1, 1080, username=user, password=secret",
      chainFilter: ["AI", "US"],
      enabled: true,
      chainExit: true,
      includeInGroups: false
    });
    expect(proxyNodeKv.has("config:chain:exitProxy")).toBe(false);
    expect(proxyNodeKv.has("config:chain:filter")).toBe(false);

    const { env: tuicExitEnv, kv: tuicExitKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "3"],
      ["config:chain:exitProxy", JSON.stringify({
        protocol: "tuic",
        server: "tuic.example.com",
        port: 443,
        username: "user-id",
        password: "secret"
      })]
    ]));

    await runKvMigrations(tuicExitEnv);

    expect(JSON.parse(String(tuicExitKv.get("config:proxyNodes:legacy-chain-exit") ?? "{}"))).toMatchObject({
      config: "Chain Exit = tuic-v5, tuic.example.com, 443, uuid=user-id, password=secret",
      chainExit: true
    });

    const { env: v4ProxyNodeEnv, kv: v4ProxyNodeKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "4"],
      ["config:proxyNodes:index", JSON.stringify(["snell", "tuic"])],
      ["config:proxyNodes:snell", JSON.stringify({
        id: "snell",
        name: "Snell",
        protocol: "snell",
        server: "snell.example.com",
        port: 44046,
        password: "psk",
        enabled: true,
        chainExit: false
      })],
      ["config:proxyNodes:tuic", JSON.stringify({
        id: "tuic",
        name: "TUIC",
        protocol: "tuic",
        server: "tuic.example.com",
        port: 443,
        username: "user-id",
        password: "secret",
        enabled: true,
        chainExit: true
      })]
    ]));

    await runKvMigrations(v4ProxyNodeEnv);

    expect(JSON.parse(String(v4ProxyNodeKv.get("config:proxyNodes:snell") ?? "{}"))).toEqual({
      id: "snell",
      config: "Snell = snell, snell.example.com, 44046, psk=psk, version=4",
      chainFilter: [],
      enabled: true,
      chainExit: false,
      includeInGroups: true
    });
    expect(JSON.parse(String(v4ProxyNodeKv.get("config:proxyNodes:tuic") ?? "{}"))).toEqual({
      id: "tuic",
      config: "TUIC = tuic-v5, tuic.example.com, 443, uuid=user-id, password=secret",
      chainFilter: ["JP", "KR", "TW"],
      enabled: true,
      chainExit: true,
      includeInGroups: false
    });

    const { env: v5ProxyNodeEnv, kv: v5ProxyNodeKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "5"],
      ["config:chain:filter", JSON.stringify(["KR"])],
      ["config:proxyNodes:index", JSON.stringify(["exit", "plain"])],
      ["config:proxyNodes:exit", JSON.stringify({
        id: "exit",
        config: "Exit = socks5, 1.1.1.1, 1080",
        enabled: true,
        chainExit: true
      })],
      ["config:proxyNodes:plain", JSON.stringify({
        id: "plain",
        config: "Plain = socks5, 2.2.2.2, 1080",
        enabled: true,
        chainExit: false
      })]
    ]));

    await runKvMigrations(v5ProxyNodeEnv);

    expect(JSON.parse(String(v5ProxyNodeKv.get("config:proxyNodes:exit") ?? "{}"))).toEqual({
      id: "exit",
      config: "Exit = socks5, 1.1.1.1, 1080",
      chainFilter: ["KR"],
      enabled: true,
      chainExit: true,
      includeInGroups: false
    });
    expect(JSON.parse(String(v5ProxyNodeKv.get("config:proxyNodes:plain") ?? "{}"))).toEqual({
      id: "plain",
      config: "Plain = socks5, 2.2.2.2, 1080",
      chainFilter: [],
      enabled: true,
      chainExit: false,
      includeInGroups: true
    });
    expect(v5ProxyNodeKv.has("config:chain:filter")).toBe(false);

    const { env: v6GroupEnv, kv: v6GroupKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "6"],
      ["config:groups:index", JSON.stringify(["Proxy", "Auto", "Static", "Mixed"])],
      ["config:groups:Proxy", "select, Auto, {all exclude=Chain}"],
      ["config:groups:Auto", "url-test, {all exclude=Chain}, url=https://www.gstatic.com/generate_204, interval=600"],
      ["config:groups:Static", "url-test, {all filter=Chain exclude=Chain Exit}, url=https://www.gstatic.com/generate_204, interval=600"],
      ["config:groups:Mixed", "select, {all filter=Chain, JP exclude=Chain, US}"]
    ]));

    await runKvMigrations(v6GroupEnv);

    expect(v6GroupKv.get("config:groups:Proxy")).toBe("select, Auto, {all exclude=via}");
    expect(v6GroupKv.get("config:groups:Auto")).toBe("url-test, {all exclude=via}, url=https://www.gstatic.com/generate_204, interval=600");
    expect(v6GroupKv.get("config:groups:Static")).toBe("url-test, {all filter=via}, url=https://www.gstatic.com/generate_204, interval=600");
    expect(v6GroupKv.get("config:groups:Mixed")).toBe("select, {all filter=via, JP exclude=via, US}");

    const { env: v7GroupEnv, kv: v7GroupKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "7"],
      ["config:groups:index", JSON.stringify(["Proxy", "Static", "Mixed"])],
      ["config:groups:Proxy", "select, {all exclude=Chain Exit}"],
      ["config:groups:Static", "url-test, {all filter=--> exclude=Chain Exit}, url=https://www.gstatic.com/generate_204, interval=600"],
      ["config:groups:Mixed", "select, {all filter=-->, JP exclude=Chain Exit, US}"]
    ]));

    await runKvMigrations(v7GroupEnv);

    expect(v7GroupKv.get("config:groups:Proxy")).toBe("select, {all exclude=Chain Exit}");
    expect(v7GroupKv.get("config:groups:Static")).toBe("url-test, {all filter=via}, url=https://www.gstatic.com/generate_204, interval=600");
    expect(v7GroupKv.get("config:groups:Mixed")).toBe("select, {all filter=via, JP exclude=US}");

    const { env: v8ProxyNodeEnv, kv: v8ProxyNodeKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "8"],
      ["config:groups:index", JSON.stringify(["Proxy", "Static"])],
      ["config:groups:Proxy", "select, Auto, {all exclude=-->}"],
      ["config:groups:Static", "url-test, {all filter=--> exclude=Chain Exit}, url=https://www.gstatic.com/generate_204, interval=600"],
      ["config:proxyNodes:index", JSON.stringify(["exit", "shared", "plain"])],
      ["config:proxyNodes:exit", JSON.stringify({
        id: "exit",
        config: "Exit = socks5, 1.1.1.1, 1080",
        chainFilter: ["JP"],
        enabled: true,
        chainExit: true
      })],
      ["config:proxyNodes:shared", JSON.stringify({
        id: "shared",
        config: "Shared = socks5, 2.2.2.2, 1080",
        chainFilter: ["JP"],
        enabled: true,
        chainExit: true,
        includeInGroups: true
      })],
      ["config:proxyNodes:plain", JSON.stringify({
        id: "plain",
        config: "Plain = socks5, 3.3.3.3, 1080",
        chainFilter: [],
        enabled: true,
        chainExit: false,
        includeInGroups: false
      })]
    ]));

    await runKvMigrations(v8ProxyNodeEnv);

    expect(v8ProxyNodeKv.get("config:groups:Proxy")).toBe("select, Auto, {all exclude=via}");
    expect(v8ProxyNodeKv.get("config:groups:Static")).toBe("url-test, {all filter=via}, url=https://www.gstatic.com/generate_204, interval=600");
    expect(JSON.parse(String(v8ProxyNodeKv.get("config:proxyNodes:exit") ?? "{}"))).toEqual({
      id: "exit",
      config: "Exit = socks5, 1.1.1.1, 1080",
      chainFilter: ["JP"],
      enabled: true,
      chainExit: true,
      includeInGroups: false
    });
    expect(JSON.parse(String(v8ProxyNodeKv.get("config:proxyNodes:shared") ?? "{}"))).toEqual({
      id: "shared",
      config: "Shared = socks5, 2.2.2.2, 1080",
      chainFilter: ["JP"],
      enabled: true,
      chainExit: true,
      includeInGroups: true
    });
    expect(JSON.parse(String(v8ProxyNodeKv.get("config:proxyNodes:plain") ?? "{}"))).toEqual({
      id: "plain",
      config: "Plain = socks5, 3.3.3.3, 1080",
      chainFilter: [],
      enabled: true,
      chainExit: false,
      includeInGroups: true
    });

    const cachedSourceEntry = {
      key: "cache:source:cached",
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    };
    const missingSourceEntry = {
      key: "cache:source:missing",
      fetchedAt: "2026-06-20T01:05:00.000Z",
      sourceId: "src2",
      sourceName: "Missing"
    };
    const { env: v9SourceCacheEnv, kv: v9SourceCacheKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "9"],
      ["cache:source:cached", "Proxy A = trojan, a.example.com, 443, password=p\nProxy B = trojan, b.example.com, 443, password=p"],
      ["cache:sourceMeta:cached", JSON.stringify(cachedSourceEntry)],
      ["cache:sourceMeta:missing", JSON.stringify(missingSourceEntry)],
      ["cache:sourceMeta:index", JSON.stringify([cachedSourceEntry, missingSourceEntry])]
    ]));

    await runKvMigrations(v9SourceCacheEnv);

    const migratedCachedSourceEntry = {
      ...cachedSourceEntry,
      contentAvailable: true,
      nodeCount: 2,
      protocolCounts: [{ protocol: "trojan", count: 2 }]
    };
    const migratedMissingSourceEntry = {
      ...missingSourceEntry,
      contentAvailable: false,
      nodeCount: 0,
      protocolCounts: []
    };
    expect(JSON.parse(String(v9SourceCacheKv.get("cache:sourceMeta:cached") ?? "{}"))).toEqual(migratedCachedSourceEntry);
    expect(JSON.parse(String(v9SourceCacheKv.get("cache:sourceMeta:missing") ?? "{}"))).toEqual(migratedMissingSourceEntry);
    expect(JSON.parse(String(v9SourceCacheKv.get("cache:sourceMeta:index") ?? "[]"))).toEqual([
      migratedCachedSourceEntry,
      migratedMissingSourceEntry
    ]);

    const { env: v10Env, kv: v10Kv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "10"],
      ["config:settings:userAgentStash", JSON.stringify("Existing Stash")]
    ]));

    await runKvMigrations(v10Env);

    expect(v10Kv.get(CONFIG_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_KV_SCHEMA_VERSION));
    expect(JSON.parse(String(v10Kv.get("config:settings:userAgentStash") ?? "null"))).toBe("Existing Stash");
    expect(JSON.parse(String(v10Kv.get("config:ruleSets:mode") ?? "null"))).toBe("manual");
    expect(JSON.parse(String(v10Kv.get("config:ruleSets:aggregateByPolicy") ?? "null"))).toBe(false);
    expect(JSON.parse(String(v10Kv.get("config:ruleSetSources:index") ?? "null"))).toEqual([]);
    expect(JSON.parse(String(v10Kv.get("config:ruleSetOutputs:index") ?? "null"))).toEqual([]);
    expect(JSON.parse(String(v10Kv.get("config:ruleSetDirectRules:index") ?? "null"))).toEqual([]);
  });

  it("rejects KV created by a newer unsupported Worker", async () => {
    const { env } = makeTestEnv(new Map([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION + 1)]]));

    await expect(runKvMigrations(env)).rejects.toThrow("newer than this Worker supports");
  });

  it("writes each key at most once while composing fresh, schema 3, and schema 6 migrations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));

    const fresh = makeTestEnv();
    enforceKvPutRateLimit(fresh.env);
    await expect(runKvMigrations(fresh.env)).resolves.toMatchObject({ stored: CURRENT_KV_SCHEMA_VERSION });

    const schema3 = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "3"],
      ["config:chain:exitProxy", JSON.stringify({
        protocol: "socks5",
        server: "203.0.113.1",
        port: 1080,
        username: "user",
        password: "secret"
      })],
      ["config:chain:filter", JSON.stringify(["AI", "US"])]
    ]));
    enforceKvPutRateLimit(schema3.env);
    await expect(runKvMigrations(schema3.env)).resolves.toMatchObject({ stored: CURRENT_KV_SCHEMA_VERSION });
    expect(JSON.parse(String(schema3.kv.get("config:proxyNodes:legacy-chain-exit")))).toMatchObject({
      chainFilter: ["AI", "US"],
      includeInGroups: false
    });

    const schema4 = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "4"],
      ["config:chain:filter", JSON.stringify(["KR"])],
      ["config:proxyNodes:index", JSON.stringify(["exit"])],
      ["config:proxyNodes:exit", JSON.stringify({
        id: "exit",
        config: "Exit = socks5, 203.0.113.2, 1080",
        enabled: true,
        chainExit: true
      })]
    ]));
    enforceKvPutRateLimit(schema4.env);
    await expect(runKvMigrations(schema4.env)).resolves.toMatchObject({ stored: CURRENT_KV_SCHEMA_VERSION });
    expect(JSON.parse(String(schema4.kv.get("config:proxyNodes:exit")))).toMatchObject({
      chainFilter: ["KR"],
      includeInGroups: false
    });

    const schema6 = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "6"],
      ["config:groups:index", JSON.stringify(["Static"])],
      ["config:groups:Static", "url-test, {all filter=Chain exclude=Chain Exit}, url=https://www.gstatic.com/generate_204, interval=600"]
    ]));
    enforceKvPutRateLimit(schema6.env);
    await expect(runKvMigrations(schema6.env)).resolves.toMatchObject({ stored: CURRENT_KV_SCHEMA_VERSION });
    expect(schema6.kv.get("config:groups:Static"))
      .toBe("url-test, {all filter=via}, url=https://www.gstatic.com/generate_204, interval=600");
  });
});
