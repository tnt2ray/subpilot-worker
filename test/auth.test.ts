import { describe, expect, it, vi } from "vitest";
import { clearSessionCookie, createSession, getOrCreateReadToken, isAdminRequest, rotateReadToken, sessionCookie, validateAdminToken, validateReadToken } from "../src/auth";
import { READ_TOKEN_INITIAL_RECORD_PREFIX, READ_TOKEN_MIGRATION_RECORD_PREFIX, READ_TOKEN_ROTATION_PREFIX } from "../src/config-store";
import { decryptText, encryptText } from "../src/crypto-store";
import { sha256Hex } from "../src/util";
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

function rejectRapidDuplicateWrites(env: Env, lastWrites = new Map<string, number>()) {
  const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
  return vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
    const key = String(args[0]);
    const now = Date.now();
    const previous = lastWrites.get(key);
    if (previous !== undefined && now - previous < 1_000) throw new Error(`KV PUT rate limit for ${key}`);
    lastWrites.set(key, now);
    return originalPut(...args);
  });
}

function keysWithPrefix(kv: ReadonlyMap<string, unknown>, prefix: string): string[] {
  return [...kv.keys()].filter((key) => key.startsWith(prefix)).sort();
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

  it("only marks session deletion cookies Secure on HTTPS", () => {
    expect(clearSessionCookie(false)).toBe("subpilot_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect(clearSessionCookie(true)).toBe("subpilot_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  });
});

describe("read tokens", () => {
  it("stores, rotates, and validates append-only encrypted token records", async () => {
    const { env, kv } = makeTokenEnv();

    const first = await getOrCreateReadToken(env);
    const second = await getOrCreateReadToken(env);

    expect(second).toBe(first);
    const initialKeys = keysWithPrefix(kv, READ_TOKEN_INITIAL_RECORD_PREFIX);
    expect(initialKeys).toHaveLength(1);
    const firstStored = String(kv.get(initialKeys[0]!));
    expect(firstStored).toMatch(/^v1\./);
    expect(firstStored).not.toContain(first);
    expect(kv.has("auth:read_token")).toBe(false);
    expect(kv.has("auth:read_token_hash")).toBe(false);
    const firstRecord = JSON.parse(await decryptText("config-secret", firstStored)) as {
      version: number;
      token: string;
      hash: string;
    };
    expect(firstRecord).toEqual({ version: 1, token: first, hash: await sha256Hex(first) });
    expect(await validateReadToken(env, first)).toBe(true);

    const rotated = await rotateReadToken(env);

    expect(rotated).not.toBe(first);
    expect(keysWithPrefix(kv, READ_TOKEN_ROTATION_PREFIX)).toHaveLength(1);
    expect(await getOrCreateReadToken(env)).toBe(rotated);
    expect(await validateReadToken(env, first)).toBe(false);
    expect(await validateReadToken(env, rotated)).toBe(true);

    const legacyEnv = { ...env, READ_TOKEN: "legacy-read-token" } as unknown as Env;
    expect(await validateReadToken(legacyEnv, "legacy-read-token")).toBe(false);
  });

  it("migrates a legacy mismatched two-key token using the authenticated recoverable token", async () => {
    const { env, kv } = makeTokenEnv();
    const recoverableToken = "recoverable-token-sentinel";
    const staleToken = "stale-token";
    kv.set("auth:read_token", await encryptText("config-secret", recoverableToken));
    kv.set("auth:read_token_hash", await sha256Hex(staleToken));

    await expect(getOrCreateReadToken(env)).resolves.toBe(recoverableToken);

    const migrationKeys = keysWithPrefix(kv, READ_TOKEN_MIGRATION_RECORD_PREFIX);
    expect(migrationKeys).toHaveLength(1);
    const stored = String(kv.get(migrationKeys[0]!));
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(recoverableToken);
    expect(await validateReadToken(env, recoverableToken)).toBe(true);
    expect(await validateReadToken(env, staleToken)).toBe(false);
  });

  it("keeps legacy hash-only validation until a new recoverable token can replace it", async () => {
    const { env, kv } = makeTokenEnv();
    const legacyToken = "legacy-hash-only-token";
    kv.set("auth:read_token_hash", await sha256Hex(legacyToken));

    expect(await validateReadToken(env, legacyToken)).toBe(true);
    const replacement = await getOrCreateReadToken(env);

    expect(replacement).not.toBe(legacyToken);
    expect(keysWithPrefix(kv, READ_TOKEN_MIGRATION_RECORD_PREFIX)).toHaveLength(1);
    expect(await validateReadToken(env, legacyToken)).toBe(false);
    expect(await validateReadToken(env, replacement)).toBe(true);
  });

  it("creates one logical first token with append-only keys under concurrent isolates and strict per-key write limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));
    const kv = new Map<string, string>();
    const firstEnv = makeTestEnv(kv).env;
    const secondEnv = makeTestEnv(kv).env;
    const lastWrites = new Map<string, number>();
    rejectRapidDuplicateWrites(firstEnv, lastWrites);
    rejectRapidDuplicateWrites(secondEnv, lastWrites);

    const tokens = await Promise.all(Array.from({ length: 12 }, (_item, index) => getOrCreateReadToken(index % 2 ? firstEnv : secondEnv)));

    expect(new Set(tokens).size).toBe(1);
    expect(keysWithPrefix(kv, READ_TOKEN_INITIAL_RECORD_PREFIX).length).toBeGreaterThan(0);
    expect(await validateReadToken(firstEnv, tokens[0]!)).toBe(true);
  });

  it("migrates one logical legacy token concurrently without same-record-key writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));
    const recoverableToken = "concurrent-legacy-token";
    const kv = new Map<string, string>([
      ["auth:read_token", await encryptText("config-secret", recoverableToken)],
      ["auth:read_token_hash", await sha256Hex("stale-token")]
    ]);
    const firstEnv = makeTestEnv(kv).env;
    const secondEnv = makeTestEnv(kv).env;
    const lastWrites = new Map<string, number>();
    rejectRapidDuplicateWrites(firstEnv, lastWrites);
    rejectRapidDuplicateWrites(secondEnv, lastWrites);

    const [first, second] = await Promise.all([
      getOrCreateReadToken(firstEnv),
      getOrCreateReadToken(secondEnv)
    ]);

    expect(first).toBe(second);
    expect(first).toBe(recoverableToken);
    expect(keysWithPrefix(kv, READ_TOKEN_MIGRATION_RECORD_PREFIX).length).toBeGreaterThan(0);
    expect(await validateReadToken(firstEnv, first)).toBe(true);
  });

  it("retries an uncertain append-only rotation idempotently within one slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));
    for (const commitBeforeFailure of [false, true]) {
      const { env, kv } = makeTokenEnv();
      const oldToken = await getOrCreateReadToken(env);
      const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
      let injected = false;
      const putSpy = vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
        if (!String(args[0]).startsWith(READ_TOKEN_ROTATION_PREFIX) || injected) return originalPut(...args);
        injected = true;
        if (commitBeforeFailure) await originalPut(...args);
        throw new Error("injected read-token put failure");
      });

      await expect(rotateReadToken(env)).rejects.toThrow("injected read-token put failure");
      putSpy.mockRestore();

      const retried = await rotateReadToken(env);
      expect(retried).not.toBe(oldToken);
      expect(await getOrCreateReadToken(env)).toBe(retried);
      expect(await validateReadToken(env, retried)).toBe(true);
      expect(keysWithPrefix(kv, READ_TOKEN_ROTATION_PREFIX).length).toBe(commitBeforeFailure ? 2 : 1);
    }
  });

  it("retries legacy cleanup from the latest rotation and keeps migrated records out of cleanup scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));
    const { env, kv } = makeTokenEnv();
    const legacyToken = "legacy-cleanup-token";
    kv.set("auth:read_token", await encryptText("config-secret", legacyToken));
    kv.set("auth:read_token_hash", await sha256Hex(legacyToken));

    await expect(getOrCreateReadToken(env)).resolves.toBe(legacyToken);
    const rotated = await rotateReadToken(env);
    expect(kv.has("auth:read_token")).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await expect(validateReadToken(env, rotated)).resolves.toBe(true);
    expect(kv.has("auth:read_token")).toBe(false);
    expect(kv.has("auth:read_token_hash")).toBe(false);
    expect(keysWithPrefix(kv, "auth:read_token_cleanup_complete:").length).toBeGreaterThan(0);

    const pendingCount = keysWithPrefix(kv, "auth:read_token_cleanup_pending:").length;
    await rotateReadToken(env);
    expect(keysWithPrefix(kv, "auth:read_token_cleanup_pending:")).toHaveLength(pendingCount);
  });

  it("fails closed on a corrupt authoritative token record and allows explicit rotation recovery", async () => {
    const { env, kv } = makeTokenEnv();
    const token = await getOrCreateReadToken(env);
    const initialKey = keysWithPrefix(kv, READ_TOKEN_INITIAL_RECORD_PREFIX).at(-1)!;
    kv.set(initialKey, "v1.invalid.record");

    await expect(validateReadToken(env, token)).resolves.toBe(false);
    await expect(getOrCreateReadToken(env)).rejects.toThrow("Encrypted read token record is invalid");
    const rotated = await rotateReadToken(env);
    await expect(validateReadToken(env, rotated)).resolves.toBe(true);
  });

  it("requires CONFIG_ENCRYPTION_KEY before storing recoverable read tokens", async () => {
    const { env } = makeTokenEnv();
    const unconfiguredEnv = { ...env, CONFIG_ENCRYPTION_KEY: "" } as unknown as Env;

    await expect(rotateReadToken(unconfiguredEnv)).rejects.toThrow("CONFIG_ENCRYPTION_KEY secret is required");
  });
});
