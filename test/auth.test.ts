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
  it("validates admin login only with ADMIN_TOKEN_HASH", async () => {
    const { env } = makeEnv();
    const legacyEnv = { ...env, ADMIN_TOKEN_HASH: "", ADMIN_TOKEN: "admin-token" } as unknown as Env;

    expect(await validateAdminToken(env, "admin-token")).toBe(true);
    expect(await validateAdminToken(legacyEnv, "admin-token")).toBe(false);
  });

  it("uses a signed cookie without writing sessions to KV", async () => {
    const { env, calls } = makeEnv();
    const session = await createSession(env);

    expect(calls.puts).toBe(0);
    expect(calls.gets).toBe(0);
    expect(await isAdminRequest(env, requestWithSession(session))).toBe(true);
    expect(calls.gets).toBe(0);
  });

  it("rejects tampered session cookies", async () => {
    const { env } = makeEnv();
    const session = await createSession(env);
    const tampered = `${session.slice(0, -1)}x`;

    expect(await isAdminRequest(env, requestWithSession(tampered))).toBe(false);
  });

  it("rejects expired session cookies", async () => {
    const { env } = makeEnv();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T00:00:00Z"));
    const session = await createSession(env);

    vi.setSystemTime(new Date("2026-06-25T00:00:00Z"));
    expect(await isAdminRequest(env, requestWithSession(session))).toBe(false);
    vi.useRealTimers();
  });
});

describe("read tokens", () => {
  it("creates one recoverable read token and keeps returning it", async () => {
    const { env, kv } = makeTokenEnv();

    const first = await getOrCreateReadToken(env);
    const second = await getOrCreateReadToken(env);

    expect(second).toBe(first);
    expect(kv.get("auth:read_token")).toBeTruthy();
    expect(kv.get("auth:read_token")).not.toBe(first);
    expect(kv.get("auth:read_token_hash")).toBeTruthy();
    expect(await validateReadToken(env, first)).toBe(true);
  });

  it("replaces the recoverable read token when rotating", async () => {
    const { env } = makeTokenEnv();

    const first = await getOrCreateReadToken(env);
    const rotated = await rotateReadToken(env);

    expect(rotated).not.toBe(first);
    expect(await getOrCreateReadToken(env)).toBe(rotated);
    expect(await validateReadToken(env, first)).toBe(false);
    expect(await validateReadToken(env, rotated)).toBe(true);
  });

  it("does not validate read tokens from the encrypted recoverable value alone", async () => {
    const { env, kv } = makeTokenEnv();

    const token = await getOrCreateReadToken(env);
    kv.delete("auth:read_token_hash");

    expect(kv.get("auth:read_token")).toBeTruthy();
    expect(await getOrCreateReadToken(env)).toBe(token);
    expect(await validateReadToken(env, token)).toBe(false);
  });

  it("does not accept the legacy READ_TOKEN secret as a subscription token", async () => {
    const { env } = makeTokenEnv();
    const legacyEnv = { ...env, READ_TOKEN: "legacy-read-token" } as unknown as Env;

    expect(await validateReadToken(legacyEnv, "legacy-read-token")).toBe(false);
  });

  it("requires CONFIG_ENCRYPTION_KEY before storing recoverable read tokens", async () => {
    const { env } = makeTokenEnv();
    const unconfiguredEnv = { ...env, CONFIG_ENCRYPTION_KEY: "" } as unknown as Env;

    await expect(rotateReadToken(unconfiguredEnv)).rejects.toThrow("CONFIG_ENCRYPTION_KEY secret is required");
  });
});
