import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_VERSION_KEY, CURRENT_KV_SCHEMA_VERSION, ensureKvSchema, readKvSchemaStatus, runKvMigrations } from "../src/config-schema";
import { loadConfig } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { makeTestEnv } from "./helpers/env";

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

    const { env: autoEnv, kv: autoKv } = makeTestEnv();
    await loadConfig(autoEnv);
    expect(autoKv.get(CONFIG_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_KV_SCHEMA_VERSION));

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

    const { env: v4ProxyNodeEnv, kv: v4ProxyNodeKv } = makeTestEnv(new Map([
      [CONFIG_SCHEMA_VERSION_KEY, "4"],
      ["config:proxyNodes:index", JSON.stringify(["snell"])],
      ["config:proxyNodes:snell", JSON.stringify({
        id: "snell",
        name: "Snell",
        protocol: "snell",
        server: "snell.example.com",
        port: 44046,
        password: "psk",
        enabled: true,
        chainExit: false
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
  });

  it("rejects KV created by a newer unsupported Worker", async () => {
    const { env } = makeTestEnv(new Map([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION + 1)]]));

    await expect(runKvMigrations(env)).rejects.toThrow("newer than this Worker supports");
  });
});
