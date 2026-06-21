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
