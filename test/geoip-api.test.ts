import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createSession, sessionCookie } from "../src/auth";
import { restoreMocksAfterEach } from "./helpers/fetch";
import { ctx, makeEnv } from "./helpers/worker";

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

describe("geoip admin api", () => {
  it("uploads and reports the GeoIP MMDB for authenticated admins", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/octet-stream",
      "x-subpilot-file-name": encodeURIComponent("GeoLite2-Country.mmdb")
    };

    const uploadResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers,
      body: "MMDB-country-data"
    }), env, ctx);
    const uploaded = await uploadResponse.json<{ uploaded: boolean; fileName: string; size: number; updatedAt: string }>();

    expect(uploadResponse.status).toBe(200);
    expect(uploaded).toMatchObject({
      uploaded: true,
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });
    const meta = await env.SUBPILOT_CONFIG.get("geoip:mmdb:country:meta", "json") as {
      fileName: string;
      size: number;
      storageKey: string;
    };
    expect(meta).toMatchObject({
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });
    expect(meta.storageKey).toMatch(/^geoip:mmdb:country:data:/);
    await expect(env.SUBPILOT_CONFIG.get(meta.storageKey, "arrayBuffer")).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country", "arrayBuffer")).resolves.toBeNull();

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
    await expect(env.SUBPILOT_CONFIG.get(meta.storageKey, "arrayBuffer")).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(env.SUBPILOT_CONFIG.get("geoip:mmdb:country:meta", "json")).resolves.toMatchObject({
      fileName: "GeoLite2-Country.mmdb",
      size: "MMDB-country-data".length
    });
  });

  it("rejects GeoIP MMDB uploads without an admin session or valid MMDB content", async () => {
    const env = makeEnv();
    const unauthorizedResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "MMDB-country-data"
    }), env, ctx);

    expect(unauthorizedResponse.status).toBe(401);

    const session = await createSession(env);
    const invalidResponse = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/octet-stream",
        "x-subpilot-file-name": encodeURIComponent("bad.txt")
      },
      body: "not-mmdb"
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

  it("versions MMDB-backed location caches instead of deleting an unbounded cache prefix", async () => {
    const kv = new Map<string, string>();
    for (let index = 0; index < 1_100; index += 1) {
      kv.set(`cache:geoip:location:legacy:192.0.2.${index}`, JSON.stringify({ countryCode: "US", source: "mmdb" }));
    }
    const env = makeEnv(kv);
    const session = await createSession(env);
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete");

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/octet-stream"
      },
      body: "MMDB-country-data"
    }), env, ctx);

    expect(response.status).toBe(200);
    expect(deleteSpy.mock.calls.some(([key]) => String(key).startsWith("cache:geoip:location:"))).toBe(false);
    expect([...kv.keys()].filter((key) => key.startsWith("cache:geoip:location:"))).toHaveLength(1_100);
  });

});
