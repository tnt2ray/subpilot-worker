import { applyV233Migration, previewV233Migration } from "./config-migration-store";
import { jsonResponse, readRequestJsonWithLimit, RequestBodyTooLargeError } from "./util";

const headers = { "cache-control": "no-store, private" };

/** Called only after administrator session authentication, before normal config loading. */
export async function handleV233Migration(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || (request.headers.has("origin") && request.headers.get("origin") !== url.origin)) {
    return jsonResponse({ error: "Use the current Worker's HTTPS origin for migration." }, { status: 403, headers });
  }
  try {
    if (request.method === "GET") return jsonResponse(await previewV233Migration(env), { headers });
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: { ...headers, allow: "GET, POST" } });
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return jsonResponse({ error: "Expected application/json" }, { status: 415, headers });
    }
    const body = await readRequestJsonWithLimit<{ revision?: unknown }>(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "revision")
      || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
      return jsonResponse({ error: "A migration preview revision is required." }, { status: 400, headers });
    }
    const result = await applyV233Migration(env, body.revision);
    return jsonResponse(result, { status: result.status === "blocked" ? 409 : 200, headers });
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 503;
    // KV and decrypted configuration errors can contain private data.
    return jsonResponse({ error: status === 503
      ? "Migration could not be completed. Preview again before retrying; original records are retained."
      : "Invalid migration request." }, { status, headers });
  }
}
