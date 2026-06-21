import { readStoredReadToken, readStoredReadTokenHash, storeReadToken } from "./config-store";
import { getSecret } from "./secrets";
import { base64Url, parseCookie, randomToken, sha256Hex, timingSafeEqualString } from "./util";

const SESSION_COOKIE = "subpilot_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function validateAdminToken(env: Env, token: string): Promise<boolean> {
  if (!token) return false;
  const adminTokenHash = getSecret(env, "ADMIN_TOKEN_HASH");
  return adminTokenHash ? timingSafeEqualString(await sha256Hex(token), adminTokenHash) : false;
}

export async function createSession(env: Env): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    version: 1,
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
    nonce: randomToken(18)
  })));
  return `${payload}.${await signSessionPayload(env, payload)}`;
}

export async function isAdminRequest(env: Env, request: Request): Promise<boolean> {
  const session = parseCookie(request).get(SESSION_COOKIE);
  if (!session) return false;
  const [payload, signature] = session.split(".");
  if (!payload || !signature) return false;
  if (!await timingSafeEqualString(await signSessionPayload(env, payload), signature)) return false;

  const data = parseSessionPayload(payload);
  return data !== null && data.expiresAt > Math.floor(Date.now() / 1000);
}

export function sessionCookie(token: string, secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${secureFlag}; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function validateReadToken(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  const storedHash = await readStoredReadTokenHash(env);
  if (storedHash && await timingSafeEqualString(await sha256Hex(token), storedHash)) return true;
  return false;
}

export async function getOrCreateReadToken(env: Env): Promise<string> {
  const storedToken = await readStoredReadToken(env);
  if (storedToken) return storedToken;

  const token = randomToken(32);
  await storeReadToken(env, token);
  return token;
}

export async function rotateReadToken(env: Env): Promise<string> {
  const token = randomToken(32);
  await storeReadToken(env, token);
  return token;
}

async function signSessionPayload(env: Env, payload: string): Promise<string> {
  const secret = await sessionSigningSecret(env);
  if (!secret) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

async function sessionSigningSecret(env: Env): Promise<string | undefined> {
  const adminTokenHash = getSecret(env, "ADMIN_TOKEN_HASH");
  if (adminTokenHash) return `hash:${adminTokenHash}`;
  return undefined;
}

function parseSessionPayload(payload: string): { expiresAt: number } | null {
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded)) as { expiresAt?: unknown };
    return typeof decoded.expiresAt === "number" ? { expiresAt: decoded.expiresAt } : null;
  } catch {
    return null;
  }
}
