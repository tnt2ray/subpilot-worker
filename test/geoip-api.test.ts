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

});
