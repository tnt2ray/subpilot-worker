import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEnv } from "./helpers/env";

const mmdb = vi.hoisted(() => ({
  constructorInputs: [] as unknown[],
  lookups: [] as string[]
}));

vi.mock("mmdb-lib", () => ({
  Reader: class {
    constructor(input: unknown) {
      mmdb.constructorInputs.push(input);
    }

    get(ip: string) {
      mmdb.lookups.push(ip);
      if (ip !== "162.159.34.96") return null;
      return {
        registered_country: {
          iso_code: "US",
          names: {
            en: "United States",
            "zh-CN": "美国"
          }
        }
      };
    }
  }
}));

import { lookupIpLocation, lookupIpRegion, resetGeoIpCountryReader } from "../src/geoip";

function makeEnv(kv = new Map<string, string | ArrayBuffer>()): Env {
  return makeTestEnv(kv).env;
}

function cachedLocation(kv: Map<string, string | ArrayBuffer>, ip: string): Record<string, unknown> {
  const entry = [...kv.entries()].filter(([key]) => key.startsWith("cache:geoip:location:") && key.endsWith(`:${ip}`)).at(-1);
  return JSON.parse(String(entry?.[1] ?? "{}")) as Record<string, unknown>;
}

describe("geoip lookup", () => {
  beforeEach(() => {
    resetGeoIpCountryReader();
    mmdb.constructorInputs.length = 0;
    mmdb.lookups.length = 0;
  });

  it("uses MMDB records, refreshes stale unknown cache entries, and reloads when the database changes", async () => {
    const kv = new Map<string, string | ArrayBuffer>([
      ["geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T00:00:00.000Z" })],
      ["geoip:mmdb:country", new ArrayBuffer(8)]
    ]);
    const env = makeEnv(kv);

    await expect(lookupIpRegion(env, "162.159.34.96")).resolves.toEqual({
      name: "US",
      labels: ["US"]
    });
    expect(cachedLocation(kv, "162.159.34.96")).toMatchObject({
      countryCode: "US",
      source: "mmdb"
    });
    expect(kv.has("cache:geoip:local:162.159.34.96")).toBe(false);
    expect(mmdb.lookups).toContain("162.159.34.96");
    expect(mmdb.constructorInputs.length).toBeGreaterThan(0);

    resetGeoIpCountryReader();
    mmdb.constructorInputs.length = 0;
    const staleKv = new Map<string, string | ArrayBuffer>([
      ["geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T00:00:00.000Z" })],
      ["geoip:mmdb:country", new ArrayBuffer(8)],
      ["cache:geoip:location:162.159.34.96", JSON.stringify({ countryCode: "ZZ", source: "mmdb" })]
    ]);
    const staleEnv = makeEnv(staleKv);

    await expect(lookupIpLocation(staleEnv, "162.159.34.96")).resolves.toMatchObject({
      countryCode: "US",
      source: "mmdb"
    });
    expect(cachedLocation(staleKv, "162.159.34.96").countryCode).toBe("US");
    expect(mmdb.constructorInputs).toHaveLength(1);

    staleKv.set("geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T01:00:00.000Z" }));
    staleKv.set("geoip:mmdb:country", new ArrayBuffer(16));
    staleKv.delete("cache:geoip:location:162.159.34.96");

    await expect(lookupIpLocation(staleEnv, "162.159.34.96")).resolves.toMatchObject({ countryCode: "US" });
    expect(mmdb.constructorInputs).toHaveLength(2);
  });

  it("does not share pending KV reads between concurrent requests", async () => {
    const kv = new Map<string, string | ArrayBuffer>([
      ["geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T00:00:00.000Z" })],
      ["geoip:mmdb:country", new ArrayBuffer(8)]
    ]);
    const env = makeEnv(kv);
    const namespace = env.SUBPILOT_CONFIG as unknown as {
      get: (key: string, type?: string) => Promise<unknown>;
    };
    const originalGet = namespace.get.bind(namespace);
    let releaseDataReads: (() => void) | undefined;
    const dataReadGate = new Promise<void>((resolve) => { releaseDataReads = resolve; });
    let dataReads = 0;
    vi.spyOn(namespace, "get").mockImplementation(async (key, type) => {
      if (key === "geoip:mmdb:country") {
        dataReads += 1;
        await dataReadGate;
      }
      return originalGet(key, type);
    });

    const first = lookupIpLocation(env, "162.159.34.96");
    const second = lookupIpLocation(env, "162.159.34.96");
    await vi.waitFor(() => expect(dataReads).toBe(2));
    releaseDataReads?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(dataReads).toBe(2);
  });
});
