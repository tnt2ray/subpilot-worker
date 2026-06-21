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

describe("geoip lookup", () => {
  beforeEach(() => {
    resetGeoIpCountryReader();
    mmdb.constructorInputs.length = 0;
    mmdb.lookups.length = 0;
  });

  it("uses MMDB registered country records for IP region lookups", async () => {
    const kv = new Map<string, string | ArrayBuffer>([
      ["geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T00:00:00.000Z" })],
      ["geoip:mmdb:country", new ArrayBuffer(8)]
    ]);
    const env = makeEnv(kv);

    await expect(lookupIpRegion(env, "162.159.34.96")).resolves.toEqual({
      name: "US",
      labels: ["US"]
    });
    expect(JSON.parse(kv.get("cache:geoip:location:162.159.34.96") as string)).toMatchObject({
      countryCode: "US",
      source: "mmdb"
    });
    expect(kv.has("cache:geoip:local:162.159.34.96")).toBe(false);
    expect(mmdb.lookups).toContain("162.159.34.96");
    expect(mmdb.constructorInputs.length).toBeGreaterThan(0);
  });

  it("ignores stale unknown GeoIP location cache entries", async () => {
    const kv = new Map<string, string | ArrayBuffer>([
      ["geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T00:00:00.000Z" })],
      ["geoip:mmdb:country", new ArrayBuffer(8)],
      ["cache:geoip:location:162.159.34.96", JSON.stringify({ countryCode: "ZZ", source: "mmdb" })]
    ]);
    const env = makeEnv(kv);

    await expect(lookupIpLocation(env, "162.159.34.96")).resolves.toMatchObject({
      countryCode: "US",
      source: "mmdb"
    });
    expect(JSON.parse(kv.get("cache:geoip:location:162.159.34.96") as string).countryCode).toBe("US");
  });

  it("reloads the MMDB reader when the uploaded database version changes", async () => {
    const kv = new Map<string, string | ArrayBuffer>([
      ["geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T00:00:00.000Z" })],
      ["geoip:mmdb:country", new ArrayBuffer(8)]
    ]);
    const env = makeEnv(kv);

    await expect(lookupIpLocation(env, "162.159.34.96")).resolves.toMatchObject({ countryCode: "US" });
    expect(mmdb.constructorInputs).toHaveLength(1);

    kv.set("geoip:mmdb:country:meta", JSON.stringify({ updatedAt: "2026-06-21T01:00:00.000Z" }));
    kv.set("geoip:mmdb:country", new ArrayBuffer(16));
    kv.delete("cache:geoip:location:162.159.34.96");

    await expect(lookupIpLocation(env, "162.159.34.96")).resolves.toMatchObject({ countryCode: "US" });
    expect(mmdb.constructorInputs).toHaveLength(2);
  });
});
