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
      pending: [1, 2, 3]
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
  });

  it("rejects KV created by a newer unsupported Worker", async () => {
    const { env } = makeTestEnv(new Map([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION + 1)]]));

    await expect(runKvMigrations(env)).rejects.toThrow("newer than this Worker supports");
  });
});
