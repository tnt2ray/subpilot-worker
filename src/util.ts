export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function textResponse(content: string, contentType = "text/plain; charset=utf-8", extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return new Response(content, {
    headers
  });
}

export function badRequest(message: string): Response {
  return jsonResponse({ error: message }, { status: 400 });
}

export function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, { status: 401 });
}

export function forbidden(message = "Forbidden"): Response {
  return jsonResponse({ error: message }, { status: 403 });
}

export function notFound(): Response {
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export const DEFAULT_DISPLAY_TIME_ZONE = "Asia/Shanghai";

const DISPLAY_TIME_ZONE_ALIASES = new Map<string, string>([
  ["aisa/shanghai", DEFAULT_DISPLAY_TIME_ZONE],
  ["asia/shanghai", DEFAULT_DISPLAY_TIME_ZONE],
  ["utc", "UTC"]
]);

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  const ab = new TextEncoder().encode(ha);
  const bb = new TextEncoder().encode(hb);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i += 1) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export function formatTimestampInTimeZone(value: string | null | undefined, timeZone: string | null | undefined): string {
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateInTimeZone(date, normalizeDisplayTimeZone(timeZone));
}

export function normalizeDisplayTimeZone(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const timeZone = DISPLAY_TIME_ZONE_ALIASES.get(raw.toLowerCase()) ?? raw;
  if (!timeZone) return DEFAULT_DISPLAY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return DEFAULT_DISPLAY_TIME_ZONE;
  }
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function parseCookie(request: Request): Map<string, string> {
  const output = new Map<string, string>();
  const header = request.headers.get("cookie");
  if (!header) return output;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    output.set(name, decodeURIComponent(rest.join("=")));
  }
  return output;
}

export function randomId(prefix = "item"): string {
  return `${prefix}_${randomToken(9)}`;
}
