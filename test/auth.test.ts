import { describe, expect, it, vi } from "vitest";
import { createSession, getOrCreateReadToken, isAdminRequest, rotateReadToken, sessionCookie, validateAdminToken, validateReadToken } from "../src/auth";
import { makeTestEnv } from "./helpers/env";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

function makeEnv() {
  const { env, calls } = makeTestEnv();
  return { env, calls };
}

function requestWithSession(session: string): Request {
  return new Request("https://subpilot.example.com/api/session", {
    headers: {
      cookie: sessionCookie(session, true)
    }
  });
}

function makeTokenEnv() {
  const kv = new Map<string, string>();
  const env = makeTestEnv(kv).env;
  return { env, kv };
}

describe("admin sessions", () => {
  it("validates admin login with hashed tokens and stateless signed cookies", async () => {
    const { env } = makeEnv();
    const legacyEnv = { ...env, ADMIN_TOKEN_HASH: "", ADMIN_TOKEN: "admin-token" } as unknown as Env;

    expect(await validateAdminToken(env, "admin-token")).toBe(true);
    expect(await validateAdminToken(legacyEnv, "admin-token")).toBe(false);

    const { env: sessionEnv, calls } = makeEnv();
    const session = await createSession(sessionEnv);

    expect(calls.puts).toBe(0);
    expect(calls.gets).toBe(0);
    expect(await isAdminRequest(sessionEnv, requestWithSession(session))).toBe(true);
    expect(calls.gets).toBe(0);

    expect(await isAdminRequest(sessionEnv, requestWithSession(`${session.slice(0, -1)}x`))).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T00:00:00Z"));
    const expiringSession = await createSession(sessionEnv);

    vi.setSystemTime(new Date("2026-06-25T00:00:00Z"));
    expect(await isAdminRequest(sessionEnv, requestWithSession(expiringSession))).toBe(false);
    vi.useRealTimers();
  });
});

describe("read tokens", () => {
  it("stores, rotates, and validates recoverable read tokens by hash only", async () => {
    const { env, kv } = makeTokenEnv();

    const first = await getOrCreateReadToken(env);
    const second = await getOrCreateReadToken(env);

    expect(second).toBe(first);
    expect(kv.get("auth:read_token")).toBeTruthy();
    expect(kv.get("auth:read_token")).not.toBe(first);
    expect(kv.get("auth:read_token_hash")).toBeTruthy();
    expect(await validateReadToken(env, first)).toBe(true);

    const rotated = await rotateReadToken(env);

    expect(rotated).not.toBe(first);
    expect(await getOrCreateReadToken(env)).toBe(rotated);
    expect(await validateReadToken(env, first)).toBe(false);
    expect(await validateReadToken(env, rotated)).toBe(true);

    kv.delete("auth:read_token_hash");

    expect(kv.get("auth:read_token")).toBeTruthy();
    expect(await getOrCreateReadToken(env)).toBe(rotated);
    expect(await validateReadToken(env, rotated)).toBe(false);

    const legacyEnv = { ...env, READ_TOKEN: "legacy-read-token" } as unknown as Env;
    expect(await validateReadToken(legacyEnv, "legacy-read-token")).toBe(false);
  });

  it("requires CONFIG_ENCRYPTION_KEY before storing recoverable read tokens", async () => {
    const { env } = makeTokenEnv();
    const unconfiguredEnv = { ...env, CONFIG_ENCRYPTION_KEY: "" } as unknown as Env;

    await expect(rotateReadToken(unconfiguredEnv)).rejects.toThrow("CONFIG_ENCRYPTION_KEY secret is required");
  });
});
