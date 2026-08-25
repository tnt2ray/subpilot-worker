import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createSession, sessionCookie } from "../src/auth";
import { ctx, makeEnv } from "./helpers/worker";

describe("request and response safety", () => {
  it("rejects declared and streamed oversized config JSON bodies", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = {
      cookie: sessionCookie(session, true),
      "content-type": "application/json"
    };
    const declared = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { ...headers, "content-length": String(2 * 1024 * 1024 + 1) },
      body: "{}"
    }), env, ctx);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        controller.close();
      }
    });
    const streamed = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PUT",
      headers,
      body: stream,
      duplex: "half"
    } as RequestInit & { duplex: "half" }), env, ctx);

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
    await expect(declared.json()).resolves.toEqual({ error: "Config request body is too large" });
    await expect(streamed.json()).resolves.toEqual({ error: "Config request body is too large" });
  });

  it("rate limits login attempts through the configured binding", async () => {
    const env = makeEnv() as Env & { LOGIN_RATE_LIMITER: RateLimit };
    const limit = vi.fn().mockResolvedValue({ success: false });
    env.LOGIN_RATE_LIMITER = { limit } as RateLimit;

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.10" },
      body: JSON.stringify({ token: "wrong" })
    }), env, ctx);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(limit).toHaveBeenCalledWith({ key: "admin-login:192.0.2.10" });
  });

  it("marks JSON responses containing admin data as private and non-cacheable", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };

    for (const path of ["/api/config", "/api/read-token", "/api/system/status"]) {
      const response = await worker.fetch(new Request(`https://subpilot.example.com${path}`, { headers }), env, ctx);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
    }
  });

  it("ignores malformed cookie encoding instead of returning an internal error", async () => {
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      headers: { cookie: "subpilot_session=%E0%A4%A" }
    }), makeEnv(), ctx);

    expect(response.status).toBe(401);
  });

  it("clears session cookies consistently for HTTP and HTTPS", async () => {
    const env = makeEnv();
    const http = await worker.fetch(new Request("http://localhost/api/logout", { method: "POST" }), env, ctx);
    const https = await worker.fetch(new Request("https://subpilot.example.com/api/logout", { method: "POST" }), env, ctx);

    expect(http.headers.get("set-cookie")).not.toContain("; Secure");
    expect(https.headers.get("set-cookie")).toContain("; Secure");
  });

  it("rejects an oversized MMDB binary body before buffering it", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/geoip/mmdb", {
      method: "POST",
      headers: {
        cookie: sessionCookie(session, true),
        "content-type": "application/octet-stream",
        "content-length": String(27 * 1024 * 1024)
      },
      body: "MMDB"
    }), env, ctx);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "MMDB upload body is too large" });
  });
});
