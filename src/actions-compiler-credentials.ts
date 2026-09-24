import { loadConfig } from "./config-store";
import { ruleCompilationMode } from "./rule-compilation-mode";
import { ACTIONS_CREDENTIALS_KEY, expireSupersededActionsRecord, readActionsIntegrationRecord } from "./actions-compiler-migration";
import { decryptJson, encryptJson } from "./crypto-store";
import { requireSecret } from "./secrets";
import { jsonResponse, randomToken, readRequestJsonWithLimit, RequestBodyTooLargeError } from "./util";

const headers = { "cache-control": "no-store, private" };
const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_]{20,255}$/.test(value);
const validSharedSecret = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);

interface ActionsCredentials {
  token: string;
  sharedSecret: string;
  storage: "kv" | "none";
}

/** Separate from configuration snapshots, exports and compiled-cache cleanup. */
export async function readActionsCredentials(env: Env): Promise<ActionsCredentials> {
  try {
    // Only an absent current record may inherit the previously saved credentials.
    // A current empty or unreadable record must never revive an old token.
    const stored = await readActionsIntegrationRecord(env, "credentials");
    if (stored !== null) {
      const value = await decryptJson<{ version?: unknown; token?: unknown; sharedSecret?: unknown }>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
      if (!value || value.version !== 1 || (value.token !== "" && !validToken(value.token))
        || (value.sharedSecret !== "" && !validSharedSecret(value.sharedSecret))) throw new Error("Invalid credentials");
      // An empty record deliberately prevents fallback after clearing credentials.
      return { token: value.token as string, sharedSecret: value.sharedSecret as string, storage: "kv" };
    }
    return { token: "", sharedSecret: "", storage: "none" };
  } catch {
    // Do not fall back or expose decrypted content when the record is unreadable.
    throw new Error("Actions 编译凭据暂时无法读取，请检查配置加密密钥和存储后重试。 / Actions compilation credentials are unavailable; check encryption and storage.");
  }
}

export function actionsCredentialStatus(credentials: ActionsCredentials) {
  return { dispatchTokenConfigured: Boolean(credentials.token), sharedSecretConfigured: Boolean(credentials.sharedSecret), storage: credentials.storage };
}

/** Called only behind the administrator authentication gate. Never returns values. */
export async function handleActionsCredentials(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method === "GET") return jsonResponse(actionsCredentialStatus(await readActionsCredentials(env)), { headers });
    if (!["PUT", "DELETE"].includes(request.method)) return jsonResponse({ error: "Method not allowed" }, { status: 405, headers });
    const url = new URL(request.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || (request.headers.has("origin") && request.headers.get("origin") !== url.origin)) {
      return jsonResponse({ error: "请从当前管理页面配置凭据。 / Use this application's admin page." }, { status: 403, headers });
    }
    let credentials: ActionsCredentials;
    if (request.method === "DELETE") {
      if (ruleCompilationMode(await loadConfig(env)) === "actions") return jsonResponse({ error: "请先切换为普通 Worker 或 WASM 并保存配置，再清除凭据。 / Switch to Worker or WASM and save settings before clearing credentials." }, { status: 409, headers });
      credentials = { token: "", sharedSecret: "", storage: "kv" };
    } else {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return jsonResponse({ error: "Expected application/json" }, { status: 415, headers });
      const body = await readRequestJsonWithLimit<{ token?: unknown }>(request, 2048);
      if (!body || !validToken(body.token)) return jsonResponse({ error: "请输入有效的 GitHub Token。 / Enter a valid GitHub token." }, { status: 400, headers });
      const previous = await readActionsCredentials(env);
      credentials = { token: body.token, sharedSecret: previous.sharedSecret || randomToken(32), storage: "kv" };
      delete body.token;
    }
    const encrypted = await encryptJson(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), { version: 1, token: credentials.token, sharedSecret: credentials.sharedSecret });
    await env.SUBPILOT_CONFIG.put(ACTIONS_CREDENTIALS_KEY, encrypted);
    await expireSupersededActionsRecord(env, "credentials", encrypted);
    return jsonResponse({ ok: true, ...actionsCredentialStatus(credentials) }, { headers });
  } catch (error) {
    if (error instanceof SyntaxError) return jsonResponse({ error: "请求内容不是有效的 JSON。 / Invalid JSON request." }, { status: 400, headers });
    return jsonResponse({ error: error instanceof RequestBodyTooLargeError ? "凭据请求过大。 / Credential request is too large." : "凭据操作未完成，请稍后重试。 / Could not complete the credential operation; retry shortly." }, { status: error instanceof RequestBodyTooLargeError ? 413 : 503, headers });
  }
}
