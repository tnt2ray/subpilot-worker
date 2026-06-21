import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_VERSION_KEY, CURRENT_KV_SCHEMA_VERSION, ensureKvSchema, readKvSchemaStatus, runKvMigrations } from "../src/config-schema";
import { loadConfig } from "../src/config-store";
import { makeTestEnv } from "./helpers/env";

describe("KV schema migrations", () => {
  it("initializes old KV stores without a schema version", async () => {
    const { env, kv } = makeTestEnv();

    await expect(readKvSchemaStatus(env)).resolves.toMatchObject({
      current: CURRENT_KV_SCHEMA_VERSION,
      stored: 0,
      migrated: false,
      pending: [1]
    });

    await expect(ensureKvSchema(env)).resolves.toMatchObject({
      current: CURRENT_KV_SCHEMA_VERSION,
      stored: CURRENT_KV_SCHEMA_VERSION,
      migrated: true,
      pending: []
    });
    expect(kv.get(CONFIG_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_KV_SCHEMA_VERSION));
  });

  it("runs automatically before loading config", async () => {
    const { env, kv } = makeTestEnv();

    await loadConfig(env);

    expect(kv.get(CONFIG_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_KV_SCHEMA_VERSION));
  });

  it("rejects KV created by a newer unsupported Worker", async () => {
    const { env } = makeTestEnv(new Map([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION + 1)]]));

    await expect(runKvMigrations(env)).rejects.toThrow("newer than this Worker supports");
  });
});
